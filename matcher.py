"""matcher_engine.js の matchAll を 1:1 で移植（OpenCV.js → ネイティブ cv2）。

Responsibility: テンプレートマッチング処理のみ。Flask には触れない。
アルゴリズム（角度×スケールの全探索 + コントラストに基づく信頼性減衰）は
元のJS実装と完全に同じ定数・同じ手順で行う。これは意図的：voting.js の
採用しきい値（acceptFloor/acceptConf/nearExact/marginMin）はこのスコア分布に
対して調整されているため、ここでスコアの出方が変われば帳票判定の挙動が
変わってしまう。
"""
from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np

from imaging import js_round

STD_LO = 6.0
STD_HI = 18.0
STD_PENALTY_FLOOR = 0.25
MAX_WORKING_DIM = 1800


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
    if tpl_gray.shape[0] > full_gray.shape[0] or tpl_gray.shape[1] > full_gray.shape[1]:
        return 0.0, (0, 0)
    res = cv2.matchTemplate(full_gray, tpl_gray, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    x, y = max_loc
    roi = full_gray[y:y + tpl_gray.shape[0], x:x + tpl_gray.shape[1]]
    window_std = _std_dev_of(roi)
    reliability = min(_std_ramp(tpl_std), _std_ramp(window_std))
    score = float(max_val) * (STD_PENALTY_FLOOR + (1 - STD_PENALTY_FLOOR) * reliability)
    return score, (int(x), int(y))


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
) -> dict[str, dict[str, Any]]:
    """
    templates: [{"id": str, "rgba": np.ndarray}, ...]
    戻り値: { id: {"score", "angle", "scale", "loc": {"x","y"}} }
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

    angles = _build_angles(angle_range, angle_step)

    for angle in angles:
        rotated = _rotate_gray(full_gray, angle)
        for f in scale_factors:
            scaled = rotated if abs(f - 1) < 1e-6 else _resize_gray(rotated, 1.0 / f)
            for tm in tpl_mats:
                score, (lx, ly) = _run_match(scaled, tm['mat'], tm['std'])
                cur = results[tm['id']]
                if score > cur['score']:
                    results[tm['id']] = {
                        'score': score,
                        'angle': angle,
                        'scale': f,
                        'loc': {
                            'x': js_round(lx * f / work_scale),
                            'y': js_round(ly * f / work_scale),
                        },
                    }

    # -inf は「テンプレートが1件も無い」場合以外は起きないが、念のため 0 に丸める
    for r in results.values():
        if not math.isfinite(r['score']):
            r['score'] = 0.0
    return results
