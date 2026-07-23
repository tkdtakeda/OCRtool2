#!/usr/bin/env python3
"""帳票OCR統合ツール — 起動スクリプト。

使い方:
    python run_server.py             # 既定ポート(5001)で起動し、ブラウザを自動で開く
    python run_server.py --port 8080 # ポートを変更
    python run_server.py --no-browser

OCR/画像マッチングの実処理はすべてこのローカルサーバー（127.0.0.1のみ待受）で
行い、ブラウザ側（index.html）はそこへ処理を依頼するだけになった。将来
デスクトップアプリ化する際は、この create_app() 済みの Flask アプリを
pywebview から直接インポートしてバックグラウンドスレッドで動かせるように、
「起動チェック」と「app.run」をこのスクリプト側に閉じている。
"""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

DEFAULT_PORT = 5001


def main() -> int:
    parser = argparse.ArgumentParser(description='帳票OCR統合ツール ローカルサーバー')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'待受ポート（既定: {DEFAULT_PORT}）')
    parser.add_argument('--no-browser', action='store_true', help='起動時にブラウザを自動で開かない')
    args = parser.parse_args()

    try:
        from server import ocr
        from server.app import create_app
    except ImportError as e:
        print(f'[エラー] 必要なパッケージが見つかりません: {e}', file=sys.stderr)
        print('先に `pip install -r requirements.txt` を実行してください。', file=sys.stderr)
        return 1

    if not ocr.is_ready():
        print('[エラー] OCRエンジン（Tesseract）を初期化できませんでした。', file=sys.stderr)
        print(f'  詳細: {ocr.init_error()}', file=sys.stderr)
        print('  Tesseract OCR 本体がインストールされているか確認してください（README.md参照）。', file=sys.stderr)
        print('  - Windows: https://github.com/UB-Mannheim/tesseract/wiki のインストーラー', file=sys.stderr)
        print('  - macOS  : brew install tesseract tesseract-lang', file=sys.stderr)
        print('  - Linux  : apt install tesseract-ocr tesseract-ocr-jpn', file=sys.stderr)
        return 1

    info = ocr.health_info()
    print(f'OCRエンジン: {info["ocrEngine"]}（Tesseract {info["tesseractVersion"]}, 言語: {", ".join(info["languages"]) or "?"}）')

    app = create_app()
    url = f'http://127.0.0.1:{args.port}/'
    print(f'サーバーを起動しました: {url}')
    print('終了するには Ctrl+C を押してください。')

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    # bindは127.0.0.1のみ（帳票＝業務・金銭情報を扱いうるため、ローカル外には公開しない）。
    # debug=Falseは必須（デバッガが有効だとエラーページ経由で任意コード実行を許してしまう）。
    app.run(host='127.0.0.1', port=args.port, debug=False, threaded=True, use_reloader=False)
    return 0


if __name__ == '__main__':
    sys.exit(main())
