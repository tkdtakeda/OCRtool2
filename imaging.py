"""dataURL <-> RGBA numpy array の変換ヘルパー。

このパッケージに入る画像は必ずここで RGBA の uint8 配列にデコードし、
返す直前に必ずここで PNG dataURL へエンコードする。matcher.py / processor.py は
常に RGBA 前提で書く（ブラウザの canvas ImageData が RGBA なため、元の
OpenCV.js 版のコード・色定数をそのまま数値レベルで移植できる）。cv2 自体は
BGR(A) 前提だが、そのズレはこのファイルの境界だけで吸収する。
"""
from __future__ import annotations

import base64
import re

import cv2
import numpy as np

_DATA_URL_RE = re.compile(r'^data:image/[a-zA-Z0-9.+-]+;base64,(.*)$', re.DOTALL)


def data_url_to_rgba(data_url: str) -> np.ndarray:
    """PNG/JPEG dataURL（生base64のみでも可）を (H,W,4) uint8 RGBA 配列にする。"""
    if not data_url:
        raise ValueError('画像データがありません')
    m = _DATA_URL_RE.match(data_url)
    raw = base64.b64decode(m.group(1) if m else data_url)
    buf = np.frombuffer(raw, dtype=np.uint8)
    decoded = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if decoded is None:
        raise ValueError('画像を読み込めませんでした（破損しているか未対応の形式です）')
    if decoded.ndim == 2:
        return cv2.cvtColor(decoded, cv2.COLOR_GRAY2RGBA)
    if decoded.shape[2] == 3:
        return cv2.cvtColor(decoded, cv2.COLOR_BGR2RGBA)
    return cv2.cvtColor(decoded, cv2.COLOR_BGRA2RGBA)


def rgba_to_data_url(rgba: np.ndarray) -> str:
    """(H,W,4) uint8 RGBA 配列を PNG dataURL にする（無劣化・可逆）。"""
    bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
    ok, buf = cv2.imencode('.png', bgra)
    if not ok:
        raise ValueError('画像のエンコードに失敗しました')
    return 'data:image/png;base64,' + base64.b64encode(buf.tobytes()).decode('ascii')


def js_round(x: float) -> int:
    """JS の Math.round と同じ丸め（0.5 は必ず +方向）。cv2/numpy 側のズレを避けるため
    座標・角度グリッドの丸めはすべてこれを通す（Python組み込みround()は銀行丸め）。"""
    import math
    return int(math.floor(x + 0.5)) if x >= 0 else int(math.ceil(x - 0.5))
