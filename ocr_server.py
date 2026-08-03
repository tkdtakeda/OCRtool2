"""ocr.js（OcrProcessor）の recognize() を移植。

tesserocr（Tesseractのネイティブ C++ API を直接叩く。文字単位の確信度が
取れ、常駐インスタンスを使い回せるため高速）を優先し、import や初期化に
失敗した場合のみ pytesseract（tesseractコマンドを都度呼び出す。コンパイル
不要でどの環境にも入りやすい）へ自動的にフォールバックする。

requirements.txt には pytesseract のみを必須として書き、tesserocr は任意の
追加インストールという扱いにする（tesserocrはCコンパイラ＋Tesseractの
開発ヘッダが必要で、必須にすると環境によっては requirements.txt の
インストール自体が失敗しうるため）。README参照。

Responsibility: OCR処理ロジックのみ。Flask には触れない。ocr.jsの契約と
同じく、例外は投げずに { ..., error: string } を返す。
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
from typing import Any

import numpy as np
from PIL import Image

import applog

_ENGINE: str | None = None       # 'tesserocr' | 'pytesseract' | None
_INIT_ERROR: str | None = None
_TESSDATA_DIR: str | None = None

# pytesseract経路でwhitelistを渡す一時ファイルの置き場所の候補（優先順）。
#   1. リポジトリ直下(.tmp/) … ユーザー名が非ASCIIな環境向け
#   2. OS既定の一時フォルダ  … リポジトリ自体を非ASCIIフォルダに置いている環境向け
# 「一箇所に決め打ち」できない。実機で、①ユーザー名はASCII("seiya-takeda")なのに
# ②リポジトリを日本語フォルダ("Desktop\OCRツール")に置いていた、という組み合わせが
# 確認された。この場合は候補2（OS一時フォルダ）が安全で、逆にユーザー名が日本語の
# 環境では候補1が安全になる。どちらが安全かは実行時にしか分からないため、両方を
# 順に試し、実際にASCII化できたものを採用する（_pick_ascii_whitelist_dir 参照）。
_TMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.tmp')

_tesserocr = None
_pytesseract = None

_tesserocr_lock = threading.Lock()
_tesserocr_api = None
_tesserocr_api_lang: str | None = None


def _candidate_tessdata_dirs() -> list[str]:
    dirs = []
    env = os.environ.get('TESSDATA_PREFIX')
    if env:
        dirs.append(env)
    dirs += [
        '/usr/share/tesseract-ocr/5/tessdata',
        '/usr/share/tesseract-ocr/4.00/tessdata',
        '/usr/share/tessdata',
        '/usr/local/share/tessdata',
        '/opt/homebrew/share/tessdata',
        r'C:\Program Files\Tesseract-OCR\tessdata',
        # conda-forge の tesseract パッケージは、実行中のPython自身(sys.prefix)が
        # 属する環境の中にtessdataを同梱する（TESSDATA_PREFIXを自動設定しない
        # ビルドがあるため、環境の場所から機械的に導ける候補として明示的に見る）。
        # Windows(conda-forge)は Library\share\tessdata、Linux/Macは
        # share\tessdata が定番の配置。
        os.path.join(sys.prefix, 'Library', 'share', 'tessdata'),
        os.path.join(sys.prefix, 'share', 'tessdata'),
    ]
    return dirs


def _find_tessdata_dir() -> str | None:
    for d in _candidate_tessdata_dirs():
        if d and os.path.isfile(os.path.join(d, 'eng.traineddata')):
            return d
    return None


def _init_engine() -> None:
    """起動時に一度だけ実行。importできるかだけでなく、実際に初期化できるかまで
    確認してから確定する（tessdataが見つからずimportは成功しても初期化は失敗する
    ケースがあるため）。"""
    global _ENGINE, _INIT_ERROR, _tesserocr, _pytesseract, _TESSDATA_DIR
    _TESSDATA_DIR = _find_tessdata_dir()

    try:
        import tesserocr as _t
        kwargs: dict[str, Any] = {'lang': 'eng'}
        if _TESSDATA_DIR:
            kwargs['path'] = _TESSDATA_DIR
        probe = _t.PyTessBaseAPI(**kwargs)
        probe.End()
        _tesserocr = _t
        _ENGINE = 'tesserocr'
        return
    except Exception as e:  # noqa: BLE001 - フォールバックのため意図的に広く捕捉
        _INIT_ERROR = f'tesserocr初期化失敗: {e}'

    try:
        import pytesseract as _p
        _p.get_tesseract_version()
        _pytesseract = _p
        _ENGINE = 'pytesseract'
        return
    except Exception as e:  # noqa: BLE001
        _INIT_ERROR = f'{_INIT_ERROR}; pytesseract初期化失敗: {e}'
        _ENGINE = None


_init_engine()


def is_ready() -> bool:
    return _ENGINE is not None


def init_error() -> str | None:
    return _INIT_ERROR


# ── tesserocr 経路 ──────────────────────────────────────────
def _get_tesserocr_api(lang: str):
    """Worker再利用の考え方をそのまま踏襲: 言語が変わった時だけ再初期化する。"""
    global _tesserocr_api, _tesserocr_api_lang
    kwargs: dict[str, Any] = {'lang': lang}
    if _TESSDATA_DIR:
        kwargs['path'] = _TESSDATA_DIR
    if _tesserocr_api is None:
        _tesserocr_api = _tesserocr.PyTessBaseAPI(**kwargs)
        _tesserocr_api_lang = lang
    elif _tesserocr_api_lang != lang:
        _tesserocr_api.Init(**kwargs)
        _tesserocr_api_lang = lang
    return _tesserocr_api


def _bbox_from_tuple(box) -> dict[str, int]:
    if not box:
        return {'x0': 0, 'y0': 0, 'x1': 0, 'y1': 0}
    x1, y1, x2, y2 = box
    return {'x0': int(x1), 'y0': int(y1), 'x1': int(x2), 'y1': int(y2)}


def _iterate_level(api, level) -> list[dict[str, Any]]:
    items = []
    it = api.GetIterator()
    if it is None:
        return items
    while True:
        try:
            text = it.GetUTF8Text(level)
        except RuntimeError:
            # 完全に空白の領域など、その位置に文字が一切無い場合はここで例外になる
            # （tesserocr自身の挙動）。「文字が無い」という正常な結果として扱う。
            text = None
        if text and text.strip():
            conf = it.Confidence(level)
            items.append({
                'text': text.strip(),
                'confidence': round(max(0.0, conf)),
                'bbox': _bbox_from_tuple(it.BoundingBox(level)),
            })
        if not it.Next(level):
            break
    return items


def _recognize_tesserocr(rgba: np.ndarray, psm: int, lang: str, whitelist: str,
                         char_boxes: bool = False) -> dict[str, Any]:
    pil_img = Image.fromarray(rgba).convert('RGB')
    with _tesserocr_lock:
        api = _get_tesserocr_api(lang)
        api.SetPageSegMode(int(psm))
        api.SetVariable('tessedit_char_whitelist', whitelist or '')
        api.SetImage(pil_img)
        api.Recognize()
        full_text = api.GetUTF8Text() or ''
        overall_conf = api.MeanTextConf()

        words = _iterate_level(api, _tesserocr.RIL.WORD)
        symbols_raw = _iterate_level(api, _tesserocr.RIL.SYMBOL)
        lines_raw = _iterate_level(api, _tesserocr.RIL.TEXTLINE)

    return {
        'fullText': full_text,
        'words': words,
        'symbols': [{'text': s['text'], 'confidence': s['confidence']} for s in symbols_raw],
        'lines': [{'text': l['text'], 'confidence': l['confidence']} for l in lines_raw],
        'confidence': int(overall_conf) if overall_conf is not None else 0,
        # tesserocr は文字単位の外接矩形を元から持っているので追加コストなしで返せる。
        'charBoxes': ([{'text': s['text'], 'confidence': s['confidence'], **s['bbox']}
                       for s in symbols_raw] if char_boxes else None),
        'error': None,
    }


# ── pytesseract 経路 ────────────────────────────────────────
def _to_ascii_safe_path(path: str) -> str:
    """Windowsの8.3短縮パス名（レガシー互換のため今も生成される、純ASCIIかつ
    空白なしの別名。例: "OCR ツール" → "OCRT~1"）に変換できれば変換する。
    ASCIIのみの判定ではなく、空白の有無も合わせて見る（_pytesseract_configの
    引用符問題を参照）ため、すでにASCIIでも空白を含むパスは変換を試みる。
    短縮パス名はボリューム側で無効化されている場合もあるため、取得できなければ
    元のパスをそのまま返す（Windows以外の環境も同様）。"""
    if sys.platform != 'win32' or _is_tesseract_argv_safe(path):
        return path
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        n = ctypes.windll.kernel32.GetShortPathNameW(path, buf, 260)  # type: ignore[attr-defined]
        if n and 0 < n <= 260 and buf.value:
            return buf.value
    except Exception:  # noqa: BLE001 - 変換できなければ元のパスにフォールバックするだけ
        pass
    return path


def _is_tesseract_argv_safe(path: str) -> bool:
    """pytesseractはWindows上でconfig文字列を shlex.split(config, posix=False) に
    通した後、その結果のリストをそのまま subprocess.Popen(引数リスト) へ渡す
    （シェルを経由しない）。posix=False モードは非ASCII文字を保持できても、
    空白を含む値は引用符で囲んでも空白の分断こそ防げるものの引用符の文字自体は
    トークンから取り除かれず残ってしまう（実機・sandbox双方のshlex.splitで確認
    済み）。つまりWindows経路で安全に渡せるパスの条件は「ASCIIのみ」かつ
    「空白を含まない」の両方であり、引用符での回避はできない。"""
    return path.isascii() and not any(c.isspace() for c in path)


def _pytesseract_config(psm: int, whitelist: str) -> tuple[str, str | None]:
    """whitelistは--psmと違い空白・カンマ・通貨記号を含みうる。pytesseractは
    configをshlex.splitするため、値をそのままコマンドライン文字列に混ぜると
    空白で分断されて壊れる。Tesseractのconfigファイル（1行『変数名 値』形式で
    改行までが値になり再分割されない）に書き出し、そのパスだけを渡すことで回避する。

    書き出し先は _TMP_DIR モジュールコメントの通り複数候補を順に試す。1回で
    「ASCIIかつ空白なし」の候補を採用し、残りは試さない（余計な一時ファイルを
    作らない）。最後の候補まで満たせなかった場合はそれをそのまま使う（動く
    可能性はゼロではないため）が、既存の警告ログでその旨を伝える。

    重要: このパスをTesseractへ渡す際、Windows経路（pytesseractの
    shlex.split(config, posix=False)）では引用符" "で囲んでも引用符の文字自体が
    トークンに残ってしまい、その名前のファイルは存在しないため設定が読めず
    whitelistが無視される（_is_tesseract_argv_safeのdocstring参照）。これまでの
    修正が「パスをASCII化する」ことに集中していた間もこの引用符バグは常に
    有効で、パスの中身に関わらずWindows上のwhitelist指定を毎回無効化していた
    可能性が高い。そのため引用符で囲むのは非Windows（posix=Trueで引用符が
    正しく解釈・除去される）に限定し、Windowsでは囲まない。"""
    config = f'--psm {int(psm)}'
    tmp_path = None
    if whitelist:
        content = f'tessedit_char_whitelist {whitelist}\n'
        candidates = [_TMP_DIR, tempfile.gettempdir()]
        safe_path = ''
        for i, cand_dir in enumerate(candidates):
            is_last = (i == len(candidates) - 1)
            try:
                os.makedirs(cand_dir, exist_ok=True)
                fd, path = tempfile.mkstemp(suffix='.txt', prefix='ocrtool_wl_', dir=cand_dir)
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write(content)
            except OSError:
                continue   # このディレクトリに書けない（権限等）→ 次の候補へ
            candidate_safe = _to_ascii_safe_path(path)
            tmp_path, safe_path = path, candidate_safe
            if _is_tesseract_argv_safe(candidate_safe) or is_last:
                break
            # まだ他に候補が残っており、まだ安全でない → ゴミを残さず次の候補へ
            try:
                os.remove(path)
            except OSError:
                pass
        # 診断用: 全候補を試しても非ASCII文字や空白が残る場合は、whitelistが
        # 効かない症状が再発しうることを示す手がかりとして警告する。
        if not _is_tesseract_argv_safe(safe_path):
            applog.log(f'[warn] whitelist設定ファイルのパスに非ASCII文字または空白が含まれています: {safe_path}'
                       f' （候補{len(candidates)}箇所とも短縮パス名への変換に失敗。'
                       f'環境によってはwhitelist制限が効かない原因になります）')
        if sys.platform == 'win32':
            config += f' {safe_path}'   # 引用符で囲むと逆に壊れる（上記docstring参照）
        else:
            config += f' "{safe_path}"'   # posix=Trueでは引用符が正しく解釈される
    return config, tmp_path


def _group_words_and_lines(data: dict[str, list]) -> tuple[list[dict], list[dict]]:
    words: list[dict[str, Any]] = []
    line_groups: dict[tuple, list[tuple[str, float]]] = {}
    line_order: list[tuple] = []
    n = len(data.get('text', []))
    for i in range(n):
        if data['level'][i] != 5:   # 5 = word（Tesseract TSVの階層）
            continue
        txt = (data['text'][i] or '')
        if not txt.strip():
            continue
        try:
            conf = max(0.0, float(data['conf'][i]))
        except (TypeError, ValueError):
            conf = 0.0
        words.append({
            'text': txt.strip(),
            'confidence': round(conf),
            'bbox': {
                'x0': int(data['left'][i]), 'y0': int(data['top'][i]),
                'x1': int(data['left'][i]) + int(data['width'][i]),
                'y1': int(data['top'][i]) + int(data['height'][i]),
            },
        })
        key = (data['block_num'][i], data['par_num'][i], data['line_num'][i])
        if key not in line_groups:
            line_groups[key] = []
            line_order.append(key)
        line_groups[key].append((txt.strip(), conf))

    lines = []
    for key in line_order:
        items = line_groups[key]
        confs = [c for _, c in items]
        lines.append({
            'text': ' '.join(t for t, _ in items),
            'confidence': round(sum(confs) / len(confs)) if confs else 0,
        })
    return words, lines


def _parse_box_output(text: str, img_h: int) -> list[dict[str, Any]]:
    """image_to_boxes の出力（1行 = "文字 left bottom right top page"）を、
    words/symbols と同じ左上原点の座標系へ直して返す。Tesseractのbox形式だけは
    左下原点（PDF等と同じ数学座標系）なので、y をここで反転させる。
    未認識を表す "~" 行や、桁数の足りない壊れた行は黙って捨てる。"""
    boxes: list[dict[str, Any]] = []
    for line in (text or '').splitlines():
        parts = line.split(' ')
        if len(parts) < 5 or parts[0] == '~':
            continue
        try:
            left, bottom, right, top = (int(parts[i]) for i in range(1, 5))
        except ValueError:
            continue
        boxes.append({
            'text': parts[0],
            'x0': left, 'x1': right,
            'y0': img_h - top, 'y1': img_h - bottom,
        })
    return boxes


def _recognize_pytesseract(rgba: np.ndarray, psm: int, lang: str, whitelist: str,
                           char_boxes: bool = False) -> dict[str, Any]:
    pil_img = Image.fromarray(rgba).convert('RGB')
    config, tmp_path = _pytesseract_config(psm, whitelist)
    box_text = None
    try:
        data = _pytesseract.image_to_data(pil_img, lang=lang, config=config,
                                           output_type=_pytesseract.Output.DICT)
        # 文字単位の外接矩形は image_to_data（TSV）には無く、別形式(box)でしか
        # 取得できない＝tesseractをもう一度起動する必要がある。呼び出し側が
        # 明示的に要求した時だけ実行し、通常の認識には余計なコストを掛けない。
        if char_boxes:
            box_text = _pytesseract.image_to_boxes(pil_img, lang=lang, config=config)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    words, lines = _group_words_and_lines(data)
    # TesseractのTSVには文字単位の粒度が無いため、単語の確信度をその文字全てへ
    # ブロードキャストして近似する（tesserocrが使えない環境向けのフォールバック）。
    symbols = [{'text': ch, 'confidence': w['confidence']} for w in words for ch in w['text']]
    confidence = round(sum(w['confidence'] for w in words) / len(words)) if words else 0

    return {
        'fullText': '\n'.join(l['text'] for l in lines),
        'words': words,
        'symbols': symbols,
        'lines': lines,
        'confidence': confidence,
        'charBoxes': _parse_box_output(box_text, rgba.shape[0]) if box_text is not None else None,
        'error': None,
    }


# ── 公開API ─────────────────────────────────────────────────
def recognize(rgba: np.ndarray, psm: int, lang: str, whitelist: str,
              char_boxes: bool = False) -> dict[str, Any]:
    """ocr.js の OcrProcessor.recognize と同じ契約：例外を投げず、失敗時は
    error にメッセージを入れて返す。

    char_boxes=True のときだけ、文字単位の外接矩形を charBoxes として返す
    （1文字が2つに分割されて読まれた等、文字種だけでは判別できない誤読の
    切り分けに使う）。pytesseract経路ではtesseractの再起動を伴うので、
    疑わしい欄に限って要求すること。"""
    empty = {'fullText': '', 'words': [], 'symbols': [], 'lines': [], 'confidence': 0,
             'charBoxes': None, 'error': None}
    if _ENGINE is None:
        empty['error'] = f'OCRエンジンを初期化できませんでした: {_INIT_ERROR or "不明なエラー"}'
        return empty
    try:
        fn = _recognize_tesserocr if _ENGINE == 'tesserocr' else _recognize_pytesseract
        return fn(rgba, psm, lang or 'eng', whitelist or '', char_boxes)
    except Exception as e:  # noqa: BLE001 - ocr.js同様、呼び出し側へは例外を伝播させない
        empty['error'] = str(e)
        return empty


def health_info() -> dict[str, Any]:
    languages: list[str] = []
    tesseract_version = None
    try:
        if _ENGINE == 'tesserocr':
            _, langs = (_tesserocr.get_languages(_TESSDATA_DIR) if _TESSDATA_DIR
                        else _tesserocr.get_languages())
            languages = sorted(l for l in langs if l != 'osd')
            tesseract_version = str(_tesserocr.tesseract_version()).splitlines()[0]
        elif _ENGINE == 'pytesseract':
            languages = sorted(l for l in _pytesseract.get_languages(config='') if l != 'osd')
            tesseract_version = str(_pytesseract.get_tesseract_version())
    except Exception:  # noqa: BLE001 - 診断情報なので失敗しても健康チェック自体は止めない
        pass
    # tesserocrが入っているのにpytesseractへフォールバックしている場合、なぜ使われて
    # いないのかが今まで診断ログのどこにも出ていなかった（_INIT_ERRORはOCR自体が
    # 全滅した時のエラー表示にしか使っていなかったため）。tesserocrを入れたはずなのに
    # 切り替わらない、という報告に対応する際、毎回「pythonで直接importして再現して
    # ください」と頼む必要が無いよう、フォールバック時は理由をそのまま出す。
    tesserocr_note = _INIT_ERROR if (_ENGINE == 'pytesseract' and _INIT_ERROR) else None
    return {
        'ocrEngine': _ENGINE, 'tesseractVersion': tesseract_version, 'languages': languages,
        'tesserocrUnavailableReason': tesserocr_note,
    }
