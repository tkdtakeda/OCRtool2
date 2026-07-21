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

  /* matchTemplate は画素数にほぼ比例して遅くなる。高DPIスキャンやカメラ写真
     （数千px級）をそのまま 角度×倍率×アンカー数 分繰り返すと致命的に遅くなる
     ため、探索は長辺 MAX_WORKING_DIM 以下に縮小した画像で行い、結果座標のみ
     原寸へ戻す（テンプレート自体は縮小しない＝既存の scaleFactors 探索と同じ
     考え方で、入力側だけを縮めるので精度への影響は小さい）。 */
  const MAX_WORKING_DIM = 1800;

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
  /* 角度×スケールの組ごとに一度だけイベントループへ制御を返す。
     matchAllは角度×スケール×テンプレート数ぶんcv.matchTemplateを呼ぶ完全同期処理で、
     その間ずっとメインスレッドを専有すると、クリック/キー入力が処理されず
     ブラウザが固まって見える（DevTools計測で「Input delay」が長時間・
     「Processing duration」がほぼ0として現れる状態）。

     ただし setTimeout(0) は【非表示タブで重度にスロットリングされる】。Chromeは
     バックグラウンドで最短1秒、数分放置すると最悪1回/分まで間引くため、一括処理を
     裏に回して離席すると、matchAll が譲るたびに数十秒〜数分寝かされ、1回の classify
     が数百秒に膨れ上がる（実測 classify=528秒。実演算は数秒）。
     対策:
      ・表示中は setTimeout(0) で譲り、クリック/キー入力の応答性(INP)を確保する。
      ・非表示中は応答性が不要なので、スロットルされないマイクロタスクで即時に継続し
        全速で回す（PDFラスタライズやOCRワーカ待ちなど本来の await では通常どおり
        マクロタスクへ譲るため、ワーカのメッセージ処理は妨げない）。 */
  const yieldToUI = () =>
    (typeof document !== 'undefined' && document.hidden)
      ? Promise.resolve()
      : new Promise(resolve => setTimeout(resolve, 0));

  /* 1タスクの上限時間（ms）。これを超えたらテンプレートの途中でも制御を返す。
     matchTemplate 単体は分割できないので、実質「予算 + 直近1回の照合時間」が
     1タスクの長さ＝入力遅延(INP)の上限になる。約2フレーム。 */
  const YIELD_BUDGET_MS = 32;

  async function matchAll(fullCanvas, templates, opts = {}) {
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
    const fullSrc      = cv.imread(fullCanvas);
    const fullGrayFull = toGray(fullSrc);
    fullSrc.delete();

    /* 大きすぎる入力は探索用に縮小（結果座標は最後に原寸へ戻す） */
    const longSide  = Math.max(fullGrayFull.cols, fullGrayFull.rows);
    const workScale = longSide > MAX_WORKING_DIM ? MAX_WORKING_DIM / longSide : 1;
    const fullGray  = workScale < 1 ? resizeMat(fullGrayFull, workScale) : fullGrayFull;
    if (workScale < 1) fullGrayFull.delete();

    /* 角度リスト生成（0° を必ず含む） */
    const angles = [];
    if (angleRange === 0 || angleStep === 0) {
      angles.push(0);
    } else {
      for (let a = -angleRange; a <= angleRange + 1e-9; a += angleStep) {
        angles.push(Math.round(a * 1000) / 1000);
      }
    }

    /* 角度 × スケール ごとに入力を変換 → 全テンプレートに照合。
       アンカー数が多い帳票では1回の角度×スケールでも同期時間が長くなり、その間の
       クリック/キー入力が遅延する（Input delayが長い状態）。テンプレート1件ごとに
       時間予算を見て、超えたら途中でも制御を返す。処理順・結果は不変で、純粋に
       スケジューリングだけを細かくするため精度への影響は一切ない。 */
    let lastYield = performance.now();
    for (const angle of angles) {
      const rotated = rotateMat(fullGray, angle);
      for (const f of scaleFactors) {
        /* 入力を 1/f に縮小すると、f 倍で写った帳票が基準寸法のテンプレートと一致 */
        const scaled = (Math.abs(f - 1) < 1e-6) ? rotated : resizeMat(rotated, 1 / f);
        for (const tm of tplMats) {
          const r   = runMatch(scaled, tm.mat);
          const cur = results.get(tm.id);
          if (r.score > cur.score) {
            /* 縮小探索画像上の loc を原寸入力座標へ戻す（f: 倍率探索分 ÷ workScale: 探索縮小分） */
            results.set(tm.id, { score: r.score, angle, scale: f, loc: { x: Math.round(r.loc.x * f / workScale), y: Math.round(r.loc.y * f / workScale) } });
          }
          if (performance.now() - lastYield >= YIELD_BUDGET_MS) { await yieldToUI(); lastYield = performance.now(); }
        }
        if (scaled !== rotated) scaled.delete();
      }
      rotated.delete();
    }

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
