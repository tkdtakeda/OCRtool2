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

  /** 中央値（外れ値に強い代表値） */
  function median(arr) {
    if (!arr.length) return 1;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* 位置回帰で倍率を信頼するために必要な、基準座標上のアンカーの最小広がり(px)。
     アンカーが密集していると、数pxの検出誤差が大きな倍率誤差に化け、それが切片
     （＝平行移動 tx,ty）へ伝播して、離れた欄ほど位置がずれる。「同一倍率で平行移動
     しただけ」の帳票が追随しない主因がこれ。広がりが足りない軸では位置回帰の倍率を
     使わず、各アンカーの照合倍率の中央値を採用し、平行移動だけを頑健に推定する。 */
  const MIN_SPAN_FOR_SCALE = 200;

  /* ── 幾何: 複数アンカーから軸ごとの拡大率＋平行移動を推定 ── */
  /**
   * 対応点 (ref → matched) から、回転なし・軸独立スケールの変換
   *   inX = sx*refX + tx,  inY = sy*refY + ty
   * を推定する（縦横比が違うスニップに対応）。傾きは別途補正済み。
   * 点が1組なら検出スケール f を sx=sy に採用（1点では縦横比を決められない）。
   * 複数でもアンカーが密集する軸は、倍率を照合倍率の中央値に固定し、位置回帰の
   * 不安定な倍率が平行移動を壊さないようにする。
   *
   * 回帰は各点のスコア(score)で加重する。「他帳票との識別性を上げるため広く取った
   * アンカー」は、その広さゆえページ内の局所的な印刷ズレ（罫線幅の微差・紙送りの
   * 個体差等）の影響を受けやすく、一致位置がスコアはそこそこでも微妙にずれた
   * 「妥協点」になりやすい。「位置合わせ用に狭く正確に取ったアンカー」と一緒に
   * 登録した場合、加重により後者（通常スコアが高い）の影響を強くし、前者の
   * 位置ノイズに引きずられにくくする。役割別にアンカー種別を分けなくても、
   * 広い識別用アンカー＋狭い精密アンカーを両方登録するだけで自然に機能する。
   * @param {Array<{refX,refY,inX,inY,scale,score}>} pairs
   * @returns {{ sx:number, sy:number, tx:number, ty:number, n:number }}
   */
  function estimateTransform(pairs) {
    const n = pairs.length;
    if (n === 0) return { sx: 1, sy: 1, tx: 0, ty: 0, n: 0 };
    if (n === 1) {
      const f = pairs[0].scale || 1;
      return { sx: f, sy: f, tx: pairs[0].inX - f * pairs[0].refX, ty: pairs[0].inY - f * pairs[0].refY, n: 1 };
    }
    /* 照合倍率の中央値（探索は 0.6〜2.0 と広く、密集アンカーでも安定して得られる） */
    const medScale = median(pairs.map(p => p.scale || 1));
    /* 加重は score をそのまま使う（呼び出し側は score>=0.4 のみを渡すため、常に正）。
       スコア差を過度に増幅しないよう線形のまま用いる。 */
    const weights = pairs.map(p => Math.max(1e-3, p.score || 0));
    const wSum = weights.reduce((a, b) => a + b, 0);
    /* 軸ごと: 広がりが十分なら加重位置回帰で連続倍率を精密化、狭ければ照合倍率を採用。
       平行移動は採用倍率 s を固定して t = 加重平均(in - s*ref)（＝回帰の切片と同値だが、
       倍率誤差から切り離した頑健な平行移動になる）。 */
    const axis = (gr, gi) => {
      let mr = 0, mi = 0, lo = Infinity, hi = -Infinity;
      pairs.forEach((p, i) => { const r = gr(p); mr += weights[i] * r; mi += weights[i] * gi(p); if (r < lo) lo = r; if (r > hi) hi = r; });
      mr /= wSum; mi /= wSum;
      let s = medScale;
      if ((hi - lo) >= MIN_SPAN_FOR_SCALE) {
        let num = 0, den = 0;
        pairs.forEach((p, i) => { const dr = gr(p) - mr, di = gi(p) - mi; num += weights[i] * dr * di; den += weights[i] * dr * dr; });
        const sReg = den > 1e-6 ? num / den : NaN;
        if (isFinite(sReg) && sReg >= 0.4 && sReg <= 2.5) s = sReg;   // 十分広い＝位置回帰を信頼
      }
      return { s, t: mi - s * mr };
    };
    const X = axis(p => p.refX, p => p.inX);
    const Y = axis(p => p.refY, p => p.inY);
    return { sx: X.s, sy: Y.s, tx: X.t, ty: Y.t, n };
  }

  /** 基準画像座標の矩形を軸独立スケール変換で入力画像座標へ写像 */
  function mapRect(region, tf) {
    return { x: tf.sx * region.x + tf.tx, y: tf.sy * region.y + tf.ty, w: tf.sx * region.w, h: tf.sy * region.h };
  }

  /* ── 局所アンカー: 欄ごとに近いアンカーを重く使って位置決め（移動最小二乗の考え方）──
     1枚に1つの全体変換だと、アンカーがページ上部などに偏っている場合、下部の欄が
     「外挿」になり、わずかな倍率誤差（例: 98%）が距離ぶん増幅されて1行ぶん等の大きな
     ズレになる（支払金額の枠が値でなく1行上のラベルに乗る、等）。欄ごとに近傍アンカーを
     重くした変換を使えば、アンカーが偏っていても各欄は最寄りアンカー基準で合う。
     近傍に寄り過ぎて倍率が不安定にならないよう、遠いアンカーにも 1/(1+(d/L)^2) で滑らかに
     重みを残す（アンカー1点や全点同一位置など退化時は全体変換へフォールバック）。 */
  function transformForRegion(anchorPoints, region, globalTf) {
    if (!anchorPoints || anchorPoints.length < 2) return globalTf || { sx: 1, sy: 1, tx: 0, ty: 0, n: anchorPoints ? anchorPoints.length : 0 };
    const cx = region.x + region.w / 2, cy = region.y + region.h / 2;
    let lo = Infinity, hi = -Infinity, loY = Infinity, hiY = -Infinity;
    anchorPoints.forEach(p => { if (p.refX < lo) lo = p.refX; if (p.refX > hi) hi = p.refX; if (p.refY < loY) loY = p.refY; if (p.refY > hiY) hiY = p.refY; });
    /* 近傍の長さスケール = アンカー分布の広がりの半分。0広がり（全点同一位置）は全体変換へ */
    const spread = Math.hypot(hi - lo, hiY - loY);
    if (spread < 1) return globalTf;
    const L = 0.5 * spread;
    const weighted = anchorPoints.map(p => {
      const dx = p.refX - cx, dy = p.refY - cy, d = Math.hypot(dx, dy);
      const prox = 1 / (1 + (d / L) * (d / L));
      return { ...p, score: Math.max(1e-3, (p.score || 0.5)) * prox };   // 既存のscore加重に近接度を乗せる
    });
    const tf = estimateTransform(weighted);
    return (tf && isFinite(tf.sx) && isFinite(tf.tx)) ? tf : globalTf;
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
   * 単一値欄の切り出しから、ゴースト行・上下の空白マージンを削って値の行だけを返す。
   * 【ハード二値化はしない】。小さい切り出しを拡大してから0/1に叩き切ると、元の
   * なめらかな階調（アンチエイリアス）が失われてブロック状になり、かえってTesseractの
   * 精度が落ちる（＝「元画像の方がきれい」な状態）。二値化はTesseract内部（大津）に
   * 任せ、ここでは行トリムのみ行い、拡大済みグレースケールをそのまま渡す。
   * トリム判定にだけ大津しきい値を使う。悪化しそうな退化ケースは元キャンバスを返す。
   * @param {HTMLCanvasElement} canvas  （呼び出し側で拡大済み）
   * @returns {HTMLCanvasElement}
   */
  function preprocessSingleLine(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w < 3 || h < 3) return canvas;
    const gray = toGrayOverWhite(canvas);
    const thr  = otsuThreshold(gray);   // 行トリムの判定にのみ使用（出力は二値化しない）

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

    /* 上下の空白マージン＆淡いゴースト行を削る。「値の行」を推定して1行だけ残す方式は、
       ゴースト（薄いヘッダー行）を値と誤認して数字ごと切り落とす事故が起きるため採らない。
       インクのある範囲は全て残す＝数字を絶対に落とさない。淡いゴーストはしきい値以下で
       インクに数えられずトリム範囲から自然に外れる。濃く残るヘッダー等は残るが、数字欄は
       whitelist（数字のみ許可）で数字以外を出力しないため実害が出ない。 */
    const rowThr = Math.max(1, maxRow * 0.08);
    let top = 0;        while (top < h && rowInk[top] < rowThr) top++;
    let bottom = h - 1; while (bottom > top && rowInk[bottom] < rowThr) bottom--;
    if (top > bottom) return canvas;
    top    = Math.max(0, top - 2);
    bottom = Math.min(h - 1, bottom + 2);
    const bh = bottom - top + 1;
    if (bh < 6 || bh >= h) return canvas;   // 実質空／トリム余地なし → そのまま（拡大済みグレーを返す）

    /* トリム範囲を「グレースケールのまま」切り出す（二値化しない）。白地に合成して
       透明を潰す。drawImageの補間で元のなめらかなエッジが保たれる。 */
    const out = document.createElement('canvas');
    out.width = w; out.height = bh;
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.fillStyle = '#fff'; octx.fillRect(0, 0, w, bh);
    octx.drawImage(canvas, 0, top, w, bh, 0, 0, w, bh);
    return out;
  }

  /** 構造化された「英数字・記号のみの単一値」欄か。
      true の欄にだけ 行トリム＋拡大（①④）と PSM=ブロック（③）を適用する。 */
  function isSingleValueField(rule) {
    return CharConstraint.isActive(rule) && CharConstraint.isLatinOnly(rule);
  }

  /** OCR入力キャンバスを構築する。
      単一値欄は ④ グレースケールのまま拡大（滑らかな補間）→ 行トリム（ゴースト除去）。
      ハード二値化はしない（拡大後に0/1へ叩き切るとブロック状になり精度が落ちるため。
      二値化はTesseract内部の大津に任せる）。それ以外の欄は従来通り拡大のみ。 */
  function ocrInputCanvas(cropCanvas, single) {
    if (single) return preprocessSingleLine(upscaleForOcr(cropCanvas, SINGLE_TARGET_H, SINGLE_MAX_SCALE));
    return upscaleForOcr(cropCanvas);
  }

  /* PSM: 単一値欄は「単一の均一ブロック」(6) で読む。単一行(7)は最上行だけを読むため、
     ゴーストのヘッダー行が上に残ると値（下段の数字）を取りこぼす。6なら全行を読み、
     数字以外はwhitelistで落ちるので値だけが残る。一般欄は従来通りフォーム設定のPSM。 */
  const SINGLE_LINE_PSM = 6;

  /* ④ 単一値欄の拡大目標。Tesseractは字形が小さいと 9↔G / 0↔O / 1↔I などの
     微妙な取り違えを起こしやすい。行の高さがこの値に満たない切り出しだけを拡大して
     認識する（最大 SINGLE_MAX_SCALE 倍）。
     ※目標高さは「Tesseractに十分な大きさ」に留める。高DPI（例:400dpi）で切り出しが
       既に十分大きい場合に更に拡大すると、補間で字がボケ・太り、桁区切りの「,」や
       字間のノイズが数字に化ける誤読（例: 220,803→2920803）を招く。よって目標は
       48px程度とし、十分大きい切り出しは拡大せずそのまま渡す（低DPIの小さい切り出し
       だけを控えめに底上げする）。 */
  const SINGLE_TARGET_H = 48;
  const SINGLE_MAX_SCALE = 4;

  /**
   * マッチング + 自動判定のみを実行（採用前に結果を提示するため分離）。
   * @returns {{ decision, scores: Map, forms }}
   */
  /* 帳票判定用のスケール探索（切り取り倍率の違いに対応）。粗めで高速に
     （判定は帳票の選択が目的。精密な倍率は prepare 側で細かく探索する） */
  const CLASSIFY_SCALES = [0.85, 1.0, 1.15];
  /* 原点ローカライズ用（粗・広）。拡大/縮小された帳票も取りこぼさないよう 0.6〜2.0 を
     幾何級数的に並べる。従来は 0.8〜1.22（±22%）しか無く、それ以上拡大された帳票で
     倍率が範囲端に張り付き、アンカーから離れたOCR欄ほど位置がずれていた。
     真の倍率は後段の細探索(fineScalesAround)と、複数アンカーの相対位置
     (estimateTransform) で詰める。 */
  const LOCALIZE_SCALES = [0.6, 0.71, 0.85, 1.0, 1.19, 1.42, 1.68, 2.0];
  /* 暫定倍率の周辺を細かく探索（±9%を3%刻み）。粗ステップの隙間を埋め、単一アンカー
     でも位置精度を確保する。複数アンカーがあれば相対位置でさらに精密化される。 */
  const fineScalesAround = s => [0.91, 0.94, 0.97, 1.0, 1.03, 1.06, 1.09]
    .map(k => Math.max(0.4, Math.min(2.5, Math.round(s * k * 1000) / 1000)));

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
    const rotated = await LineRemovalProcessor.rotateCanvas(sourceCanvas, angle);
    const tRotate = performance.now();

    /* ④ 原点の再ローカライズ: 全アンカーを角度固定で再マッチ → 相似変換を推定
       （複数アンカーが取れればスケール=拡大率と位置ずれを同時に補正） */
    stage('原点の確定', 0.25);
    const anchors = form.anchors || [];
    const allMatches = [];
    try {
      const tpls = await Promise.all(anchors.map(async a => ({ id: a.id, a, imageElement: await dataURLtoImg(a.dataURL) })));
      const tplList = tpls.map(t => ({ id: t.id, imageElement: t.imageElement }));
      /* 粗→細のスケール探索で「拡大・縮小された帳票」を正しく捉える。
         ① 粗く広い範囲(0.6〜2.0)でアンカーを発見し、最良スコアの倍率を暫定採用。
         ② その暫定倍率の周辺(±6%)を細かく再探索し、位置精度を上げる。
         狭い固定範囲だと大きく拡大された帳票でアンカーを取り逃がすか倍率が範囲端に
         張り付き、離れたOCR欄ほどずれていた。細探索を角度固定・少数スケールで足すだけ
         なので追加コストは小さい。 */
      const coarse = await MatcherEngine.matchAll(rotated, tplList,
        { angleRange: 0, angleStep: 1, scaleFactors: LOCALIZE_SCALES });
      let provScale = 1, provBest = -Infinity;
      tpls.forEach(t => { const r = coarse.get(t.id); if (r && r.score > provBest) { provBest = r.score; provScale = r.scale || 1; } });
      const fine = await MatcherEngine.matchAll(rotated, tplList,
        { angleRange: 0, angleStep: 1, scaleFactors: fineScalesAround(provScale) });
      tpls.forEach(t => {
        const rc = coarse.get(t.id), rf = fine.get(t.id);
        const r = (rf && (!rc || rf.score >= rc.score)) ? rf : rc;   // 粗・細で高スコア側を採用
        if (!r) return;
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
    /* 局所アンカー位置決め用の対応点（信頼できる一致が2点以上あるときだけ）。 */
    const anchorPoints = good.length >= 2 ? good : null;
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
    const proc   = await LineRemovalProcessor.process(rotated, params);
    const tLineRemoval = performance.now();
    console.log(`[perf]   prepare: rotate=${(tRotate - tPrepStart).toFixed(0)}ms localize(anchor${anchors.length})=${(tLocalize - tRotate).toFixed(0)}ms lineRemoval=${(tLineRemoval - tLocalize).toFixed(0)}ms`);
    if (proc.error) {
      LineRemovalProcessor.cleanupMats(proc.mats);
      return { angle, transform, anchorPoints, resultCanvas: null, previewMats: [], error: proc.error, matchQuality };
    }
    /* mats[3] = 罫線除去結果（サーバーから受け取り済みのcanvas）。OCR 入力用に
       独立キャンバスへ描画 */
    const resultCanvas = document.createElement('canvas');
    const resMat = proc.mats[3];
    resultCanvas.width  = resMat.width;
    resultCanvas.height = resMat.height;
    /* このcanvasはOCR領域ごとに何度も切り出し(drawImage)で読み出される最重要の
       中間結果のため、最初の生成時にwillReadFrequentlyを固定しておく（canvasの
       2Dコンテキストは最初のgetContext呼び出しのオプションが以後も維持されるため、
       後段のrenderToCanvas内のgetContextで上書きされないよう先に確定させる）。 */
    resultCanvas.getContext('2d', { willReadFrequently: true });
    LineRemovalProcessor.renderToCanvas(resMat, resultCanvas);

    return { angle, transform, anchorPoints, resultCanvas, previewMats: proc.mats, error: null, matchQuality };
  }

  async function runOcr(sourceCanvas, form, matchInfo, opts = {}, cb = {}) {
    const stage = (name, pct) => cb.onStage && cb.onStage(name, pct);

    const prep = await prepare(sourceCanvas, form, matchInfo, cb);
    if (prep.error) {
      return { angle: prep.angle, transform: prep.transform, anchorPoints: prep.anchorPoints, resultCanvas: null, previewMats: [], fields: [], error: prep.error, matchQuality: prep.matchQuality };
    }
    const { angle, transform, anchorPoints, resultCanvas } = prep;

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
      /* 欄ごとに近傍アンカーを重く使った局所変換で切り出す（全体変換への安全なフォールバック付き） */
      const cropCanvas = LineRemovalProcessor.extractRect(resultCanvas, mapRect(region, transformForRegion(anchorPoints, region, transform)));
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
      /* 単一値欄でTesseractが複数行として認識した場合（PSM=6は罫線除去の
         ゴースト行を別行として拾うことがある）、最も確信度の高い行だけを採用する。
         whitelistの制約でノイズも数字として出力され得るため、行同士を連結した
         "051\n8558" のような値をそのまま出さないための対策。複数値を許容する
         一般欄はこれまで通りfullTextをそのまま使う。 */
      if (single && res.lines && res.lines.length > 1) {
        const best = res.lines.reduce((a, b) => (b.confidence > a.confidence ? b : a));
        text = best.text;
      }
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
           前処理が効いたか／ゴーストが除けたかを目視で確認できるようにする。
           前処理を通す単一値欄のみPNG化する（他欄は元切り出しとほぼ同一で無駄なため）。 */
        ocrInputDataURL: single ? inputCanvas.toDataURL('image/png') : null,
        ocrInfo: { preprocessed: single, psm: usePsm, lang: useLang, whitelist: useWl },
      };
    }

    stage('完了', 1);
    return { angle, transform, anchorPoints, resultCanvas, previewMats: prep.previewMats, fields, error: null, matchQuality: prep.matchQuality };
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
      /* 本認識(runOcr)と同じ「単一値欄は最も確信度の高い行を採用」を比較にも反映する */
      if (single && res.lines && res.lines.length > 1) {
        const best = res.lines.reduce((a, b) => (b.confidence > a.confidence ? b : a));
        text = best.text;
      }
      if (normalize) text = OcrProcessor.normalize(text);
      if (kanji) text = OcrProcessor.kanjiToNum(text);
      if (region.pattern) text = applyPattern(text, region.pattern);
      if (ruleActive) text = CharConstraint.apply(text, rule).text;
      out.push({ psm, text, confidence: conf, error: res.error || null });
    }
    return out;
  }

  return { classify, prepare, runOcr, comparePsm, mapRect, transformForRegion, dataURLtoImg };

})();
