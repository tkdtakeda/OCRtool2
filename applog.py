"""診断ログの直近履歴バッファ。

Responsibility: ログの出力とバッファ保持のみ。Flaskには触れない。

これまで各エンドポイントの [perf] ログは print() のみでターミナルにしか出ておらず、
速度や精度の問題を報告する側（利用者）はDevToolsとターミナルの両方を開いて該当行を
探し出す必要があった。この手間を無くすため、print() の内容をターミナル表示は維持した
まま直近N行だけメモリにも保持し、/api/diagnostics 経由でブラウザへまとめて返せる
ようにする。ディスクへは書かない（プロセスが起動している間だけの一時バッファ）。
"""
from __future__ import annotations

import threading
from collections import deque

_MAX_LINES = 300
_lock = threading.Lock()
_buf: deque[str] = deque(maxlen=_MAX_LINES)


def log(line: str) -> None:
    """これまで通りターミナルへ表示しつつ、直近ログとしても保持する。"""
    print(line)
    with _lock:
        _buf.append(line)


def recent(n: int = _MAX_LINES) -> list[str]:
    with _lock:
        return list(_buf)[-n:]
