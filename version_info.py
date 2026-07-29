"""動作中コードのバージョン・変更履歴を version_history.json から読み取る。

Responsibility: ファイルの読み取りと整形のみ。Flaskには触れない。

以前は git log/status を実行して取得していたが、このアプリは zip 展開など
git リポジトリの体裁を保たずに配布・利用されることもあり、その場合 git コマンドが
使えず常に「不明」表示になってしまう。ファイルベースにすれば配布形態に関わらず
確実に読める。

運用: 機能追加・不具合修正のたびに、このモジュールが読む version_history.json の
先頭に新しいエントリを1件追記する（コミットメッセージの要約をそのまま使えばよい）。
バージョン番号は「日付.その日の通し番号」形式（例: "2026-07-29.2"）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent
HISTORY_FILE = REPO_ROOT / 'version_history.json'


def _load_history() -> list[dict[str, Any]]:
    """新しい順のエントリ一覧。ファイルが無い／壊れている場合は空リスト
    （呼び出し側が「不明」表示にフォールバックできるよう、例外は投げない）。"""
    try:
        with open(HISTORY_FILE, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001 - バージョン表示は補助情報。読めなくても本体は動かす
        return []


def current_version() -> dict[str, Any]:
    """今のバージョン（履歴の先頭＝最新エントリ）。available=False なら
    version_history.json が読めなかったことを示す。"""
    history = _load_history()
    if not history:
        return {'available': False, 'version': None, 'date': None, 'summary': None}
    top = history[0]
    return {
        'available': True,
        'version': top.get('version'),
        'date': top.get('date'),
        'summary': top.get('summary'),
    }


def recent_history(limit: int = 30) -> list[dict[str, Any]]:
    return _load_history()[:limit]
