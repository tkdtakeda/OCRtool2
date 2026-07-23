/* ════════════════════════════════════════════════════════
   ocr.js  OCR ラッパー（Pythonサーバー呼び出し版）
   Responsibility: OCR処理の依頼のみ。DOM操作・UI状態管理は持たない
   ────────────────────────────────────────────────────────
   以前はTesseract.js(WASM)でここに直接OCRを実行していたが、処理速度向上の
   ためローカルのPythonサーバー（/api/ocr、ocr_server.py）へ移した。
   ocr_server.py は tesserocr（文字単位の確信度まで取れる。無ければ
   pytesseractへ自動フォールバック）でネイティブのTesseractエンジンを叩く。
   公開関数名・引数・戻り値の形（fullText/words/symbols/lines/confidence/
   error）は維持しているため、呼び出し側（recognizer.js）は無修正で動く。
   ════════════════════════════════════════════════════════ */
'use strict';

const OcrProcessor = (() => {

  /* ── サーバー通信ヘルパー ────────────────────────────── */
  async function postJSON(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (_) {
      throw new Error('OCRサーバーに接続できません。サーバーが起動しているか確認してください。');
    }
    if (!res.ok) {
      let msg = `サーバーエラー (HTTP ${res.status})`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function toDataURL(source) {
    if (source instanceof HTMLCanvasElement) return source.toDataURL('image/png');
    const c = document.createElement('canvas');
    c.width = source.naturalWidth || source.width;
    c.height = source.naturalHeight || source.height;
    c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0);
    return c.toDataURL('image/png');
  }

  /* ── Public: recognize ──────────────────────────────── */
  /**
   * Canvas に対して OCR を実行する
   * @param {HTMLCanvasElement} canvas     対象キャンバス
   * @param {number}            psm        Page Segmentation Mode (3=auto, 6=block, 7=line)
   * @param {Function}          onProgress ({ status: string, progress: number }) => void
   * @returns {Promise<{
   *   fullText: string,
   *   words:    Array<{ text: string, confidence: number, bbox: object }>,
   *   symbols:  Array<{ text: string, confidence: number }>,
   *   lines:    Array<{ text: string, confidence: number }>,
   *   confidence: number,
   *   error:    string|null
   * }>}
   */
  async function recognize(canvas, psm, onProgress, lang, whitelist) {
    /* サーバー呼び出しは1リクエストで完結し、Tesseract.js時代のような
       ワーカー言語切替の待ち時間（数十秒）が無くなったため、途中経過は
       出せない。進捗表示が前の欄の文言のまま古く見えないよう、リクエスト
       送信前に1度だけ通知する。 */
    if (typeof onProgress === 'function') onProgress({ status: '認識中…', progress: 0 });

    try {
      const json = await postJSON('/api/ocr', {
        image: toDataURL(canvas),
        psm,
        lang: lang || 'eng',
        whitelist: whitelist || '',
      });
      return {
        fullText:   json.fullText || '',
        words:      json.words || [],
        symbols:    json.symbols || [],
        lines:      json.lines || [],
        confidence: typeof json.confidence === 'number' ? json.confidence : 0,
        error:      json.error || null,
      };
    } catch (e) {
      return {
        fullText: '',
        words:    [],
        symbols:  [],
        lines:    [],
        confidence: 0,
        error:    (e && e.message) ? e.message : String(e),
      };
    }
  }

  /* ── Public: terminate ──────────────────────────────── */
  /**
   * 互換のために残しているだけの no-op。以前はブラウザ内のTesseract.js
   * workerを終了する処理だったが、サーバー移行後はその場に持続するローカル
   * workerが無くなったため何もしない（呼び出し箇所は現状ゼロ）。
   */
  async function terminate() {}

  /* ── Public: normalize ──────────────────────────────── */
  /**
   * OCR結果の表記ゆれを正規化する（確定的な後処理）。
   *   ①〜⑳ / ⓪ → 算用数字、全角英数字 → 半角
   * @param {string} s
   * @returns {string}
   */
  function normalize(s) {
    if (!s) return s;
    return s
      .replace(/[①-⑨]/g, c => String(c.charCodeAt(0) - 0x2460 + 1))   // ①-⑨ → 1-9
      .replace(/[⑩-⑳]/g, c => String(c.charCodeAt(0) - 0x2469 + 10))  // ⑩-⑳ → 10-20
      .replace(/⓪/g, '0')                                                  // ⓪ → 0
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g,                     // ０-９Ａ-Ｚａ-ｚ → 半角
        c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }

  /**
   * 一桁の漢数字を算用数字へ変換する（一→1 等）。
   * 漢字を含む氏名欄などを壊す恐れがあるため、呼び出し側でオプトイン（既定OFF）。
   * @param {string} s
   * @returns {string}
   */
  const KANJI_NUM = { '〇':'0','零':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9' };
  function kanjiToNum(s) {
    if (!s) return s;
    return s.replace(/[〇零一二三四五六七八九]/g, c => KANJI_NUM[c]);
  }

  return { recognize, terminate, normalize, kanjiToNum };

})();
