#!/usr/bin/env python3
"""matchTemplate 速度の切り分け診断。

本番ログで「並列は効いているのに1回の matchTemplate が2〜6秒」という異常が出た。
参考環境(cv2 5.0.0)では同じサイズが50〜100msなので、実機は20〜40倍遅い。原因を

  (A) OpenCVビルド/CPUが遅い（単発でも遅い）
  (B) 12並列でメモリ帯域を奪い合い、同時実行で各回が膨らむ

のどちらかに切り分ける。実機の Python（サーバーと同じ環境）で:

    python bench_match.py

を実行し、出力をそのまま貼ってほしい。
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np


def make(w: int, h: int) -> np.ndarray:
    return (np.random.rand(h, w) * 255).astype(np.uint8)


def one(img: np.ndarray, tpl: np.ndarray) -> float:
    t0 = time.perf_counter()
    res = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
    cv2.minMaxLoc(res)
    return (time.perf_counter() - t0) * 1000


def build_info_lines() -> None:
    """IPP・最適化・スレッドまわりだけ抜き出す（遅いビルドの特定用）。"""
    info = cv2.getBuildInformation()
    keys = ('Version control', 'IPP', 'Intel', 'Parallel', 'OpenCL',
            'CPU/HW features', 'SSE', 'AVX', 'NEON', 'Use IPP')
    print('--- OpenCV build info（抜粋） ---')
    for line in info.splitlines():
        s = line.strip()
        if any(k in s for k in keys) and s:
            print('  ', s)


def main() -> None:
    print('cv2', cv2.__version__, '/ numpy', np.__version__)
    print('cpu_count', __import__('os').cpu_count())
    build_info_lines()

    base_w, base_h = 1651, 1168          # 実機ログと同じ帳票サイズ
    tpl = make(636, 334)                 # 実機ログの maxTemplate と同じ

    # ── (A) 単発・シングルスレッド。ここが速ければビルドは正常 ──
    cv2.setNumThreads(1)
    print('\n=== 単発 / cvThreads=1（1コアだけ・並列なし） ===')
    for f in (0.85, 1.0, 1.15):          # classify の3倍率
        w, h = round(base_w / f), round(base_h / f)
        ms = min(one(make(w, h), tpl) for _ in range(3))   # 最速値=ノイズ除去
        print(f'  scale={f} img={w}x{h}  matchTemplate={ms:.0f}ms')
    w, h = round(base_w / 0.6), round(base_h / 0.6)         # coarse 最悪ケース
    print(f'  scale=0.6 img={w}x{h}  matchTemplate={min(one(make(w,h),tpl) for _ in range(3)):.0f}ms  (最重)')

    # ── (A') 単発だが OpenCV 内部並列を許可。単発が速くなるなら内部並列が有効 ──
    cv2.setNumThreads(0)                 # 0 = OpenCV が全コアを使う
    img = make(round(base_w / 0.85), round(base_h / 0.85))
    ms_multi = min(one(img, tpl) for _ in range(3))
    cv2.setNumThreads(1)
    ms_single = min(one(img, tpl) for _ in range(3))
    print(f'\n=== 単発・同一画像({img.shape[1]}x{img.shape[0]}) 内部並列の効果 ===')
    print(f'  cvThreads=1(1コア)={ms_single:.0f}ms   cvThreads=0(全コア)={ms_multi:.0f}ms')

    # ── (B) ワーカ数スイープ: classify相当の負荷を各並列度で回し、wall時間を比較 ──
    #    メモリ帯域律速だと、ワーカを増やしても wall が下がらない／逆に増える。
    #    最速の並列度が、その機械での MAX_MATCH_WORKERS の目安になる。
    cv2.setNumThreads(1)
    import os
    ncpu = os.cpu_count() or 12
    # classify相当: 3倍率(0.85,1.0,1.15) を各30回=90ジョブぶんの画像を用意
    scales = [0.85, 1.0, 1.15] * 30
    jobs = [make(round(base_w / f), round(base_h / f)) for f in scales]
    print(f'\n=== ワーカ数スイープ / cvThreads=1（{len(jobs)}回照合＝classify相当） ===')
    worker_grid = sorted({1, 2, 3, 4, 6, 8, ncpu})
    best = None
    for nw in worker_grid:
        if nw > ncpu:
            continue
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=nw) as pool:
            list(pool.map(lambda im: one(im, tpl), jobs))
        wall = (time.perf_counter() - t0) * 1000
        mark = ''
        if best is None or wall < best[1]:
            best = (nw, wall)
        print(f'  workers={nw:>2}  wall={wall:>7.0f}ms')
    print(f'\n▶ この機械での最速並列度: workers={best[0]}（wall={best[1]:.0f}ms）')
    print('  判定の目安:')
    print('  ・単発が既に1000ms超       → (A) ビルド/CPUが遅い（opencv入れ直しを検討）')
    print('  ・最速が workers=1〜4 付近  → (B) メモリ帯域競合。MAX_MATCH_WORKERS をそこへ下げる')
    print('  ・workers を増やすほど速い  → 素直にコア数まで使ってよい')


if __name__ == '__main__':
    main()
