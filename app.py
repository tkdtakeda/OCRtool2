"""Flask アプリ本体。ルーティングと静的配信、エラー整形のみを担当し、
実際の画像処理ロジックは matcher.py / processor_server.py / ocr_server.py に
委譲する（各モジュール冒頭コメントの通り、元のJSファイルと同じ役割分担）。

将来デスクトップアプリ化（pywebviewでの専用ウィンドウ表示）する際、
このモジュールをサブプロセスではなくバックグラウンドスレッドで動かせるよう
create_app() をアプリ起動（app.run）から分離してある。

エラー方針: リクエスト自体が解釈できた場合（JSONとして読め、必須フィールドが
揃っている）は常に HTTP 200 を返し、失敗は各レスポンスの "error" フィールドに
文字列で入れる。これは元のJS関数（matchAll以外は内部で例外を握りつぶし
{..., error} を返す設計）と同じ契約をHTTP越しでも保つためで、フロントエンド側の
fetchラッパーはエンドポイントごとに使い分ける（例: /api/rotate は失敗時に
ローカルでのコピーへフォールバックする、/api/match は呼び出し元へ例外を
投げ直す、等）。HTTP側で非2xxを返すのは、JSONとして解釈できない・必須項目が
無い等の輸送レベルの異常のみ。
"""
from __future__ import annotations

import os
import time

import cv2
from flask import Flask, jsonify, request, send_from_directory

import applog
import matcher
import ocr_server as ocr
import processor_server as processor
from imaging import data_url_to_rgba, rgba_to_data_url

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_CONTENT_LENGTH = 64 * 1024 * 1024  # 64MB（高DPI・複数アンカーのmatchでも十分な余裕）
_STATIC_EXTS = ('.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.json', '.webmanifest')


def _load_hint() -> str:
    """診断ログ用に、機械の混み具合（CPU使用率・メモリ空き）を分かる範囲で付ける。
    psutil は requirements に無い任意依存なので、入っていなければ黙って省略する。"""
    try:
        import psutil
    except ImportError:
        return ''
    try:
        return (f', cpuBusy={psutil.cpu_percent(interval=None):.0f}%'
                f', ramFree={psutil.virtual_memory().available / 1e9:.1f}GB')
    except Exception:  # noqa: BLE001 - 診断情報なので失敗しても本処理は止めない
        return ''


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH
    app.json.ensure_ascii = False  # レスポンス中の日本語をそのまま出す（デバッグしやすくするためだけで、動作に影響なし）

    # ── 静的フロントエンド配信 ──────────────────────────
    # これまでの file:// 前提（OpenCV.js用の複数ソースローダー等）を廃止し、
    # このFlaskサーバー自身がHTML/JS/CSSを配信する。「コマンドを1つ実行して
    # ブラウザで開く」に一本化するため。
    @app.get('/')
    def index():
        return send_from_directory(REPO_ROOT, 'index.html')

    @app.get('/<path:filename>')
    def static_files(filename: str):
        if not filename.endswith(_STATIC_EXTS):
            return jsonify({'error': 'not found'}), 404
        return send_from_directory(REPO_ROOT, filename)

    # ── ヘルスチェック（cv-ready/cv-error ゲートの置き換え） ──
    @app.get('/api/health')
    def api_health():
        info = ocr.health_info()
        return jsonify({
            'status': 'ok' if ocr.is_ready() else 'ocr_unavailable',
            'opencvVersion': cv2.__version__,
            'ocrEngine': info['ocrEngine'],
            'tesseractVersion': info['tesseractVersion'],
            'languages': info['languages'],
            'cpuCount': os.cpu_count(),
            'error': None if ocr.is_ready() else ocr.init_error(),
        })

    # ── 診断ログ（速度・精度の問題を報告する際、ブラウザ側の「診断情報をコピー」
    #    ボタンがサーバー側の直近ログを取りに来る）。applog.log() が呼ばれるたび
    #    バッファへ積まれているので、ここではそれを返すだけ。 ──
    @app.get('/api/diagnostics')
    def api_diagnostics():
        info = ocr.health_info()
        return jsonify({
            'serverLog': applog.recent(),
            'opencvVersion': cv2.__version__,
            'ocrEngine': info['ocrEngine'],
            'tesseractVersion': info['tesseractVersion'],
            'cpuCount': os.cpu_count(),
        })

    # ── 画像マッチング（MatcherEngine.matchAll 相当） ──────
    @app.post('/api/match')
    def api_match():
        t0 = time.perf_counter()
        try:
            body = request.get_json(force=True, silent=False) or {}
            full_rgba = data_url_to_rgba(body['image'])
            templates = [
                {'id': t['id'], 'rgba': data_url_to_rgba(t['image'])}
                for t in (body.get('templates') or [])
            ]
            angle_range = body.get('angleRange', 2)
            angle_step = body.get('angleStep', 1)
            scale_factors = body.get('scaleFactors') or [1]
            results = matcher.match_all(
                full_rgba, templates,
                angle_range=angle_range, angle_step=angle_step, scale_factors=scale_factors,
            )
            tpl_dims = [(t['rgba'].shape[1], t['rgba'].shape[0]) for t in templates]
            max_tpl = max((w * h, f'{w}x{h}') for w, h in tpl_dims)[1] if tpl_dims else '-'
            # コストが既知(健全なら50〜150ms)の校正を、実処理の直後＝同じ状況で1回測る。
            # これが一緒に遅ければ、遅さの原因はこのコードでも画像でもなく機械の状態
            # （他プロセスのCPU占有・メモリ逼迫など）だと確定できる。既定OFF。
            calib = matcher.calibration_ms()
            calib_txt = f', calibration={calib:.0f}ms' if calib is not None else ''
            applog.log(f'[perf] /api/match {(time.perf_counter() - t0) * 1000:.0f}ms '
                  f'(templates={len(templates)}, angleRange={angle_range}, angleStep={angle_step}, '
                  f'scales={len(scale_factors)}, image={full_rgba.shape[1]}x{full_rgba.shape[0]}, '
                  f'maxTemplate={max_tpl}, cpuCount={os.cpu_count()}, cvThreads={cv2.getNumThreads()}'
                  f'{calib_txt}{_load_hint()})')
            return jsonify({'results': results, 'error': None})
        except Exception as e:  # noqa: BLE001 - JS側は必ずerrorを見て例外化する
            applog.log(f'[perf] /api/match failed after {(time.perf_counter() - t0) * 1000:.0f}ms: {e}')
            return jsonify({'results': {}, 'error': str(e)})

    # ── 目印のページ内一意性チェック（登録時の診断） ──────
    @app.post('/api/anchor-uniqueness')
    def api_anchor_uniqueness():
        t0 = time.perf_counter()
        try:
            body = request.get_json(force=True, silent=False) or {}
            full_rgba = data_url_to_rgba(body['image'])
            templates = [
                {'id': t['id'], 'rgba': data_url_to_rgba(t['image'])}
                for t in (body.get('templates') or [])
            ]
            results = matcher.self_uniqueness(full_rgba, templates)
            applog.log(f'[perf] /api/anchor-uniqueness {(time.perf_counter() - t0) * 1000:.0f}ms '
                  f'(templates={len(templates)})')
            return jsonify({'results': results, 'error': None})
        except Exception as e:  # noqa: BLE001 - JS側は必ずerrorを見て例外化する
            applog.log(f'[perf] /api/anchor-uniqueness failed after {(time.perf_counter() - t0) * 1000:.0f}ms: {e}')
            return jsonify({'results': {}, 'error': str(e)})

    # ── 傾き補正（LineRemovalProcessor.rotateCanvas 相当） ──
    @app.post('/api/rotate')
    def api_rotate():
        t0 = time.perf_counter()
        try:
            body = request.get_json(force=True, silent=False) or {}
            rgba = data_url_to_rgba(body['image'])
            rotated = processor.rotate(rgba, float(body.get('angle', 0)))
            applog.log(f'[perf] /api/rotate {(time.perf_counter() - t0) * 1000:.0f}ms')
            return jsonify({'image': rgba_to_data_url(rotated), 'error': None})
        except Exception as e:  # noqa: BLE001 - JS側は失敗時ローカルコピーへフォールバック
            applog.log(f'[perf] /api/rotate failed after {(time.perf_counter() - t0) * 1000:.0f}ms: {e}')
            return jsonify({'image': None, 'error': str(e)})

    # ── 罫線除去（LineRemovalProcessor.process 相当） ──────
    @app.post('/api/line-removal')
    def api_line_removal():
        t0 = time.perf_counter()
        try:
            body = request.get_json(force=True, silent=False) or {}
            rgba = data_url_to_rgba(body['image'])
            mats = processor.process(rgba, body.get('params') or {})
            applog.log(f'[perf] /api/line-removal {(time.perf_counter() - t0) * 1000:.0f}ms '
                  f'(image={rgba.shape[1]}x{rgba.shape[0]})')
            return jsonify({'images': [rgba_to_data_url(m) for m in mats], 'error': None})
        except Exception as e:  # noqa: BLE001
            applog.log(f'[perf] /api/line-removal failed after {(time.perf_counter() - t0) * 1000:.0f}ms: {e}')
            return jsonify({'images': [], 'error': str(e)})

    # ── OCR（OcrProcessor.recognize 相当） ────────────────
    @app.post('/api/ocr')
    def api_ocr():
        t0 = time.perf_counter()
        try:
            body = request.get_json(force=True, silent=False) or {}
            rgba = data_url_to_rgba(body['image'])
            result = ocr.recognize(
                rgba,
                psm=body.get('psm', 3),
                lang=body.get('lang') or 'eng',
                whitelist=body.get('whitelist') or '',
            )
            applog.log(f'[perf] /api/ocr {(time.perf_counter() - t0) * 1000:.0f}ms')
            return jsonify(result)
        except Exception as e:  # noqa: BLE001 - ocr.recognize自体は例外を投げないが、
            # デコード失敗などここより手前の異常はここで拾う
            applog.log(f'[perf] /api/ocr failed after {(time.perf_counter() - t0) * 1000:.0f}ms: {e}')
            return jsonify({'fullText': '', 'words': [], 'symbols': [], 'lines': [],
                             'confidence': 0, 'error': str(e)})

    @app.errorhandler(413)
    def _too_large(_e):
        return jsonify({'error': '画像サイズが大きすぎます'}), 413

    @app.errorhandler(404)
    def _not_found(_e):
        return jsonify({'error': 'not found'}), 404

    return app
