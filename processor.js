/* ════════════════════════════════════════════════════════
   processor.js  OpenCV.js 処理パイプライン
   Responsibility: 画像処理ロジックのみ。DOM 操作なし
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

  /* ── Mat helpers ────────────────────────────────────── */
  /**
   * 指定サイズの単チャンネル黒マスクを生成
   * @param {number} rows
   * @param {number} cols
   * @returns {cv.Mat} CV_8UC1
   */
  function zeroMat(rows, cols) {
    return new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0));
  }

  /**
   * src を RGBA (CV_8UC4) に変換して返す（元の Mat は変更しない）
   * @param {cv.Mat} src
   * @returns {cv.Mat}
   */
  function toRGBA(src) {
    const dst = new cv.Mat();
    if      (src.channels() === 4) src.copyTo(dst);
    else if (src.channels() === 3) cv.cvtColor(src, dst, cv.COLOR_RGB2RGBA);
    else                           cv.cvtColor(src, dst, cv.COLOR_GRAY2RGBA);
    return dst;
  }

  /**
   * src をグレースケール (CV_8UC1) に変換
   * @param {cv.Mat} src
   * @returns {cv.Mat}
   */
  function toGray(src) {
    const dst = new cv.Mat();
    if      (src.channels() === 4) cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY);
    else if (src.channels() === 3) cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY);
    else                           src.copyTo(dst);
    return dst;
  }

  /* ── Step: binarize ─────────────────────────────────── */
  /**
   * グレースケール → 二値化（暗い線 → 白, 背景 → 黒 の反転二値）
   * @param {cv.Mat} gray  CV_8UC1
   * @param {object} p     parameters
   * @returns {cv.Mat}     CV_8UC1 (白=線状暗部, 黒=背景)
   */
  function binarize(gray, p) {
    const dst = new cv.Mat();
    switch (p.binaryMethod) {
      case 'adaptive':
        cv.adaptiveThreshold(
          gray, dst, 255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,
          cv.THRESH_BINARY_INV,
          p.adaptiveBlock,
          p.adaptiveC
        );
        break;
      case 'manual':
        cv.threshold(gray, dst, p.manualThresh, 255, cv.THRESH_BINARY_INV);
        break;
      default: /* otsu */
        cv.threshold(gray, dst, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    }
    return dst;
  }

  /* ── Step: detect lines ─────────────────────────────── */
  /**
   * モルフォロジー Open（erode→dilate）で線を抽出する
   * @param {cv.Mat} binary  CV_8UC1 反転二値画像
   * @param {number} kw      カーネル幅
   * @param {number} kh      カーネル高さ
   * @param {number} dilIter 追加膨張回数
   * @returns {cv.Mat}       CV_8UC1 線マスク（白=線）
   */
  function detectLines(binary, kw, kh, dilIter) {
    const w   = Math.max(1, kw);
    const h   = Math.max(1, kh);
    const dst  = binary.clone();
    const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(w, h));
    cv.erode (dst, dst, kern);
    cv.dilate(dst, dst, kern);
    kern.delete();
    if (dilIter > 0) {
      const kd = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      for (let i = 0; i < dilIter; i++) cv.dilate(dst, dst, kd);
      kd.delete();
    }
    return dst;
  }

  /* ── Step: build combined mask ──────────────────────── */
  /**
   * 水平・垂直のマスクを合成して最終マスクを返す
   * @param {cv.Mat} binary  CV_8UC1
   * @param {object} p
   * @returns {cv.Mat}       CV_8UC1
   */
  function buildMask(binary, p) {
    const hMask = p.enableHoriz
      ? detectLines(
          binary,
          Math.max(3, Math.round(binary.cols * p.horizLen / 100)),
          p.horizThick,
          p.horizDilate
        )
      : zeroMat(binary.rows, binary.cols);

    const vMask = p.enableVert
      ? detectLines(
          binary,
          p.vertThick,
          Math.max(3, Math.round(binary.rows * p.vertLen / 100)),
          p.vertDilate
        )
      : zeroMat(binary.rows, binary.cols);

    const combined = new cv.Mat();
    cv.bitwise_or(hMask, vMask, combined);
    hMask.delete();
    vMask.delete();

    if (p.maskDilate > 0) {
      const size = p.maskDilate * 2 + 1;
      const kd   = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size));
      cv.dilate(combined, combined, kd);
      kd.delete();
    }
    return combined;
  }

  /* ── Step: mask overlay visualization ──────────────── */
  /**
   * srcRGBA の上に mask（白=検出線）を赤くハイライトして返す
   * @param {cv.Mat} srcRGBA  CV_8UC4
   * @param {cv.Mat} mask     CV_8UC1
   * @returns {cv.Mat}        CV_8UC4
   */
  function maskToRedOverlay(srcRGBA, mask) {
    const result = srcRGBA.clone();
    const red    = new cv.Mat(srcRGBA.rows, srcRGBA.cols, cv.CV_8UC4,
                    new cv.Scalar(215, 45, 45, 255));
    red.copyTo(result, mask);
    red.delete();
    return result;
  }

  /* ── Step: apply mask → final result ───────────────── */
  /**
   * mask 部分を白で塗りつぶした最終画像を返す
   * @param {cv.Mat} src     元画像（任意チャンネル）
   * @param {cv.Mat} gray    CV_8UC1
   * @param {cv.Mat} binary  CV_8UC1 反転二値
   * @param {cv.Mat} mask    CV_8UC1 線マスク
   * @param {object} p
   * @returns {cv.Mat}       CV_8UC4
   */
  function applyMask(src, gray, binary, mask, p) {
    let base;
    switch (p.outputBase) {
      case 'gray': {
        base = new cv.Mat();
        cv.cvtColor(gray, base, cv.COLOR_GRAY2RGBA);
        break;
      }
      case 'binary': {
        const inv = new cv.Mat();
        cv.bitwise_not(binary, inv);
        base = new cv.Mat();
        cv.cvtColor(inv, base, cv.COLOR_GRAY2RGBA);
        inv.delete();
        break;
      }
      default: /* original */
        base = toRGBA(src);
    }
    const white = new cv.Mat(base.rows, base.cols, cv.CV_8UC4,
                   new cv.Scalar(255, 255, 255, 255));
    white.copyTo(base, mask);
    white.delete();
    return base;
  }

  /* ── Main pipeline ──────────────────────────────────── */
  /**
   * 4 ステップの処理を行い、RGBA Mat の配列を返す
   * @param {HTMLCanvasElement} srcCanvas  入力キャンバス
   * @param {object} p                     parameters
   * @returns {{ mats: cv.Mat[], error: string|null }}
   */
  function process(srcCanvas, p) {
    const result = { mats: [], error: null };
    let src = null;
    try {
      src = cv.imread(srcCanvas);

      /* ─ Step 0: 原画像 ─ */
      result.mats.push(toRGBA(src));

      /* ─ Step 1: グレー + 二値化 ─ */
      const gray   = toGray(src);
      const binary = binarize(gray, p);

      /* 表示用: 反転（白背景・黒線で自然に見える） */
      const binInv  = new cv.Mat();
      cv.bitwise_not(binary, binInv);
      const binRGBA = new cv.Mat();
      cv.cvtColor(binInv, binRGBA, cv.COLOR_GRAY2RGBA);
      binInv.delete();
      result.mats.push(binRGBA);

      /* ─ Step 2: 罫線マスク（赤ハイライト） ─ */
      const mask    = buildMask(binary, p);
      const overlay = maskToRedOverlay(result.mats[0], mask);
      result.mats.push(overlay);

      /* ─ Step 3: 罫線除去結果 ─ */
      result.mats.push(applyMask(src, gray, binary, mask, p));

      /* 内部 Mat 解放 */
      gray.delete();
      binary.delete();
      mask.delete();

    } catch (e) {
      result.error = (e && e.message) ? e.message : String(e);
    } finally {
      if (src) src.delete();
    }
    return result;
  }

  /* ── 傾き補正: キャンバス回転 ───────────────────────── */
  /**
   * OpenCV の getRotationMatrix2D で回転（matcherEngine と同じ符号規約）
   * angleDeg > 0 = 反時計回り。元サイズを保持し、余白は白（帳票余白）で埋める。
   * 統合ツールの認識パイプラインで使用（罫線除去前の傾き補正）。
   * @param {HTMLCanvasElement} srcCanvas
   * @param {number}            angleDeg
   * @returns {HTMLCanvasElement}  新規キャンバス
   */
  function rotateCanvas(srcCanvas, angleDeg) {
    /* 無回転ならコピーを返す */
    if (!angleDeg || Math.abs(angleDeg) < 0.001) {
      const out = document.createElement('canvas');
      out.width  = srcCanvas.width;
      out.height = srcCanvas.height;
      out.getContext('2d').drawImage(srcCanvas, 0, 0);
      return out;
    }
    let src = null, dst = null, M = null;
    try {
      src = cv.imread(srcCanvas);
      const center = new cv.Point(src.cols / 2, src.rows / 2);
      M   = cv.getRotationMatrix2D(center, angleDeg, 1.0);
      dst = new cv.Mat();
      cv.warpAffine(
        src, dst, M,
        new cv.Size(src.cols, src.rows),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT,
        new cv.Scalar(255, 255, 255, 255)   // 白背景
      );
      const out = document.createElement('canvas');
      out.width  = srcCanvas.width;
      out.height = srcCanvas.height;
      cv.imshow(out, dst);
      return out;
    } catch (e) {
      /* フォールバック: コピーを返す */
      const out = document.createElement('canvas');
      out.width  = srcCanvas.width;
      out.height = srcCanvas.height;
      out.getContext('2d').drawImage(srcCanvas, 0, 0);
      return out;
    } finally {
      if (src) try { src.delete(); } catch (_) {}
      if (dst) try { dst.delete(); } catch (_) {}
      if (M)   try { M.delete();   } catch (_) {}
    }
  }

  /* ── OCR 領域の切り出し ─────────────────────────────── */
  /**
   * 罫線除去結果キャンバスから、基準画像座標 + 平行移動量で OCR 対象領域を切り出す。
   * 統合ツールでは loc に「基準画像→入力画像の平行移動量」を、
   * rect に「基準画像上の絶対座標」を渡す（x = loc.x + rect.x）。
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
    out.getContext('2d').drawImage(srcCanvas, sx, sy, clampedW, clampedH, 0, 0, clampedW, clampedH);
    return out;
  }

  /* ── 絶対矩形の切り出し ─────────────────────────────── */
  /**
   * 入力画像座標の絶対矩形（x,y,w,h）を切り出す。境界はクランプする。
   * 相似変換でスケール適用済みの矩形を渡す用途（複数アンカー補正）。
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
    out.getContext('2d').drawImage(srcCanvas, sx, sy, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /* ── Render / cleanup ───────────────────────────────── */
  /**
   * Mat をキャンバスに描画する
   * @param {cv.Mat}            mat
   * @param {HTMLCanvasElement} canvas
   */
  function renderToCanvas(mat, canvas) {
    cv.imshow(canvas, mat);
  }

  /**
   * Mat 配列を一括解放する
   * @param {cv.Mat[]} mats
   */
  function cleanupMats(mats) {
    mats.forEach(m => {
      try { if (m && !m.isDeleted()) m.delete(); } catch (_) {}
    });
  }

  return { process, renderToCanvas, cleanupMats, defaultParams, rotateCanvas, extractRegion, extractRect };

})();
