/* ════════════════════════════════════════════════════════
   processor.js  罫線除去・傾き補正パイプライン（Pythonサーバー呼び出し版）
   Responsibility: 画像処理の依頼のみ。DOM 操作は結果の描画に必要な分だけ
   ────────────────────────────────────────────────────────
   以前はOpenCV.js(WASM)でここに二値化・線検出・回転を直接実装していたが、
   処理速度向上のためローカルのPythonサーバー（/api/line-removal・
   /api/rotate、processor_server.py）へ移した。公開関数名・引数・戻り値の
   形は維持している。ただし mats は以前 cv.Mat の配列だったが、いまは
   HTMLCanvasElement の配列になっている（呼び出し側で .cols/.rows を
   使っていた箇所は .width/.height に直す必要がある点に注意）。
   extractRegion/extractRect/defaultParams は元から純粋なCanvas2D操作で
   OpenCV.js に依存していなかったため、無変更のまま残している。
   ════════════════════════════════════════════════════════ */
'use strict';

const LineRemovalProcessor = (() => {

  /* ── Default parameters ─────────────────────────────── */
  const defaultParams = () => ({
    binaryMethod:  'adaptive',
    manualThresh:  128,
    adaptiveBlock: 51,
    adaptiveC:     -5,
    enableHoriz:   true,
    horizLen:      5,
    horizThick:    1,
    horizDilate:   2,
    enableVert:    true,
    vertLen:       5,
    vertThick:     1,
    vertDilate:    2,
    maskDilate:    0,
    outputBase:    'original',
  });

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

  function dataURLToImg(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.src = url;
    });
  }

  async function dataURLToCanvas(url) {
    const img = await dataURLToImg(url);
    const c = document.createElement('canvas');
    c.width  = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    return c;
  }

  function plainCopy(srcCanvas) {
    const out = document.createElement('canvas');
    out.width  = srcCanvas.width;
    out.height = srcCanvas.height;
    out.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0);
    return out;
  }

  /* ── Main pipeline ──────────────────────────────────── */
  /**
   * 4 ステップの処理をサーバーへ依頼し、キャンバスの配列で受け取る。
   * @param {HTMLCanvasElement} srcCanvas  入力キャンバス
   * @param {object} p                     parameters
   * @returns {Promise<{ mats: HTMLCanvasElement[], error: string|null }>}
   */
  async function process(srcCanvas, p) {
    try {
      const json = await postJSON('/api/line-removal', { image: toDataURL(srcCanvas), params: p });
      if (json.error) return { mats: [], error: json.error };
      const mats = await Promise.all(json.images.map(dataURLToCanvas));
      return { mats, error: null };
    } catch (e) {
      return { mats: [], error: (e && e.message) ? e.message : String(e) };
    }
  }

  /* ── 傾き補正: キャンバス回転 ───────────────────────── */
  /**
   * angleDeg > 0 = 反時計回り。元サイズを保持し、余白は白（帳票余白）で埋める。
   * 統合ツールの認識パイプラインで使用（罫線除去前の傾き補正）。
   * @param {HTMLCanvasElement} srcCanvas
   * @param {number}            angleDeg
   * @returns {Promise<HTMLCanvasElement>}  新規キャンバス
   */
  async function rotateCanvas(srcCanvas, angleDeg) {
    /* 無回転ならサーバーへ行かずコピーを返す（元実装と同じ高速パス） */
    if (!angleDeg || Math.abs(angleDeg) < 0.001) return plainCopy(srcCanvas);
    try {
      const json = await postJSON('/api/rotate', { image: toDataURL(srcCanvas), angle: angleDeg });
      if (json.error || !json.image) throw new Error(json.error || '回転に失敗しました');
      return await dataURLToCanvas(json.image);
    } catch (e) {
      /* フォールバック: コピーを返す（元の実装と同じ契約を維持） */
      return plainCopy(srcCanvas);
    }
  }

  /* ── OCR 領域の切り出し ─────────────────────────────── */
  /**
   * 罫線除去結果キャンバスから、基準画像座標 + 平行移動量で OCR 対象領域を切り出す。
   * 統合ツールでは loc に「基準画像→入力画像の平行移動量」を、
   * rect に「基準画像上の絶対座標」を渡す（x = loc.x + rect.x）。
   * （純粋なCanvas2D crop のみで cv 非依存だったため無変更）
   * @param {HTMLCanvasElement} srcCanvas  切り出し元
   * @param {{ x:number, y:number }} loc   平行移動量（原点ずれ）
   * @param {{ x:number, y:number, w:number, h:number }} rect  基準画像上の矩形
   * @returns {HTMLCanvasElement|null}
   */
  function extractRegion(srcCanvas, loc, rect) {
    const x = Math.round((loc?.x || 0) + rect.x);
    const y = Math.round((loc?.y || 0) + rect.y);
    const w = Math.max(1, Math.round(rect.w));
    const h = Math.max(1, Math.round(rect.h));
    /* 画像境界でクランプ */
    const sx = Math.max(0, x);
    const sy = Math.max(0, y);
    const clampedW = Math.min(w - (sx - x), srcCanvas.width  - sx);
    const clampedH = Math.min(h - (sy - y), srcCanvas.height - sy);
    if (clampedW <= 0 || clampedH <= 0) return null;
    const out = document.createElement('canvas');
    out.width  = clampedW;
    out.height = clampedH;
    out.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, sx, sy, clampedW, clampedH, 0, 0, clampedW, clampedH);
    return out;
  }

  /* ── 絶対矩形の切り出し ─────────────────────────────── */
  /**
   * 入力画像座標の絶対矩形（x,y,w,h）を切り出す。境界はクランプする。
   * 相似変換でスケール適用済みの矩形を渡す用途（複数アンカー補正）。
   * （純粋なCanvas2D crop のみで cv 非依存だったため無変更）
   * @param {HTMLCanvasElement} srcCanvas
   * @param {{x:number,y:number,w:number,h:number}} rect
   * @returns {HTMLCanvasElement|null}
   */
  function extractRect(srcCanvas, rect) {
    const x = Math.round(rect.x), y = Math.round(rect.y);
    const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
    const sx = Math.max(0, x), sy = Math.max(0, y);
    const cw = Math.min(w - (sx - x), srcCanvas.width  - sx);
    const ch = Math.min(h - (sy - y), srcCanvas.height - sy);
    if (cw <= 0 || ch <= 0) return null;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, sx, sy, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /* ── Render / cleanup ───────────────────────────────── */
  /**
   * 既に画像化済みのキャンバス(mat)を、指定キャンバスへ描画する。
   * 呼び出し側が先に canvas.width/height をセットしている前提
   * （旧cv.imshowの利用箇所と同じ呼び出し方を維持するため）。
   * @param {HTMLCanvasElement} mat
   * @param {HTMLCanvasElement} canvas
   */
  function renderToCanvas(mat, canvas) {
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(mat, 0, 0);
  }

  /**
   * mats配列を解放する。mats はもう cv.Mat ではなく通常の canvas なので
   * 実質的に何もしない（解放不要）。呼び出し側の互換のためAPIだけ残す。
   * @param {HTMLCanvasElement[]} mats
   */
  function cleanupMats(mats) {
    (mats || []).forEach(m => {
      try { if (m && !m.isDeleted()) m.delete(); } catch (_) {}
    });
  }

  return { process, renderToCanvas, cleanupMats, defaultParams, rotateCanvas, extractRegion, extractRect };

})();
