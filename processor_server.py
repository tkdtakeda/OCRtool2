"""processor.js（LineRemovalProcessor）の process()/rotateCanvas() を移植。

Responsibility: 罫線除去・傾き補正の画像処理のみ。Flask には触れない。
extractRegion/extractRect/defaultParams は cv 非依存の純粋なCanvas2D操作
だったため、そちらは移植せず JS 側にそのまま残している（呼び出し側の
processor.js を参照）。
"""
from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from imaging import js_round

RED_OVERLAY_RGBA = (215, 45, 45, 255)   # cv.Scalar(215,45,45,255) と同じRGBA順
WHITE_RGBA = (255, 255, 255, 255)


def _to_gray(rgba: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgba, cv2.COLOR_RGBA2GRAY)


def _binarize(gray: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    method = p.get('binaryMethod', 'adaptive')
    if method == 'adaptive':
        block = int(p.get('adaptiveBlock', 51))
        if block % 2 == 0:
            block += 1
        block = max(3, block)
        return cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
            block, float(p.get('adaptiveC', -5)),
        )
    if method == 'manual':
        _, dst = cv2.threshold(gray, float(p.get('manualThresh', 128)), 255, cv2.THRESH_BINARY_INV)
        return dst
    # otsu
    _, dst = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return dst


def _detect_lines(binary: np.ndarray, kw: int, kh: int, dil_iter: int) -> np.ndarray:
    w = max(1, int(kw))
    h = max(1, int(kh))
    kern = cv2.getStructuringElement(cv2.MORPH_RECT, (w, h))
    dst = cv2.erode(binary, kern)
    dst = cv2.dilate(dst, kern)
    if dil_iter > 0:
        kd = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        for _ in range(int(dil_iter)):
            dst = cv2.dilate(dst, kd)
    return dst


def _build_mask(binary: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    rows, cols = binary.shape[:2]
    if p.get('enableHoriz', True):
        h_mask = _detect_lines(
            binary,
            max(3, js_round(cols * float(p.get('horizLen', 5)) / 100)),
            int(p.get('horizThick', 1)),
            int(p.get('horizDilate', 2)),
        )
    else:
        h_mask = np.zeros_like(binary)

    if p.get('enableVert', True):
        v_mask = _detect_lines(
            binary,
            int(p.get('vertThick', 1)),
            max(3, js_round(rows * float(p.get('vertLen', 5)) / 100)),
            int(p.get('vertDilate', 2)),
        )
    else:
        v_mask = np.zeros_like(binary)

    combined = cv2.bitwise_or(h_mask, v_mask)
    mask_dilate = int(p.get('maskDilate', 0))
    if mask_dilate > 0:
        size = mask_dilate * 2 + 1
        kd = cv2.getStructuringElement(cv2.MORPH_RECT, (size, size))
        combined = cv2.dilate(combined, kd)
    return combined


def _mask_to_red_overlay(src_rgba: np.ndarray, mask: np.ndarray) -> np.ndarray:
    result = src_rgba.copy()
    result[mask > 0] = RED_OVERLAY_RGBA
    return result


def _apply_mask(src_rgba: np.ndarray, gray: np.ndarray, binary: np.ndarray,
                 mask: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    output_base = p.get('outputBase', 'original')
    if output_base == 'gray':
        base = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGBA)
    elif output_base == 'binary':
        inv = cv2.bitwise_not(binary)
        base = cv2.cvtColor(inv, cv2.COLOR_GRAY2RGBA)
    else:
        base = src_rgba.copy()
    base[mask > 0] = WHITE_RGBA
    return base


def process(src_rgba: np.ndarray, params: dict[str, Any]) -> list[np.ndarray]:
    """4段階のRGBA配列を返す: [原画像, 二値化(表示用・反転), 罫線マスク(赤ハイライト), 罫線除去結果]"""
    gray = _to_gray(src_rgba)
    binary = _binarize(gray, params)

    bin_inv = cv2.bitwise_not(binary)
    bin_rgba = cv2.cvtColor(bin_inv, cv2.COLOR_GRAY2RGBA)

    mask = _build_mask(binary, params)
    overlay = _mask_to_red_overlay(src_rgba, mask)

    final = _apply_mask(src_rgba, gray, binary, mask, params)

    return [src_rgba.copy(), bin_rgba, overlay, final]


def rotate(src_rgba: np.ndarray, angle_deg: float) -> np.ndarray:
    """matcher.py の内部回転（グレースケール探索用）と同じ回転規約。カラーのまま回転し、
    余白は白で埋める（processor.js の rotateCanvas と同一）。"""
    if abs(angle_deg) < 0.001:
        return src_rgba.copy()
    rows, cols = src_rgba.shape[:2]
    center = (cols / 2.0, rows / 2.0)
    m = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    return cv2.warpAffine(
        src_rgba, m, (cols, rows),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=WHITE_RGBA,
    )
