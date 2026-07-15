/* ════════════════════════════════════════════════════════
   matcher_engine.js  OpenCV.js 画像マッチングエンジン
   Responsibility: matchTemplate 処理のみ。DOM 操作なし
   ════════════════════════════════════════════════════════ */
'use strict';

const MatcherEngine = (() => {

  /* ── Mat ヘルパー ───────────────────────────────────── */

  /**
   * 任意チャンネルの Mat をグレースケール (CV_8UC1) に変換
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

  /**
   * グレースケール Mat を指定角度で回転（白背景 = 帳票余白に合わせた塗りつぶし）
   * @param {cv.Mat} src       CV_8UC1
   * @param {number} angleDeg  回転角（正 = 反時計回り）
   * @returns {cv.Mat}         新規 Mat（呼び出し元が delete すること）
   */
  function rotateMat(src, angleDeg) {
    if (angleDeg === 0) return src.clone();
    const center = new cv.Point(src.cols / 2, src.rows / 2);
    const M      = cv.getRotationMatrix2D(center, angleDeg, 1.0);
    const dst    = new cv.Mat();
    cv.warpAffine(
      src, dst, M,
      new cv.Size(src.cols, src.rows),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255)   // 白で埋める
    );
    M.delete();
    return dst;
  }

  /**
   * グレースケール Mat を指定倍率で拡大縮小する（スケール探索用）。
   * @param {cv.Mat} src     CV_8UC1
   * @param {number} factor  倍率（<1 で縮小）
   * @returns {cv.Mat}       新規 Mat（呼び出し元が delete すること）
   */
  function resizeMat(src, factor) {
    const w = Math.max(1, Math.round(src.cols * factor));
    const h = Math.max(1, Math.round(src.rows * factor));
    const dst = new cv.Mat();
    cv.resize(src, dst, new cv.Size(w, h), 0, 0, factor < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
    return dst;
  }

  /**
   * 単一テンプレートを入力画像に対して matchTemplate (TM_CCOEFF_NORMED)
   * テンプレートが入力画像より大きい場合はスコア 0 を返す。
   * @param {cv.Mat} fullGray      CV_8UC1
   * @param {cv.Mat} templateGray  CV_8UC1
   * @returns {{ score: number, loc: {x:number, y:number} }}
   */
  function runMatch(fullGray, templateGray) {
    if (templateGray.rows > fullGray.rows || templateGray.cols > fullGray.cols) {
      return { score: 0, loc: { x: 0, y: 0 } };
    }
    const res = new cv.Mat();
    cv.matchTemplate(fullGray, templateGray, res, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(res);
    res.delete();
    return { score: mm.maxVal, loc: { x: mm.maxLoc.x, y: mm.maxLoc.y } };
  }

  /* ── メイン: 傾き補正付き一括マッチング ────────────── */

  /**
   * 「角度ごとに全画像を 1 回だけ回転 → 全テンプレートを一括照合」
   * という戦略で回転コストを最小化する。
   *
   * @param {HTMLCanvasElement}   fullCanvas    判定対象画像（フル帳票）
   * @param {Array<{
   *   id:           string,
   *   imageElement: HTMLImageElement   // 読み込み済み
   * }>} templates                       照合テンプレート配列
   * @param {object}  opts
   * @param {number}  opts.angleRange    補正角度範囲 ± (度)  default 2
   * @param {number}  opts.angleStep     ステップ (度)         default 1
   * @returns {Map<string, {
   *   score: number,
   *   angle: number,
   *   loc:   {x:number, y:number}
   * }>}  テンプレート id → ベストスコア情報
   */
  function matchAll(fullCanvas, templates, opts = {}) {
    const angleRange = opts.angleRange ?? 2;
    const angleStep  = Math.max(0.1, opts.angleStep ?? 1);
    /* スケール探索係数（f = 入力に写る帳票の倍率 / 基準）。既定は等倍のみ */
    const scaleFactors = (Array.isArray(opts.scaleFactors) && opts.scaleFactors.length)
      ? opts.scaleFactors : [1];

    /* 結果マップ初期化 */
    const results = new Map();
    templates.forEach(t => results.set(t.id, { score: -Infinity, angle: 0, scale: 1, loc: { x: 0, y: 0 } }));

    /* テンプレートをグレースケール Mat に変換（事前に 1 回のみ） */
    const tplMats = templates.map(t => {
      const m = cv.imread(t.imageElement);
      const g = toGray(m);
      m.delete();
      return {
        id: t.id,
        mat: g,
        w:   t.imageElement.naturalWidth,
        h:   t.imageElement.naturalHeight,
      };
    });

    /* 入力画像をグレースケールに変換 */
    const fullSrc  = cv.imread(fullCanvas);
    const fullGray = toGray(fullSrc);
    fullSrc.delete();

    /* 角度リスト生成（0° を必ず含む） */
    const angles = [];
    if (angleRange === 0 || angleStep === 0) {
      angles.push(0);
    } else {
      for (let a = -angleRange; a <= angleRange + 1e-9; a += angleStep) {
        angles.push(Math.round(a * 1000) / 1000);
      }
    }

    /* 角度 × スケール ごとに入力を変換 → 全テンプレートに照合 */
    angles.forEach(angle => {
      const rotated = rotateMat(fullGray, angle);
      scaleFactors.forEach(f => {
        /* 入力を 1/f に縮小すると、f 倍で写った帳票が基準寸法のテンプレートと一致 */
        const scaled = (Math.abs(f - 1) < 1e-6) ? rotated : resizeMat(rotated, 1 / f);
        tplMats.forEach(tm => {
          const r   = runMatch(scaled, tm.mat);
          const cur = results.get(tm.id);
          if (r.score > cur.score) {
            /* 縮小画像上の loc を元の入力座標へ戻す（× f） */
            results.set(tm.id, { score: r.score, angle, scale: f, loc: { x: Math.round(r.loc.x * f), y: Math.round(r.loc.y * f) } });
          }
        });
        if (scaled !== rotated) scaled.delete();
      });
      rotated.delete();
    });

    /* クリーンアップ */
    fullGray.delete();
    tplMats.forEach(tm => tm.mat.delete());

    return results;
  }

  /* ── 結果可視化 ─────────────────────────────────────── */

  /**
   * フル画像上のマッチング位置に赤枠を描画したサムネイルキャンバスを返す。
   * 座標は回転補正前の元画像座標なので概算表示となる。
   *
   * @param {HTMLCanvasElement}      fullCanvas
   * @param {{ w:number, h:number }} templateSize  テンプレートの実寸
   * @param {{ x:number, y:number }} loc            マッチング位置 (rotated 座標)
   * @param {number}                 angle          採用された補正角度
   * @param {number}                 thumbWidth     サムネイル幅 px (default 160)
   * @returns {HTMLCanvasElement}
   */
  function drawMatchResult(fullCanvas, templateSize, loc, angle, thumbWidth = 160) {
    const scale  = thumbWidth / fullCanvas.width;
    const thumbH = Math.round(fullCanvas.height * scale);

    const thumb = document.createElement('canvas');
    thumb.width  = thumbWidth;
    thumb.height = thumbH;
    const ctx = thumb.getContext('2d', { willReadFrequently: true });

    ctx.drawImage(fullCanvas, 0, 0, thumbWidth, thumbH);

    /* バウンディングボックス */
    const bx = Math.round(loc.x * scale);
    const by = Math.round(loc.y * scale);
    const bw = Math.max(3, Math.round(templateSize.w * scale));
    const bh = Math.max(3, Math.round(templateSize.h * scale));

    ctx.strokeStyle = '#E53E3E';
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(bx, by, bw, bh);

    /* 補正角ラベル（補正あり時のみ） */
    if (Math.abs(angle) > 0.01) {
      const label = `${angle > 0 ? '+' : ''}${angle}°`;
      ctx.font         = 'bold 9px monospace';
      const tw         = ctx.measureText(label).width;
      ctx.fillStyle    = 'rgba(229,62,62,.85)';
      ctx.fillRect(bx, by - 13, tw + 6, 13);
      ctx.fillStyle    = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 3, by - 6);
    }

    return thumb;
  }

  /* ── Public API ─────────────────────────────────────── */
  return { matchAll, drawMatchResult };

})();
