"""ocr.js（OcrProcessor）の recognize() を移植。

tesserocr（Tesseractのネイティブ C++ API を直接叩く。文字単位の確信度が
取れ、常駐インスタンスを使い回せるため高速）を優先し、import や初期化に
失敗した場合のみ pytesseract（tesseractコマンドを都度呼び出す。コンパイル
不要でどの環境にも入りやすい）へ自動的にフォールバックする。

requirements.txt には pytesseract のみを必須として書き、tesserocr は任意の
追加インストールという扱いにする（tesserocrはCコンパイラ＋Tesseractの
開発ヘッダが必要で、必須にすると環境によっては requirements.txt の
インストール自体が失敗しうるため）。README参照。

Responsibility: OCR処理ロジックのみ。Flask には触れない。ocr.jsの契約と
同じく、例外は投げずに { ..., error: string } を返す。
"""
from __future__ import annotations

import os
import tempfile
import threading
from typing import Any

import numpy as np
from PIL import Image

_ENGINE: str | None = None       # 'tesserocr' | 'pytesseract' | None
_INIT_ERROR: str | None = None
_TESSDATA_DIR: str | None = None

_tesserocr = None
_pytesseract = None

_tesserocr_lock = threading.Lock()
_tesserocr_api = None
_tesserocr_api_lang: str | None = None


def _candidate_tessdata_dirs() -> list[str]:
    dirs = []
    env = os.environ.get('TESSDATA_PREFIX')
    if env:
        dirs.append(env)
    dirs += [
        '/usr/share/tesseract-ocr/5/tessdata',
        '/usr/share/tesseract-ocr/4.00/tessdata',
        '/usr/share/tessdata',
        '/usr/local/share/tessdata',
        '/opt/homebrew/share/tessdata',
        r'C:\Program Files\Tesseract-OCR\tessdata',
    ]
    return dirs


def _find_tessdata_dir() -> str | None:
    for d in _candidate_tessdata_dirs():
        if d and os.path.isfile(os.path.join(d, 'eng.traineddata')):
            return d
    return None


def _init_engine() -> None:
    """起動時に一度だけ実行。importできるかだけでなく、実際に初期化できるかまで
    確認してから確定する（tessdataが見つからずimportは成功しても初期化は失敗する
    ケースがあるため）。"""
    global _ENGINE, _INIT_ERROR, _tesserocr, _pytesseract, _TESSDATA_DIR
    _TESSDATA_DIR = _find_tessdata_dir()

    try:
        import tesserocr as _t
        kwargs: dict[str, Any] = {'lang': 'eng'}
        if _TESSDATA_DIR:
            kwargs['path'] = _TESSDATA_DIR
        probe = _t.PyTessBaseAPI(**kwargs)
        probe.End()
        _tesserocr = _t
        _ENGINE = 'tesserocr'
        return
    except Exception as e:  # noqa: BLE001 - フォールバックのため意図的に広く捕捉
        _INIT_ERROR = f'tesserocr初期化失敗: {e}'

    try:
        import pytesseract as _p
        _p.get_tesseract_version()
        _pytesseract = _p
        _ENGINE = 'pytesseract'
        return
    except Exception as e:  # noqa: BLE001
        _INIT_ERROR = f'{_INIT_ERROR}; pytesseract初期化失敗: {e}'
        _ENGINE = None


_init_engine()


def is_ready() -> bool:
    return _ENGINE is not None


def init_error() -> str | None:
    return _INIT_ERROR


# ── tesserocr 経路 ──────────────────────────────────────────
def _get_tesserocr_api(lang: str):
    """Worker再利用の考え方をそのまま踏襲: 言語が変わった時だけ再初期化する。"""
    global _tesserocr_api, _tesserocr_api_lang
    kwargs: dict[str, Any] = {'lang': lang}
    if _TESSDATA_DIR:
        kwargs['path'] = _TESSDATA_DIR
    if _tesserocr_api is None:
        _tesserocr_api = _tesserocr.PyTessBaseAPI(**kwargs)
        _tesserocr_api_lang = lang
    elif _tesserocr_api_lang != lang:
        _tesserocr_api.Init(**kwargs)
        _tesserocr_api_lang = lang
    return _tesserocr_api


def _bbox_from_tuple(box) -> dict[str, int]:
    if not box:
        return {'x0': 0, 'y0': 0, 'x1': 0, 'y1': 0}
    x1, y1, x2, y2 = box
    return {'x0': int(x1), 'y0': int(y1), 'x1': int(x2), 'y1': int(y2)}


def _iterate_level(api, level) -> list[dict[str, Any]]:
    items = []
    it = api.GetIterator()
    if it is None:
        return items
    while True:
        try:
            text = it.GetUTF8Text(level)
        except RuntimeError:
            # 完全に空白の領域など、その位置に文字が一切無い場合はここで例外になる
            # （tesserocr自身の挙動）。「文字が無い」という正常な結果として扱う。
            text = None
        if text and text.strip():
            conf = it.Confidence(level)
            items.append({
                'text': text.strip(),
                'confidence': round(max(0.0, conf)),
                'bbox': _bbox_from_tuple(it.BoundingBox(level)),
            })
        if not it.Next(level):
            break
    return items


def _recognize_tesserocr(rgba: np.ndarray, psm: int, lang: str, whitelist: str) -> dict[str, Any]:
    pil_img = Image.fromarray(rgba).convert('RGB')
    with _tesserocr_lock:
        api = _get_tesserocr_api(lang)
        api.SetPageSegMode(int(psm))
        api.SetVariable('tessedit_char_whitelist', whitelist or '')
        api.SetImage(pil_img)
        api.Recognize()
        full_text = api.GetUTF8Text() or ''
        overall_conf = api.MeanTextConf()

        words = _iterate_level(api, _tesserocr.RIL.WORD)
        symbols_raw = _iterate_level(api, _tesserocr.RIL.SYMBOL)
        lines_raw = _iterate_level(api, _tesserocr.RIL.TEXTLINE)

    return {
        'fullText': full_text,
        'words': words,
        'symbols': [{'text': s['text'], 'confidence': s['confidence']} for s in symbols_raw],
        'lines': [{'text': l['text'], 'confidence': l['confidence']} for l in lines_raw],
        'confidence': int(overall_conf) if overall_conf is not None else 0,
        'error': None,
    }


# ── pytesseract 経路 ────────────────────────────────────────
def _pytesseract_config(psm: int, whitelist: str) -> tuple[str, str | None]:
    """whitelistは--psmと違い空白・カンマ・通貨記号を含みうる。pytesseractは
    configをshlex.splitするため、値をそのままコマンドライン文字列に混ぜると
    空白で分断されて壊れる。Tesseractのconfigファイル（1行『変数名 値』形式で
    改行までが値になり再分割されない）に書き出し、そのパスだけを渡すことで回避する。"""
    config = f'--psm {int(psm)}'
    tmp_path = None
    if whitelist:
        fd, tmp_path = tempfile.mkstemp(suffix='.txt', prefix='ocrtool_wl_')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(f'tessedit_char_whitelist {whitelist}\n')
        config += f' "{tmp_path}"'
    return config, tmp_path


def _group_words_and_lines(data: dict[str, list]) -> tuple[list[dict], list[dict]]:
    words: list[dict[str, Any]] = []
    line_groups: dict[tuple, list[tuple[str, float]]] = {}
    line_order: list[tuple] = []
    n = len(data.get('text', []))
    for i in range(n):
        if data['level'][i] != 5:   # 5 = word（Tesseract TSVの階層）
            continue
        txt = (data['text'][i] or '')
        if not txt.strip():
            continue
        try:
            conf = max(0.0, float(data['conf'][i]))
        except (TypeError, ValueError):
            conf = 0.0
        words.append({
            'text': txt.strip(),
            'confidence': round(conf),
            'bbox': {
                'x0': int(data['left'][i]), 'y0': int(data['top'][i]),
                'x1': int(data['left'][i]) + int(data['width'][i]),
                'y1': int(data['top'][i]) + int(data['height'][i]),
            },
        })
        key = (data['block_num'][i], data['par_num'][i], data['line_num'][i])
        if key not in line_groups:
            line_groups[key] = []
            line_order.append(key)
        line_groups[key].append((txt.strip(), conf))

    lines = []
    for key in line_order:
        items = line_groups[key]
        confs = [c for _, c in items]
        lines.append({
            'text': ' '.join(t for t, _ in items),
            'confidence': round(sum(confs) / len(confs)) if confs else 0,
        })
    return words, lines


def _recognize_pytesseract(rgba: np.ndarray, psm: int, lang: str, whitelist: str) -> dict[str, Any]:
    pil_img = Image.fromarray(rgba).convert('RGB')
    config, tmp_path = _pytesseract_config(psm, whitelist)
    try:
        data = _pytesseract.image_to_data(pil_img, lang=lang, config=config,
                                           output_type=_pytesseract.Output.DICT)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    words, lines = _group_words_and_lines(data)
    # TesseractのTSVには文字単位の粒度が無いため、単語の確信度をその文字全てへ
    # ブロードキャストして近似する（tesserocrが使えない環境向けのフォールバック）。
    symbols = [{'text': ch, 'confidence': w['confidence']} for w in words for ch in w['text']]
    confidence = round(sum(w['confidence'] for w in words) / len(words)) if words else 0

    return {
        'fullText': '\n'.join(l['text'] for l in lines),
        'words': words,
        'symbols': symbols,
        'lines': lines,
        'confidence': confidence,
        'error': None,
    }


# ── 公開API ─────────────────────────────────────────────────
def recognize(rgba: np.ndarray, psm: int, lang: str, whitelist: str) -> dict[str, Any]:
    """ocr.js の OcrProcessor.recognize と同じ契約：例外を投げず、失敗時は
    error にメッセージを入れて返す。"""
    empty = {'fullText': '', 'words': [], 'symbols': [], 'lines': [], 'confidence': 0, 'error': None}
    if _ENGINE is None:
        empty['error'] = f'OCRエンジンを初期化できませんでした: {_INIT_ERROR or "不明なエラー"}'
        return empty
    try:
        fn = _recognize_tesserocr if _ENGINE == 'tesserocr' else _recognize_pytesseract
        return fn(rgba, psm, lang or 'eng', whitelist or '')
    except Exception as e:  # noqa: BLE001 - ocr.js同様、呼び出し側へは例外を伝播させない
        empty['error'] = str(e)
        return empty


def health_info() -> dict[str, Any]:
    languages: list[str] = []
    tesseract_version = None
    try:
        if _ENGINE == 'tesserocr':
            _, langs = (_tesserocr.get_languages(_TESSDATA_DIR) if _TESSDATA_DIR
                        else _tesserocr.get_languages())
            languages = sorted(l for l in langs if l != 'osd')
            tesseract_version = str(_tesserocr.tesseract_version()).splitlines()[0]
        elif _ENGINE == 'pytesseract':
            languages = sorted(l for l in _pytesseract.get_languages(config='') if l != 'osd')
            tesseract_version = str(_pytesseract.get_tesseract_version())
    except Exception:  # noqa: BLE001 - 診断情報なので失敗しても健康チェック自体は止めない
        pass
    return {'ocrEngine': _ENGINE, 'tesseractVersion': tesseract_version, 'languages': languages}
