"""機械の状態を一定間隔で定点観測し、診断ログへ残すバックグラウンド監視。

Responsibility: 定点観測ループの実行とログ出力のみ。Flaskには触れない。

これまでの校正プローブ（matcher.calibration_ms）は「リクエストの直後に1回だけ」
しか測れず、利用者が/api/matchを呼んだ瞬間の状態しか分からなかった。しかし実際に
「長時間の一括OCRの途中から遅くなった」という報告では、cpuBusy(CPU使用率%)が
0%のままなのに matchTemplate 1回が並列時でも2000〜6000msかかる（健全時は
250〜300ms）という、これまでの「他プロセスにCPUを奪われている」という説明では
つかない状態が観測された。CPU使用率(%)はコアが忙しいかどうかしか見ておらず、
サーマルスロットリング等でクロック周波数そのものが落ちている場合は反映されない。
これを後から追えるよう、既知コストの校正を一定間隔で測り続けてログに残す。
"""
from __future__ import annotations

import threading
import time

import matcher

INTERVAL_SEC = 15.0

_started = False
_lock = threading.Lock()


def _load_hint() -> str:
    """app.pyの同名関数と同じ内容（診断ログ用のCPU使用率・メモリ空き）。
    psutilは任意依存のため、無ければ黙って省略する。"""
    try:
        import psutil
    except ImportError:
        return ''
    try:
        return (f' cpuBusy={psutil.cpu_percent(interval=None):.0f}%'
                f' ramFree={psutil.virtual_memory().available / 1e9:.1f}GB')
    except Exception:  # noqa: BLE001 - 診断情報なので失敗しても監視ループは止めない
        return ''


def _loop() -> None:
    import applog
    while True:
        try:
            ms = matcher._measure_calibration()
            applog.log(f'[health] calibration={ms:.0f}ms{_load_hint()}')
        except Exception as e:  # noqa: BLE001 - 監視ループ自体は止めない
            applog.log(f'[health] 計測に失敗: {e}')
        time.sleep(INTERVAL_SEC)


def start() -> None:
    """バックグラウンドの定点観測を開始する（二重起動はしない）。"""
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name='health-monitor', daemon=True).start()
