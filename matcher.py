"""matcher_engine.js の matchAll を 1:1 で移植（OpenCV.js → ネイティブ cv2）。

Responsibility: テンプレートマッチング処理のみ。Flask には触れない。
アルゴリズム（角度×スケールの全探索 + コントラストに基づく信頼性減衰）は
元のJS実装と完全に同じ定数・同じ手順で行う。これは意図的：voting.js の
採用しきい値（acceptFloor/acceptConf/nearExact/marginMin）はこのスコア分布に
対して調整されているため、ここでスコアの出方が変われば帳票判定の挙動が
変わってしまう。

cv2.matchTemplate(TM_CCOEFF_NORMED)は探索画像1枚あたり数十ms掛かりうる重い
呼び出しで、これを 角度×スケール×アンカー数 ぶん繰り返すため、アンカー数の
多い帳票では直列実行だと数秒〜数十秒に積み上がる（実測: 探索画像を
MAX_WORKING_DIMまで縮小した後でも1回あたり50〜80ms、90回で3.7秒）。
同じ(角度,スケール)内の各アンカーへの照合は完全に独立しているため、
ThreadPoolExecutorで並列化する（cv2の処理はGILを解放するため、Pythonの
スレッドでも実際にマルチコアが働く）。スコアの数値自体は並列化の有無で
一切変わらない（各アンカーの計算そのものは変更していないため）。

（検討メモ）粗密2段探索（画像を大きく縮小して大まかな位置を求め、その周辺だけ
元解像度で再探索する「ピラミッド探索」）も試したが、罫線グリッドや同系統の
文字が並ぶ帳票では類似した領域が複数箇所にでき、粗い段で本来と別の領域を
選んでしまい位置が大きく外れるケースが実測で確認された（60ケース中17件、
最大で1000px超のズレ）。精度を落としてまで採用する最適化ではないため見送り、
並列化のみを採用している。
"""
from __future__ import annotations

import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import cv2
import numpy as np

import applog
from imaging import js_round

# 並列化は下の ThreadPoolExecutor で (角度×スケール×アンカー) 単位に行う。その一方で
# OpenCV自身も matchTemplate 1回ごとに内部で全コアを使おうとするため、両者を放置すると
# 「プールのNスレッド × OpenCVの内部Mスレッド」が物理コアを奪い合う（オーバー
# サブスクリプション）。個々のmatchTemplateが既に全コアを埋めてしまうと、プールを
# 足しても実際には並列化されず（各コアが1呼び出しで飽和）、コンテキストスイッチと
# キャッシュ競合のぶんだけ純粋に遅くなる。対策として OpenCV の内部スレッドは切り
# (=各呼び出しは1コア)、並列度はプール側だけで作る。これが自前でOpenCV呼び出しを
# 並列化するときの定石。matchTemplateの数値結果はスレッド数に依らず不変なので、
# スコア＝帳票判定の挙動には一切影響しない。
# 効果は実測済み: 12コア機で speedup=11.7x（効率97%）と、並列化自体は理想的に働く。
cv2.setNumThreads(1)

STD_LO = 6.0
STD_HI = 18.0
STD_PENALTY_FLOOR = 0.25
MAX_WORKING_DIM = 1800
# プールの並列度上限。各 matchTemplate を1コアに固定した上で、コア数ぶんまで
# 同時実行する（min(cpu_count, ...) で実機のコア数に自動でクランプされる）。
# 環境変数 OCRTOOL_MATCH_WORKERS で上書きできる。用途は実機での当たり付け:
# スレッドを増やすほど速いとは限らず、各スレッドが確保する結果バッファ（画像サイズ×
# テンプレサイズごとに異なる）がメモリ帯域やヒープを奪い合うと、増やすほど遅くなる。
# 単一サイズを繰り返すベンチでは12並列が最速でも、サイズがばらつく本番では最適値が
# 下がることがあるため、サーバー再起動だけでA/Bできるようにしてある。
MAX_MATCH_WORKERS = 16
try:
    _env_workers = int(os.environ.get('OCRTOOL_MATCH_WORKERS', '') or 0)
    if _env_workers > 0:
        MAX_MATCH_WORKERS = _env_workers
except ValueError:
    pass

# 探索画像を「元より大きくしない」最適化のON/OFF（既定ON）。
# スケール f の探索は「テンプレ固定・探索画像を 1/f 倍」で行っていたが、f<1 では
# 探索画像が巨大化し、matchTemplateのコストが跳ね上がる（実測: f=0.546 で
# 1画像あたり646ms、f=1.0 の75msに対して8.6倍）。幾何的な対応関係は
# 「探索画像を1/f倍して原寸テンプレと照合」＝「探索画像は原寸のままテンプレをf倍に縮小」
# で同じなので、f<1 のときは後者に切り替える（f>=1 は元々探索画像が縮む側なので現行のまま）。
# 実測: スコア差は最大0.028、一致位置の差は最大6px、真の位置の当て方は同等以上
# （むしろ拡大補間によるボケが無い分ピーク値は上がる: 0.9565→0.9842）。
# 帳票判定(voting.js)の順位・採否が変わらないことを複数帳票の合成テストで確認済み。
# 万一この変更で判定挙動が変わった場合は OCRTOOL_MATCH_NO_UPSCALE=0 で即座に旧挙動へ戻せる。
NO_UPSCALE = os.environ.get('OCRTOOL_MATCH_NO_UPSCALE', '1') not in ('0', 'false', 'False')


# ── 校正プローブ（診断用・既定OFF） ────────────────────────
# コストが既知の基準測定。固定サイズの合成画像に対して matchTemplate を1回だけ実行し、
# 所要時間を返す。実リクエストの処理直後に測ると「同じ機械の・同じ瞬間の」健全値と
# 実測値を並べられるので、遅さの原因を切り分けられる:
#   校正も一緒に遅い → 機械が外的要因で遅い（他プロセスのCPU占有・メモリ逼迫など）
#   校正だけ速い     → 実データ側に固有の重さがある
# これで実際に「ブラウザが大量ページを処理中はサーバーがCPUを奪われ、matchTemplateが
# 70ms→2176msに膨らむ（校正も同時に遅くなる）」ことを確認できた。診断が済んだので
# 既定はOFF（1回あたり約70msの純粋な計測コストが乗るため）。再診断したいときは
# 環境変数 OCRTOOL_CALIBRATION=1 を付けてサーバーを起動する。
# 画像は一度だけ作って使い回す（測定のたびに確保すると、確保自体の時間が混ざるため）。
CALIBRATION_ENABLED = os.environ.get('OCRTOOL_CALIBRATION', '') not in ('', '0')
_CALIB_IMG: np.ndarray | None = None
_CALIB_TPL: np.ndarray | None = None


def _measure_calibration() -> float:
    """既知コストの matchTemplate を1回実行し、所要ミリ秒を返す（健全なら概ね50〜150ms）。
    OCRTOOL_CALIBRATION の設定に関わらず常に測る内部版。calibration_ms()（既存の
    オンデマンドAPI）と health_monitor.py（バックグラウンド定点観測）の両方から使う。"""
    global _CALIB_IMG, _CALIB_TPL
    if _CALIB_IMG is None:
        rng = np.random.default_rng(12345)
        _CALIB_IMG = rng.integers(0, 255, (1374, 1942), dtype=np.uint8)
        _CALIB_TPL = rng.integers(0, 255, (334, 636), dtype=np.uint8)
    t0 = time.perf_counter()
    res = cv2.matchTemplate(_CALIB_IMG, _CALIB_TPL, cv2.TM_CCOEFF_NORMED)
    cv2.minMaxLoc(res)
    return (time.perf_counter() - t0) * 1000


def calibration_ms() -> float | None:
    """既知コストの校正を1回実行し、所要ミリ秒を返す。OCRTOOL_CALIBRATION が
    未設定なら計測せず None を返す（/api/match 等、頻繁に呼ばれる経路からの
    オンデマンド呼び出し用。常時測りたい場合は health_monitor.py を使う）。"""
    return _measure_calibration() if CALIBRATION_ENABLED else None


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def _std_ramp(v: float) -> float:
    return _clamp01((v - STD_LO) / (STD_HI - STD_LO))


def _to_gray(rgba: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgba, cv2.COLOR_RGBA2GRAY)


def _rotate_gray(gray: np.ndarray, angle_deg: float) -> np.ndarray:
    if angle_deg == 0:
        return gray.copy()
    rows, cols = gray.shape[:2]
    center = (cols / 2.0, rows / 2.0)
    m = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    return cv2.warpAffine(
        gray, m, (cols, rows),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=255,
    )


def _resize_gray(gray: np.ndarray, factor: float) -> np.ndarray:
    rows, cols = gray.shape[:2]
    w = max(1, js_round(cols * factor))
    h = max(1, js_round(rows * factor))
    interp = cv2.INTER_AREA if factor < 1 else cv2.INTER_LINEAR
    return cv2.resize(gray, (w, h), interpolation=interp)


def _std_dev_of(gray: np.ndarray) -> float:
    _, std = cv2.meanStdDev(gray)
    return float(std[0][0])


def _run_match(full_gray: np.ndarray, tpl_gray: np.ndarray, tpl_std: float):
    """戻り値の3つ目は、この1回の照合の内訳時間(ms) (match, minmax, std, total)。
    並列区間の実測と比べた『実効の並列度』に加え、1回が重いときにどのOpenCV呼び出しが
    効いているのかを切り分けるための診断用（ベンチでは matchTemplate しか測っておらず、
    minMaxLoc と meanStdDev は本番にしか無い処理なので、ここを分けて見る必要がある）。"""
    t0 = time.perf_counter()
    if tpl_gray.shape[0] > full_gray.shape[0] or tpl_gray.shape[1] > full_gray.shape[1]:
        return 0.0, (0, 0), (0.0, 0.0, 0.0, (time.perf_counter() - t0) * 1000)
    res = cv2.matchTemplate(full_gray, tpl_gray, cv2.TM_CCOEFF_NORMED)
    t1 = time.perf_counter()
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    t2 = time.perf_counter()
    x, y = max_loc
    roi = full_gray[y:y + tpl_gray.shape[0], x:x + tpl_gray.shape[1]]
    window_std = _std_dev_of(roi)
    t3 = time.perf_counter()
    reliability = min(_std_ramp(tpl_std), _std_ramp(window_std))
    score = float(max_val) * (STD_PENALTY_FLOOR + (1 - STD_PENALTY_FLOOR) * reliability)
    return score, (int(x), int(y)), (
        (t1 - t0) * 1000,   # matchTemplate
        (t2 - t1) * 1000,   # minMaxLoc
        (t3 - t2) * 1000,   # meanStdDev（非連続ビューのROIに対して実行）
        (time.perf_counter() - t0) * 1000,
    )


def self_uniqueness(full_rgba: np.ndarray, templates: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """各テンプレートが「自分の基準画像の中で一意か」を測る。

    位置合わせ用の目印に必要なのは、他の帳票と違うことではなく、**同じページ内で
    紛らわしい相手がいない**こと。帳票は同じ形の枠・罫線交点が並ぶため、罫線と余白
    だけを切り取った目印は他の枠と数学的に区別が付かず、実運用で別の場所へ一致して
    位置合わせを壊す（倍率が片方の軸だけ潰れる等）。

    そこで基準画像に対してテンプレートを照合し、最良ピークと、その周辺を潰した上での
    次点ピークを求める。目印は基準画像から切り出したものなので最良ピークは自分の登録
    位置でほぼ満点になる。次点がそれに迫るほど「ページ内に双子がいる」＝危険。

    抑制半径はテンプレートの半分。同一ピークの裾を次点と数え違えない程度に狭く、かつ
    隣接するセル（表の隣の枠は現実によくある紛らわしい相手）は潰さない大きさにする。

    戻り値: { id: {"best", "bestLoc", "second", "secondLoc", "margin"} }
            スコアは match_all と同じ（コントラストによる信頼性減衰込み）で、実運用で
            どちらが勝つかをそのまま反映する。
    """
    full_gray = _to_gray(full_rgba)
    out: dict[str, dict[str, Any]] = {}
    for t in templates:
        tpl = _to_gray(t['rgba'])
        th, tw = tpl.shape[:2]
        if th > full_gray.shape[0] or tw > full_gray.shape[1]:
            out[t['id']] = {'best': 0.0, 'bestLoc': {'x': 0, 'y': 0},
                            'second': 0.0, 'secondLoc': {'x': 0, 'y': 0}, 'margin': 0.0}
            continue
        tpl_std = _std_dev_of(tpl)
        res = cv2.matchTemplate(full_gray, tpl, cv2.TM_CCOEFF_NORMED)

        def scored(loc: tuple[int, int], corr: float) -> float:
            x, y = loc
            window_std = _std_dev_of(full_gray[y:y + th, x:x + tw])
            reliability = min(_std_ramp(tpl_std), _std_ramp(window_std))
            return float(corr) * (STD_PENALTY_FLOOR + (1 - STD_PENALTY_FLOOR) * reliability)

        _, best_corr, _, best_loc = cv2.minMaxLoc(res)
        best = scored(best_loc, best_corr)

        # 最良ピークの周辺を潰してから次点を探す（同じピークの裾を拾わないため）
        rx, ry = max(1, tw // 2), max(1, th // 2)
        x0, y0 = max(0, best_loc[0] - rx), max(0, best_loc[1] - ry)
        x1, y1 = min(res.shape[1], best_loc[0] + rx + 1), min(res.shape[0], best_loc[1] + ry + 1)
        res[y0:y1, x0:x1] = -1.0
        _, second_corr, _, second_loc = cv2.minMaxLoc(res)
        second = scored(second_loc, second_corr)

        out[t['id']] = {
            'best': best,
            'bestLoc': {'x': int(best_loc[0]), 'y': int(best_loc[1])},
            'second': second,
            'secondLoc': {'x': int(second_loc[0]), 'y': int(second_loc[1])},
            'margin': best - second,
        }
    return out


def scan_scales(full_rgba: np.ndarray, templates: list[dict[str, Any]],
                 scale_factors: list[float]) -> dict[str, list[dict[str, Any]]]:
    """各テンプレートについて、指定した各スケールで基準画像内のどこかに強い一致が
    ないかを調べる（self_uniquenessとは別の、マルチスケール専用の補助関数）。

    背景: self_uniqueness は登録スケール(1.0)でしか基準画像内を照合しないため、
    「等倍では一意だが、他のスケールでは基準画像内の別の場所と酷似する」目印を
    見逃す。実際に、等倍チェックで「一意」と判定された目印が、単体だけでの
    実行時マッチングで77%スケールにて基準画像内の別の場所に高スコアで一致して
    しまい、位置合わせが大きく破綻した実例がある（複数の目印が絡んだ多数決の
    問題ではなく、1個の目印だけでも起きた）。

    一方、サンドボックスでの合成テストにより、縮小方向のスケールでは画像補間の
    影響で、紛らわしい相手が実在しないテンプレートでも弱い誤検知(corr≈0.5前後)
    が起こりうることも分かっている。閾値だけで「危険/安全」を自動判定すると、
    他の（問題ない）帳票にまで誤警告を広げる恐れがあるため、ここでは危険度の
    判定は一切行わず、各スケールでの最良一致（スコアと位置）という生の数値だけを
    返す。危険かどうかの最終判断は呼び出し側（UI経由で利用者）に委ねる。

    self_uniqueness と違い次点(second)は求めない（「このスケールで基準画像の
    どこかに強い一致があるか」だけが関心事で、次点の要否は等倍の一意性判定
    （既存のself_uniqueness）が別途担っているため）。

    戻り値: { id: [ {"scale","best","bestLoc"}, ... ] }  各テンプレートについて
            scale_factors の順（＝呼び出し側の並び）そのまま。
    """
    full_gray_orig = _to_gray(full_rgba)
    tpl_mats = []
    for t in templates:
        g = _to_gray(t['rgba'])
        tpl_mats.append({'id': t['id'], 'mat': g, 'std': _std_dev_of(g)})

    # スケールごとの探索画像を先に作る（match_all と同じ考え方。テンプレート固定・
    # 基準画像側を 1/f 倍することで、実際の認識(prepare)と同じ向きの探索にする）。
    prepared: list[tuple[float, np.ndarray]] = []
    for f in scale_factors:
        scaled = full_gray_orig if abs(f - 1) < 1e-6 else _resize_gray(full_gray_orig, 1.0 / f)
        prepared.append((f, scaled))

    def _one(f: float, full_gray: np.ndarray, tm: dict[str, Any]) -> dict[str, Any] | None:
        tpl, th, tw = tm['mat'], tm['mat'].shape[0], tm['mat'].shape[1]
        if th > full_gray.shape[0] or tw > full_gray.shape[1]:
            return None
        res = cv2.matchTemplate(full_gray, tpl, cv2.TM_CCOEFF_NORMED)
        _, corr, _, loc = cv2.minMaxLoc(res)
        x, y = loc
        window_std = _std_dev_of(full_gray[y:y + th, x:x + tw])
        reliability = min(_std_ramp(tm['std']), _std_ramp(window_std))
        score = float(corr) * (STD_PENALTY_FLOOR + (1 - STD_PENALTY_FLOOR) * reliability)
        return {'scale': f, 'best': score, 'bestLoc': {'x': js_round(x * f), 'y': js_round(y * f)}}

    n_jobs = len(prepared) * len(tpl_mats)
    n_workers = max(1, min(MAX_MATCH_WORKERS, n_jobs, os.cpu_count() or 4))
    out: dict[str, list[dict[str, Any]]] = {tm['id']: [] for tm in tpl_mats}
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        jobs = [(tm['id'], pool.submit(_one, f, full_gray, tm))
                for f, full_gray in prepared for tm in tpl_mats]
        for tid, fut in jobs:
            r = fut.result()
            if r:
                out[tid].append(r)
    for tid in out:
        out[tid].sort(key=lambda r: r['scale'])
    return out


def _build_angles(angle_range: float, angle_step: float) -> list[float]:
    if angle_range == 0 or angle_step == 0:
        return [0.0]
    angles = []
    a = -angle_range
    while a <= angle_range + 1e-9:
        angles.append(js_round(a * 1000) / 1000)
        a += angle_step
    return angles


def match_all(
    full_rgba: np.ndarray,
    templates: list[dict[str, Any]],
    angle_range: float = 2,
    angle_step: float = 1,
    scale_factors: list[float] | None = None,
    angles: list[float] | None = None,
) -> dict[str, dict[str, Any]]:
    """
    templates: [{"id": str, "rgba": np.ndarray}, ...]
    戻り値: { id: {"score", "angle", "scale", "loc": {"x","y"}} }

    angles を渡すと angle_range/angle_step から角度列を組み立てる代わりに、その
    角度だけを探索する。呼び出し側が角度探索を複数回に分割するために使う
    （本関数は全 角度×スケール の中の最大スコアを返すので、角度集合を分割して
    呼び出し、結果をスコアの大きい方で併合すれば、一度に全角度を探索したのと
    数学的に同じ結果になる。分割することで「まず0°だけ試し、確信が持てなければ
    残りの角度も調べる」という段階的な探索が、精度を落とさずに書ける）。
    """
    scale_factors = scale_factors if scale_factors else [1]
    angle_step = max(0.1, angle_step)

    results: dict[str, dict[str, Any]] = {
        t['id']: {'score': float('-inf'), 'angle': 0.0, 'scale': 1.0, 'loc': {'x': 0, 'y': 0}}
        for t in templates
    }

    tpl_mats = []
    for t in templates:
        g = _to_gray(t['rgba'])
        tpl_mats.append({'id': t['id'], 'mat': g, 'std': _std_dev_of(g)})

    full_gray_full = _to_gray(full_rgba)
    long_side = max(full_gray_full.shape[0], full_gray_full.shape[1])
    work_scale = (MAX_WORKING_DIM / long_side) if long_side > MAX_WORKING_DIM else 1.0
    full_gray = _resize_gray(full_gray_full, work_scale) if work_scale < 1 else full_gray_full

    angles = ([js_round(float(a) * 1000) / 1000 for a in angles]
              if angles else _build_angles(angle_range, angle_step))

    # 1) 角度×スケールぶんの探索画像を先に作る（rotate/resizeは1回数msと軽いので直列でよい）。
    #    scale_tpl=True の組では探索画像を拡大せず、代わりにテンプレ側をf倍に縮小する
    #    （NO_UPSCALE の説明を参照。幾何的な対応関係は同じで、コストだけが下がる）。
    prepared: list[tuple[float, float, np.ndarray, bool]] = []
    for angle in angles:
        rotated = _rotate_gray(full_gray, angle)
        for f in scale_factors:
            if NO_UPSCALE and f < 1.0:
                prepared.append((angle, f, rotated, True))
            else:
                scaled = rotated if abs(f - 1) < 1e-6 else _resize_gray(rotated, 1.0 / f)
                prepared.append((angle, f, scaled, False))

    # 縮小したテンプレは (テンプレ, f) ごとに1回だけ作って全角度で使い回す
    # （角度ごとに作り直すと、角度数ぶんだけ無駄なresize+meanStdDevが走る）。
    tpl_cache: dict[tuple[str, float], tuple[np.ndarray, float]] = {}

    def _tpl_for(tm: dict[str, Any], f: float, scale_tpl: bool) -> tuple[np.ndarray, float]:
        if not scale_tpl:
            return tm['mat'], tm['std']
        key = (tm['id'], f)
        hit = tpl_cache.get(key)
        if hit is None:
            small = _resize_gray(tm['mat'], f)
            hit = (small, _std_dev_of(small))
            tpl_cache[key] = hit
        return hit

    # 2) 重いのは cv2.matchTemplate 自体（探索画像1枚あたり数十ms）。
    #    (角度, スケール, アンカー) の組はすべて互いに独立しているため、フラットに
    #    まとめて並列実行する（角度/スケール単位で区切って並列化するより、
    #    アンカー数が少ない帳票でも常に並列度を確保できる）。
    n_workers = max(1, min(MAX_MATCH_WORKERS, len(prepared) * len(tpl_mats), os.cpu_count() or 4))
    par_t0 = time.perf_counter()
    serial_ms = 0.0
    sum_match = sum_minmax = sum_std = 0.0
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        jobs = []
        for angle, f, scaled, scale_tpl in prepared:
            for tm in tpl_mats:
                tpl_mat, tpl_std = _tpl_for(tm, f, scale_tpl)
                jobs.append((tm, angle, f, scale_tpl,
                             pool.submit(_run_match, scaled, tpl_mat, tpl_std)))
        for tm, angle, f, scale_tpl, fut in jobs:
            score, (lx, ly), (ms_match, ms_minmax, ms_std, call_ms) = fut.result()
            serial_ms += call_ms
            sum_match += ms_match
            sum_minmax += ms_minmax
            sum_std += ms_std
            cur = results[tm['id']]
            if score > cur['score']:
                # テンプレ縮小側は探索画像が原寸のままなので、座標に f を掛けてはいけない
                # （画像を1/f倍したぶんを戻す補正が不要なため）。
                back = (1.0 if scale_tpl else f) / work_scale
                results[tm['id']] = {
                    'score': score,
                    'angle': angle,
                    'scale': f,
                    'loc': {
                        'x': js_round(lx * back),
                        'y': js_round(ly * back),
                    },
                }
    # 実効の並列度を診断: 各照合の実時間合計(serial_ms)を並列区間の実測(par_wall)で割る。
    # ≈workers なら並列が効いている（1回が重いだけ→テンプレ/画像を小さくする方針）。
    # ≈1 なら並列が効いていない（GIL等で直列化→プロセス並列やcvThreads見直しが必要）。
    par_wall = (time.perf_counter() - par_t0) * 1000
    n_calls = max(1, len(prepared) * len(tpl_mats))
    applog.log(f'[perf]   match_all parallel: wall={par_wall:.0f}ms serialSum={serial_ms:.0f}ms '
          f'speedup={serial_ms / par_wall:.1f}x workers={n_workers} calls={len(prepared) * len(tpl_mats)} '
          f'avgCall={serial_ms / n_calls:.0f}ms '
          f'[match={sum_match / n_calls:.0f}ms minMaxLoc={sum_minmax / n_calls:.0f}ms '
          f'meanStdDev={sum_std / n_calls:.0f}ms]')

    # -inf は「テンプレートが1件も無い」場合以外は起きないが、念のため 0 に丸める
    for r in results.values():
        if not math.isfinite(r['score']):
            r['score'] = 0.0
    return results
