/* ════════════════════════════════════════════════════════
   recognizer.js  認識パイプライン（OCR工程）
   Responsibility: 登録済み帳票に対する
     ① 全アンカー一括マッチング
     ② 帳票自動判定（FormVoting）
     ③ 傾き補正（回転）
     ④ 原点の再ローカライズ（平行移動量の確定）
     ⑤ 罫線除去（登録パラメータを引き継ぎ）
     ⑥ OCR領域ごとの認識
   を順に実行する。DOM は触らず、進捗は callback で通知する。
   ════════════════════════════════════════════════════════ */
'use strict';

const Recognizer = (() => {

  function dataURLtoImg(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload  = () => res(img);
      img.onerror = () => rej(new Error('画像の読み込みに失敗しました'));
      img.src = url;
    });
  }

  /** 帳票配列から「全アンカー」を matcher 用テンプレート配列へ展開（並列読み込み） */
  async function buildAnchorTemplates(forms) {
    const anchors = forms.flatMap(form => form.anchors || []);
    return Promise.all(anchors.map(async a => ({ id: a.id, imageElement: await dataURLtoImg(a.dataURL) })));
  }

  /* ── 幾何: 複数アンカーから軸ごとの拡大率＋平行移動を推定 ── */
  /**
   * 対応点 (ref → matched) から、回転なし・軸独立スケールの変換
   *   inX = sx*refX + tx,  inY = sy*refY + ty
   * を推定する（縦横比が違うスニップに対応）。傾きは別途補正済み。
   * 点が1組なら検出スケール f を sx=sy に採用（1点では縦横比を決められない）。
   * @param {Array<{refX,refY,inX,inY,scale}>} pairs
   * @returns {{ sx:number, sy:number, tx:number, ty:number, n:number }}
   */
  function estimateTransform(pairs) {
    const n = pairs.length;
    if (n === 0) return { sx: 1, sy: 1, tx: 0, ty: 0, n: 0 };
    if (n === 1) {
      const f = pairs[0].scale || 1;
      return { sx: f, sy: f, tx: pairs[0].inX - f * pairs[0].refX, ty: pairs[0].inY - f * pairs[0].refY, n: 1 };
    }
    /* x軸・y軸を独立に最小二乗回帰 */
    const lin = (gr, gi) => {
      let mr = 0, mi = 0; pairs.forEach(p => { mr += gr(p); mi += gi(p); }); mr /= n; mi /= n;
      let num = 0, den = 0; pairs.forEach(p => { const dr = gr(p) - mr, di = gi(p) - mi; num += dr * di; den += dr * dr; });
      let s = den > 1e-6 ? num / den : 1;
      if (!isFinite(s) || s < 0.5 || s > 2) s = 1;   // 異常値・分母過小はスケール1へ
      return { s, t: mi - s * mr };
    };
    const X = lin(p => p.refX, p => p.inX);
    const Y = lin(p => p.refY, p => p.inY);
    return { sx: X.s, sy: Y.s, tx: X.t, ty: Y.t, n };
  }

  /** 基準画像座標の矩形を軸独立スケール変換で入力画像座標へ写像 */
  function mapRect(region, tf) {
    return { x: tf.sx * region.x + tf.tx, y: tf.sy * region.y + tf.ty, w: tf.sx * region.w, h: tf.sy * region.h };
  }

  /** 抽出パターン（正規表現）を適用。group1があればそれ、無ければ全体。不一致は空。 */
  function applyPattern(text, pattern) {
    if (!pattern) return text;
    try {
      const m = text.match(new RegExp(pattern));
      if (!m) return '';
      return m[1] !== undefined ? m[1] : m[0];
    } catch (_) { return text; }   // 不正な正規表現はそのまま
  }

  /** 領域の文字制約から OCR の言語・ホワイトリストを決める（runOcr/comparePsm 共通）。
      英数字・記号のみの欄は英語モデル＋制限なし（後処理で整形）。それ以外は従来通り。 */
  function recogParamsFor(rule, fallbackLang, fallbackWhitelist) {
    const active = CharConstraint.isActive(rule);
    if (active && CharConstraint.isLatinOnly(rule)) {
      /* ⑤ engモデルでは字種whitelistがよく効く（数字1→漢字誤認で守れないjpnと異なる）。
         数字欄で "9,218"→"HWNgy~EN" のような英字誤読を根本から封じるため、
         導出したwhitelistをそのまま渡す。純数字の欄では桁区切り記号
         （, ， 空白 ¥ ￥ $）も許可し、Tesseractに記号として分類させたうえで
         後段のNUM_NOISE除去で落とす（記号を無理に数字化させないため）。 */
      const wl = CharConstraint.derivedWhitelist(rule);
      if (!wl) return { lang: 'eng', whitelist: '' };
      const pureDigit = [...wl].every(c => c >= '0' && c <= '9');
      return { lang: 'eng', whitelist: pureDigit ? wl + ',， ¥￥$' : wl };
    }
    return { lang: fallbackLang, whitelist: active ? (CharConstraint.derivedWhitelist(rule) || fallbackWhitelist) : fallbackWhitelist };
  }

  /** OCR結果の信頼度（単語別平均、空/0なら領域全体平均で補う）。 */
  function confOf(res) {
    if (res.error) return 0;
    const wordAvg = res.words.length ? res.words.reduce((s, w) => s + w.confidence, 0) / res.words.length : 0;
    return Math.round(wordAvg > 0 ? wordAvg : (res.confidence || 0));
  }

  /** 最終的な値の文字に対応する記号の確信度だけで平均を取る。
      ＝周辺のゴミ（領域に写り込んだ点・罫線片）で信頼度が下がるのを防ぐ。
      値の6割以上を記号に対応づけられたときのみ採用し、無理なら fallback。 */
  function valueConfidence(text, symbols, fallback) {
    if (!symbols || !symbols.length || !text) return fallback;
    const want = [...String(text)];
    let si = 0, sum = 0, matched = 0;
    for (const ch of want) {
      const up = ch.toUpperCase();
      let found = -1;
      for (let k = si; k < symbols.length; k++) {
        const st = symbols[k].text;
        if (st === ch || (st && st.toUpperCase() === up)) { found = k; break; }
      }
      if (found >= 0) { sum += symbols[found].confidence; matched++; si = found + 1; }
    }
    return (matched && matched >= Math.ceil(want.length * 0.6)) ? Math.round(sum / matched) : fallback;
  }

  /** 小さい切り出しは拡大してからOCR（Tesseractは文字が小さいと精度・信頼度が落ちる）。
      表示用の元画像は別に保持し、これはOCR入力専用。 */
  function upscaleForOcr(canvas, minH = 44, maxScale = 4) {
    const h = canvas.height || 0;
    if (h === 0 || h >= minH) return canvas;
    const scale = Math.min(maxScale, minH / h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * scale));
    c.height = Math.max(1, Math.round(canvas.height * scale));
    /* Tesseractがこの直後に画素を読み出すため、GPU→CPU転送を避ける */
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  /* ── OCR前処理: 二値化＋主要行の抽出（①②） ──────────────
     英数字・記号のみの「単一値」欄（金額・コード等）専用。切り出しに写り込んだ
     薄いゴースト行（罫線除去の残像・隣接行）を落とし、太字の値の行だけを
     Tesseractへ渡す。日本語欄・自由記述欄・複数行欄には適用しない
     （呼び出し側でゲート）。誤検出で精度を落とさないよう、退化ケース
     （ほぼ空白／ほぼ真っ黒／細い単一バンドのみ）では元キャンバスをそのまま返す。 */

  /** キャンバスを白地に合成したグレースケール輝度配列(0-255)へ変換 */
  function toGrayOverWhite(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8ClampedArray(w * h);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      const a = d[i + 3] / 255;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[p] = Math.round(lum * a + 255 * (1 - a));   // 透明画素は白地に合成
    }
    return gray;
  }

  /** 大津の二値化しきい値（クラス間分散最大化） */
  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (wB === 0) continue;
      const wF = total - wB; if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; thr = t; }
    }
    return thr;
  }

  /**
   * 単一値欄の切り出しを二値化し、主要な文字行（バンド）だけを残して返す。
   * 安全策として、判断がつかない／悪化しそうなケースでは元キャンバスを返す。
   * @param {HTMLCanvasElement} canvas
   * @returns {HTMLCanvasElement}
   */
  function preprocessSingleLine(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w < 3 || h < 3) return canvas;
    const gray = toGrayOverWhite(canvas);
    const thr  = otsuThreshold(gray);

    /* 行ごとのインク量（暗画素数）と総インク量 */
    const rowInk = new Int32Array(h);
    let totalInk = 0, maxRow = 0;
    for (let y = 0; y < h; y++) {
      let c = 0; const base = y * w;
      for (let x = 0; x < w; x++) if (gray[base + x] < thr) c++;
      rowInk[y] = c; totalInk += c;
      if (c > maxRow) maxRow = c;
    }
    const inkFrac = totalInk / (w * h);
    /* 退化: ほぼ空白／ほぼ真っ黒 → 触らない（現状の挙動を維持） */
    if (maxRow === 0 || inkFrac < 0.003 || inkFrac > 0.55) return canvas;

    /* 主要行バンドの検出（小さな行間の隙間は結合して1バンド扱い） */
    const rowThr   = Math.max(1, maxRow * 0.12);
    const mergeGap = Math.max(1, Math.round(h * 0.05));
    const bands = [];
    let cur = null, gap = 0;
    for (let y = 0; y < h; y++) {
      if (rowInk[y] >= rowThr) {
        if (!cur) cur = { top: y, bottom: y };
        cur.bottom = y; gap = 0;
      } else if (cur && ++gap > mergeGap) { bands.push(cur); cur = null; }
    }
    if (cur) bands.push(cur);
    if (!bands.length) return canvas;

    /* 各バンドの「濃さ」を評価する。罫線除去のゴースト行は淡い（グレー値が閾値
       付近）のに全幅に広がるため、インク総量では太字の値より大きくなり得る。
       総量ではなく暗画素の平均グレー値（小さいほど濃い）で選び、値の行を拾う。
       小さすぎるバンド（点ノイズ）は最大バンドの一定割合未満として除外する。 */
    let maxDark = 0;
    for (const b of bands) {
      let sum = 0, cnt = 0;
      for (let y = b.top; y <= b.bottom; y++) {
        const base = y * w;
        for (let x = 0; x < w; x++) { const g = gray[base + x]; if (g < thr) { sum += g; cnt++; } }
      }
      b.darkCount = cnt;
      b.meanGray  = cnt ? sum / cnt : 255;
      if (cnt > maxDark) maxDark = cnt;
    }
    const floor = Math.max(4, maxDark * 0.12);
    let best = null;
    for (const b of bands) {
      if (b.darkCount < floor) continue;                   // 点ノイズ相当は無視
      if (!best || b.meanGray < best.meanGray) best = b;    // 最も濃いバンド＝値の行
    }
    if (!best) return canvas;

    /* 上下に少しだけ余白を付けて切り出す */
    const pad    = Math.max(2, Math.round((best.bottom - best.top + 1) * 0.18));
    const top    = Math.max(0, best.top - pad);
    const bottom = Math.min(h - 1, best.bottom + pad);
    const bh     = bottom - top + 1;
    if (bh < 6) return canvas;   // 細すぎ＝ノイズの疑い。触らない

    /* 二値化（黒字・白地）しつつ主要バンドのみ描画 */
    const out = document.createElement('canvas');
    out.width = w; out.height = bh;
    const octx = out.getContext('2d', { willReadFrequently: true });
    const oimg = octx.createImageData(w, bh);
    for (let y = 0; y < bh; y++) {
      const srcBase = (top + y) * w, dstBase = y * w;
      for (let x = 0; x < w; x++) {
        const v = gray[srcBase + x] < thr ? 0 : 255;
        const o = (dstBase + x) * 4;
        oimg.data[o] = v; oimg.data[o + 1] = v; oimg.data[o + 2] = v; oimg.data[o + 3] = 255;
      }
    }
    octx.putImageData(oimg, 0, 0);
    return out;
  }

  /** 構造化された「英数字・記号のみの単一値」欄か。
      true の欄にだけ 二値化＋主要行抽出（①②）と PSM=単一行（③）を適用する。 */
  function isSingleValueField(rule) {
    return CharConstraint.isActive(rule) && CharConstraint.isLatinOnly(rule);
  }

  /** OCR入力キャンバスを構築する。単一値欄は前処理（①②）を挟み、それ以外は従来通り拡大のみ。 */
  function ocrInputCanvas(cropCanvas, single) {
    return upscaleForOcr(single ? preprocessSingleLine(cropCanvas) : cropCanvas);
  }

  /* PSM: 単一値欄は「単一テキスト行」(7) で読む（レイアウト解析の誤爆を避ける）。
     複数行になり得る一般欄は従来通りフォーム設定の PSM を使う。 */
  const SINGLE_LINE_PSM = 7;

  /**
   * マッチング + 自動判定のみを実行（採用前に結果を提示するため分離）。
   * @returns {{ decision, scores: Map, forms }}
   */
  /* 帳票判定用のスケール探索（切り取り倍率の違いに対応）。粗めで高速に
     （判定は帳票の選択が目的。精密な倍率は prepare 側で細かく探索する） */
  const CLASSIFY_SCALES = [0.85, 1.0, 1.15];
  /* 原点ローカライズ用（精密）。細かめに探索して位置精度を上げる */
  const LOCALIZE_SCALES = [0.8, 0.87, 0.93, 1.0, 1.07, 1.14, 1.22];

  async function classify(sourceCanvas, forms, opts = {}) {
    const angleRange = opts.angleRange ?? 2;
    const angleStep  = opts.angleStep  ?? 1;
    const scaleFactors = opts.scaleFactors || CLASSIFY_SCALES;
    const tpls   = await buildAnchorTemplates(forms);
    const scores = await MatcherEngine.matchAll(sourceCanvas, tpls, { angleRange, angleStep, scaleFactors });
    const decision = FormVoting.decide(forms, scores, opts.voting || {});
    return { decision, scores };
  }

  /**
   * 確定した帳票に対して 傾き補正 → 罫線除去 → OCR を実行する。
   * @param {HTMLCanvasElement} sourceCanvas
   * @param {object} form            採用された帳票レイアウト
   * @param {object} matchInfo       { angle, anchorId, loc } 判定結果の best
   * @param {object} cb              { onStage(name,pct), onOcr(i,total,name,status,pct) }
   * @returns {Promise<{
   *   angle, translation, resultCanvas, previewMats, fields:Array, error
   * }>}
   */
  /**
   * 傾き補正 → 原点再ローカライズ → 罫線除去 までを実行（OCR は行わない）。
   * PSM 比較など「同じ前処理結果に対して複数回 OCR したい」用途で再利用する。
   * @returns {Promise<{ angle, translation, resultCanvas, previewMats, error }>}
   */
  async function prepare(sourceCanvas, form, matchInfo, cb = {}) {
    const stage = (name, pct) => cb.onStage && cb.onStage(name, pct);
    const tPrepStart = performance.now();

    /* ③ 傾き補正 */
    stage('傾き補正', 0.1);
    const angle = matchInfo.angle || 0;
    const rotated = LineRemovalProcessor.rotateCanvas(sourceCanvas, angle);
    const tRotate = performance.now();

    /* ④ 原点の再ローカライズ: 全アンカーを角度固定で再マッチ → 相似変換を推定
       （複数アンカーが取れればスケール=拡大率と位置ずれを同時に補正） */
    stage('原点の確定', 0.25);
    const anchors = form.anchors || [];
    const allMatches = [];
    try {
      const tpls = await Promise.all(anchors.map(async a => ({ id: a.id, a, imageElement: await dataURLtoImg(a.dataURL) })));
      /* 角度固定・スケール探索で再マッチ（切り取り倍率の違いを吸収） */
      const m = await MatcherEngine.matchAll(rotated, tpls.map(t => ({ id: t.id, imageElement: t.imageElement })),
        { angleRange: 0, angleStep: 1, scaleFactors: LOCALIZE_SCALES });
      tpls.forEach(t => {
        const r = m.get(t.id); if (!r) return;
        const f = r.scale || 1;
        allMatches.push({
          refX: (t.a.refX || 0) + t.a.w / 2, refY: (t.a.refY || 0) + t.a.h / 2,         // 基準中心
          inX:  r.loc.x + t.a.w * f / 2,     inY:  r.loc.y + t.a.h * f / 2,             // 入力中心（スケール考慮）
          score: r.score, scale: f,
        });
      });
      allMatches.sort((a, b) => b.score - a.score);
    } catch (_) { /* 失敗時は恒等変換 */ }
    /* 信頼できる一致(>=0.4)で相似変換を推定。無ければ最良1点で best-effort */
    const good = allMatches.filter(p => p.score >= 0.4);
    let transform;
    if (good.length >= 1)        transform = estimateTransform(good);
    else if (allMatches.length)  transform = estimateTransform([allMatches[0]]);
    else                         transform = { sx: 1, sy: 1, tx: 0, ty: 0, n: 0 };
    const tLocalize = performance.now();

    /* 一致品質の診断: 基準画像と入力画像の縮尺が大きく違うと、ここでの探索
       （LOCALIZE_SCALES の範囲内）で真の倍率を捉えきれず、OCR領域の位置が
       ずれたまま気づかれない恐れがある。検出倍率が探索範囲の端に張り付いて
       いる／信頼できる一致が1つも無い場合は、呼び出し側で警告できるように
       フラグを返す（例: PDFの読み込みDPIが登録時と違いすぎるケース）。 */
    const usedMatches = good.length ? good : allMatches.slice(0, 1);
    const scaleMin = LOCALIZE_SCALES[0], scaleMax = LOCALIZE_SCALES[LOCALIZE_SCALES.length - 1];
    const matchQuality = {
      n: transform.n,
      bestScore: allMatches.length ? allMatches[0].score : 0,
      bestScale: allMatches.length ? allMatches[0].scale : 1,
      scaleEdge: usedMatches.some(p => p.scale <= scaleMin || p.scale >= scaleMax),
      weakMatch: !good.length,
    };

    /* ⑤ 罫線除去（登録された罫線除去パラメータを引き継ぎ） */
    stage('罫線除去', 0.45);
    const params = form.lineRemoval || LineRemovalProcessor.defaultParams();
    const proc   = LineRemovalProcessor.process(rotated, params);
    const tLineRemoval = performance.now();
    console.log(`[perf]   prepare: rotate=${(tRotate - tPrepStart).toFixed(0)}ms localize(anchor${anchors.length})=${(tLocalize - tRotate).toFixed(0)}ms lineRemoval=${(tLineRemoval - tLocalize).toFixed(0)}ms`);
    if (proc.error) {
      LineRemovalProcessor.cleanupMats(proc.mats);
      return { angle, transform, resultCanvas: null, previewMats: [], error: proc.error, matchQuality };
    }
    /* mats[3] = 罫線除去結果。OCR 入力用に独立キャンバスへ描画 */
    const resultCanvas = document.createElement('canvas');
    const resMat = proc.mats[3];
    resultCanvas.width  = resMat.cols;
    resultCanvas.height = resMat.rows;
    /* renderToCanvas内部はcv.imshowで初めてこのcanvasにgetContext('2d')するため、
       このcanvasはOCR領域ごとに何度も切り出し(drawImage)で読み出される最重要の
       中間結果でもある。cv.imshowより先にここで一度getContextしてオプションを
       固定しておく（canvasの2Dコンテキストは最初の生成時のオプションが以後も
       維持されるため、後からcv.imshowが素のgetContext('2d')を呼んでも上書きされない）。 */
    resultCanvas.getContext('2d', { willReadFrequently: true });
    LineRemovalProcessor.renderToCanvas(resMat, resultCanvas);

    return { angle, transform, resultCanvas, previewMats: proc.mats, error: null, matchQuality };
  }

  async function runOcr(sourceCanvas, form, matchInfo, opts = {}, cb = {}) {
    const stage = (name, pct) => cb.onStage && cb.onStage(name, pct);

    const prep = await prepare(sourceCanvas, form, matchInfo, cb);
    if (prep.error) {
      return { angle: prep.angle, transform: prep.transform, resultCanvas: null, previewMats: [], fields: [], error: prep.error, matchQuality: prep.matchQuality };
    }
    const { angle, transform, resultCanvas } = prep;

    /* ⑥ OCR領域ごとに認識 */
    const regions = form.ocrRegions || [];
    const psm  = form.ocrSettings?.psm ?? 3;
    const lang = form.ocrSettings?.lang || 'eng';
    const whitelist = form.ocrSettings?.whitelist || '';
    const doNorm = form.ocrSettings?.normalize !== false;   // 既定で正規化ON
    const doKanji = !!form.ocrSettings?.normalizeKanji;      // 漢数字→数字（既定OFF）

    /* 各領域の認識方針を決定。
       文字制約が英数字・記号だけ（日本語不要）の欄は英語モデルで認識する。
       日本語モデルは数字「1」を「一」と誤認しやすく、ホワイトリストでも
       抑えきれない（LSTMが守らない）ため。英語＋後処理（補正/抽出）が高精度。 */
    const plan = regions.map(region => {
      const rule = region.charRule || region.constraint;
      const p = recogParamsFor(rule, lang, whitelist);
      const single = isSingleValueField(rule);   // 単一値欄は前処理＋単一行PSM
      return { region, rule, active: CharConstraint.isActive(rule), single, lang: p.lang, whitelist: p.whitelist, psm: single ? SINGLE_LINE_PSM : psm };
    });
    /* 言語切替（worker再初期化）を最小化するため同一言語をまとめて処理する */
    const order = plan.map((_, i) => i).sort((a, b) => (plan[a].lang < plan[b].lang ? -1 : plan[a].lang > plan[b].lang ? 1 : 0));
    const fields = new Array(regions.length);
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi];
      const { region, rule, active, single, lang: useLang, whitelist: useWl, psm: usePsm } = plan[i];
      stage(`OCR ${oi + 1}/${regions.length}`, 0.55 + 0.4 * (oi / Math.max(1, regions.length)));
      const cropCanvas = LineRemovalProcessor.extractRect(resultCanvas, mapRect(region, transform));
      if (!cropCanvas) {
        fields[i] = { name: region.name, globalName: region.globalName || region.name, text: '', confidence: 0, error: '領域の切り出しに失敗しました' };
        continue;
      }
      const tFieldStart = performance.now();
      /* 実際にTesseractへ渡す画像。診断表示（切り出し画像との比較）用に保持する */
      const inputCanvas = ocrInputCanvas(cropCanvas, single);
      const res = await OcrProcessor.recognize(inputCanvas, usePsm, prog => {
        cb.onOcr && cb.onOcr(oi, regions.length, region.name, prog.status, prog.progress);
      }, useLang, useWl);
      /* 言語がページ間・領域間で切り替わるとTesseractの言語データ再読み込みが走り
         大幅に遅くなることがあるため、領域ごとの所要時間と使用言語を記録する。 */
      console.log(`[perf]   OCR "${region.name}" lang=${useLang} ${(performance.now() - tFieldStart).toFixed(0)}ms`);
      let text = (res.fullText || '').trim();
      if (doNorm) text = OcrProcessor.normalize(text);
      if (doKanji) text = OcrProcessor.kanjiToNum(text);
      const raw = text;
      if (region.pattern) text = applyPattern(text, region.pattern);   // 期待書式で抽出
      /* 文字制約による桁別チェック＋誤認補正（O↔0 等）＋前後の余分文字除去 */
      let constraintValid = true;
      if (active) { const cc = CharConstraint.apply(text, rule); text = cc.text; constraintValid = cc.valid; }
      /* 信頼度は「最終的な値の文字」基準（周辺のゴミで下がらないように） */
      const conf = valueConfidence(text, res.symbols, confOf(res));
      fields[i] = {
        name: region.name,
        globalName: region.globalName || region.name,
        text,
        raw,
        confidence: conf,
        error: res.error || null,
        constraint: active ? CharConstraint.describe(rule) : '',
        constraintValid,
        symbols: res.symbols || [],
        cropDataURL: cropCanvas.toDataURL('image/png'),
        /* 診断: 実際にOCRへ渡した画像（前処理後）と使用パラメータ。
           前処理が効いたか／ゴーストが除けたかを目視で確認できるようにする。 */
        ocrInputDataURL: inputCanvas.toDataURL('image/png'),
        ocrInfo: { preprocessed: single, psm: usePsm, lang: useLang, whitelist: useWl },
      };
    }

    stage('完了', 1);
    return { angle, transform, resultCanvas, previewMats: prep.previewMats, fields, error: null, matchQuality: prep.matchQuality };
  }

  /**
   * 1 領域に対して複数 PSM で OCR を試し、結果を比較する。
   * @param {HTMLCanvasElement} resultCanvas  prepare() で得た罫線除去後キャンバス
   * @param {{x,y}} translation
   * @param {object} region    { name, x, y, w, h }
   * @param {number[]} psmList
   * @param {string} lang
   * @param {Function} onProg  (idx, total, psm) => void
   * @returns {Promise<Array<{ psm, text, confidence, error }>>}
   */
  async function comparePsm(resultCanvas, transform, region, psmList, opts, onProg) {
    const { lang = 'eng', whitelist = '', normalize = true, kanji = false } = opts || {};
    /* 領域の文字制約を PSM 比較にも反映（本認識と同じ言語・字種判定を使用） */
    const rule = region.charRule || region.constraint;
    const ruleActive = CharConstraint.isActive(rule);
    const single = isSingleValueField(rule);   // 本認識と同じ前処理を比較にも反映
    const { lang: useLang, whitelist: regWhitelist } = recogParamsFor(rule, lang, whitelist);
    const crop = LineRemovalProcessor.extractRect(resultCanvas, mapRect(region, transform));
    /* 前処理結果は PSM に依らず同一なので一度だけ構築して使い回す */
    const input = crop ? ocrInputCanvas(crop, single) : null;
    const out = [];
    for (let i = 0; i < psmList.length; i++) {
      const psm = psmList[i];
      if (onProg) onProg(i, psmList.length, psm);
      if (!crop) { out.push({ psm, text: '', confidence: 0, error: '領域切り出し失敗' }); continue; }
      const res = await OcrProcessor.recognize(input, psm, () => {}, useLang, regWhitelist);
      const conf = confOf(res);
      let text = (res.fullText || '').trim();
      if (normalize) text = OcrProcessor.normalize(text);
      if (kanji) text = OcrProcessor.kanjiToNum(text);
      if (region.pattern) text = applyPattern(text, region.pattern);
      if (ruleActive) text = CharConstraint.apply(text, rule).text;
      out.push({ psm, text, confidence: conf, error: res.error || null });
    }
    return out;
  }

  return { classify, prepare, runOcr, comparePsm, mapRect, dataURLtoImg };

})();
