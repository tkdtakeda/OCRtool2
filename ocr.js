/* ════════════════════════════════════════════════════════
   ocr.js  Tesseract.js OCR ラッパー
   Responsibility: OCR処理ロジックのみ。DOM操作・UI状態管理は持たない
   ════════════════════════════════════════════════════════ */
'use strict';

const OcrProcessor = (() => {

  /* ── CDN paths (file:// 対応・明示指定) ─────────────── */
  const CDN = {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/worker.min.js',
    langPath:   'https://tessdata.projectnaptha.com/4.0.0',
    corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@4/tesseract-core-simd.wasm.js',
  };

  /* ── ステータス日本語マップ ──────────────────────────── */
  const STATUS_JA = [
    ['loading tesseract core',       'OCRエンジンを読み込み中…'],
    ['loading language traineddata', '言語データを読み込み中… (初回は数十秒かかります)'],
    ['initializing api',             'OCRを初期化中…'],
    ['initializing tesseract',       'OCRを初期化中…'],
    ['recognizing text',             'テキストを認識中…'],
  ];

  let _worker = null;
  let _ready  = false;
  let _lang   = 'eng';
  let _logCb  = () => {};

  /* ── Worker 初期化（初回 / 言語変更時のみ実行） ─────── */
  async function ensureWorker(lang) {
    const want = lang || 'eng';
    if (_ready && _lang === want) return;
    if (!_worker) {
      _worker = await Tesseract.createWorker({
        ...CDN,
        logger: m => _logCb(m),
      });
    }
    /* 'eng' / 'jpn' / 'jpn+eng' などをまとめて読み込み・初期化 */
    await _worker.loadLanguage(want);
    await _worker.initialize(want);
    _lang  = want;
    _ready = true;
  }

  function toJa(raw) {
    if (!raw) return '処理中…';
    for (const [key, msg] of STATUS_JA) {
      if (raw.includes(key)) return msg;
    }
    return raw;
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
   *   error:    string|null
   * }>}
   */
  async function recognize(canvas, psm, onProgress, lang, whitelist) {
    /* ログコールバックを更新（ensureWorker 呼び出し前に設定） */
    _logCb = m => {
      if (typeof onProgress === 'function') {
        onProgress({ status: toJa(m.status), progress: m.progress || 0 });
      }
    };

    try {
      await ensureWorker(lang);
      /* 文字ホワイトリスト: 指定時はその文字種のみ出力（丸数字・記号の誤認を防ぐ）。
         未指定('')は制限なし。前回値が残らないよう毎回明示設定する。 */
      await _worker.setParameters({
        tessedit_pageseg_mode: String(psm),
        tessedit_char_whitelist: whitelist || '',
      });

      const { data } = await _worker.recognize(canvas);

      const words = (data.words || [])
        .filter(w => w.text && w.text.trim())
        .map(w => ({
          text:       w.text.trim(),
          confidence: Math.round(w.confidence),
          bbox:       w.bbox,
        }));

      /* data.confidence は領域全体の平均信頼度。文字ホワイトリスト指定時は
         words が空/0になることがあるため、フォールバックとして返す。 */
      return { fullText: data.text || '', words, confidence: typeof data.confidence === 'number' ? data.confidence : 0, error: null };

    } catch (e) {
      return {
        fullText: '',
        words:    [],
        error:    (e && e.message) ? e.message : String(e),
      };
    }
  }

  /* ── Public: terminate ──────────────────────────────── */
  /**
   * Worker を終了して解放する（ページ離脱時などに使用）
   */
  async function terminate() {
    if (_worker) {
      try { await _worker.terminate(); } catch (_) {}
      _worker = null;
      _ready  = false;
    }
  }

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
