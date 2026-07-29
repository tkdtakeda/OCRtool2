"""動作中コードのバージョン・変更履歴を git から取得する。

Responsibility: git log の実行と整形のみ。Flaskには触れない。

このアプリは細かい修正が頻繁に入るため、「今動いているコードは最新の修正を
含んでいるか」が利用者には分かりにくい（実際に、修正を適用したはずなのに
git pull を忘れていて古いコードのまま動いていた事例が何度もあった）。
サーバー起動時、画面のバージョン表示・変更履歴モーダルへ渡す情報をここで作る。
git が使えない環境（zip配布等）でも落ちないよう、取得失敗時は None／空を返す。
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent

# git log --format 用の区切り文字（コミットメッセージに現れない制御文字を使う）。
# US(0x1f)=フィールド区切り、RS(0x1e)=コミット区切り。
_FIELD = '\x1f'
_RECORD = '\x1e'


def _run_git(args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ['git', *args], cwd=REPO_ROOT, capture_output=True, text=True,
            timeout=5, check=True,
        )
        return result.stdout
    except Exception:  # noqa: BLE001 - gitが無い/失敗しても本体は動かし続ける
        return None


def current_commit() -> dict[str, Any]:
    """今動いているコードのコミット情報。available=False なら git が使えない環境。"""
    short_hash = _run_git(['rev-parse', '--short', 'HEAD'])
    date = _run_git(['log', '-1', '--format=%cI'])
    subject = _run_git(['log', '-1', '--format=%s'])
    branch = _run_git(['rev-parse', '--abbrev-ref', 'HEAD'])
    status = _run_git(['status', '--porcelain'])
    return {
        'available': short_hash is not None,
        'hash': (short_hash or '').strip() or None,
        'date': (date or '').strip() or None,
        'subject': (subject or '').strip() or None,
        'branch': (branch or '').strip() or None,
        # 未コミットの変更があるか（=リポジトリの内容と実際のファイルがずれている可能性）
        'dirty': bool((status or '').strip()) if status is not None else None,
    }


def recent_history(limit: int = 30) -> list[dict[str, Any]]:
    """直近のコミット履歴（新しい順）。本文（body）にはこれまでの修正の背景・
    実測結果を書いてきているため、変更履歴としてそのまま利用者に見せられる。"""
    fmt = f'%h{_FIELD}%cI{_FIELD}%s{_FIELD}%b{_RECORD}'
    raw = _run_git(['log', f'-{limit}', f'--format={fmt}'])
    if raw is None:
        return []
    out: list[dict[str, Any]] = []
    for rec in raw.split(_RECORD):
        rec = rec.strip('\n')
        if not rec:
            continue
        parts = rec.split(_FIELD)
        if len(parts) < 3:
            continue
        h, date, subject = parts[0], parts[1], parts[2]
        body = parts[3].strip() if len(parts) > 3 else ''
        out.append({'hash': h, 'date': date, 'subject': subject, 'body': body})
    return out
