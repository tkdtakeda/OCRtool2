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

  /** 帳票配列から「帳票判定に使うアンカー」を matcher 用テンプレート配列へ展開（並列読み込み）。
     「位置合わせのみ」の役割のアンカーは、他帳票への誤マッチで判定を狂わせるのを避ける
     ため除外する。除外したぶん照合するテンプレート数が減るので、一番重い classify の
     速度にもプラス（照合回数はテンプレート数に正比例する）。 */
  async function buildAnchorTemplates(forms) {
    const anchors = forms.flatMap(form => (form.anchors || []).filter(AnchorRoles.usedForClassify));
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

  /* 位置回帰で得た倍率を採用するために、各アンカーが自力で検出した倍率の中央値と
     どこまで一致していればよいか（相対値）。
     位置回帰はアンカー間の「位置の差」から倍率を出すため、1点でも別の場所（帳票は
     似た四角が多く、罫線の交点や枠は互いに見分けが付きにくい）へ誤マッチすると倍率が
     大きく振れる。実測で 54%×96% という、紙では起こり得ない異方性が出た。
     一方、各アンカーはテンプレート探索で自分の倍率を独立に検出しており、その中央値は
     3点中1点の誤りには汚染されない。両者が食い違うときは回帰ではなく中央値を採る。
     許容を15%と広めに取っているのは、探索格子（細探索で±9%を3%刻み）より細かく倍率を
     詰めるという回帰本来の役割を残すため。真に縦横比が違う入力では回帰が棄却されて
     等方の倍率に落ちるが、テンプレート照合自体が等方の倍率でしか探索していない以上、
     そこまで歪んだ入力は元々一致しないため、誤った異方性を通すより安全側に倒す。 */
  const SCALE_AGREE_TOL = 0.15;

  /* 誤マッチと判定する残差の許容(px)。正しく一致した点は候補変換にほぼ乗り、
     誤マッチ点だけが大きく外れる。実測（下記の実データ検証）で、正しい点同士の
     残差は最大でも数十px程度だったため、印刷ズレ等の正常なばらつきは飲み込みつつ
     誤マッチ（実測で数百px級）とは明確に切り分けられる値として40pxとした。 */
  const OUTLIER_TOL_PX = 40;

  /* 2点(ref→in)から軸独立の相似変換を決める。
     基準座標の差(dxr/dyr)がMIN_SPAN_FOR_SCALE未満の軸は、2点だけからの倍率計算が
     数pxの誤差で暴れる（estimateTransform本体のaxis関数と同じ理由）ため、その軸は
     実測せず medScale（各アンカーが独立に検出した倍率の中央値）をそのまま使う。
     これが無いと、たとえば基準座標でX方向に41pxしか離れていない2点の正しい組が、
     わずかな検出誤差だけでsxが0.66等に暴れて候補から弾かれ、有効なペアが1つも
     残らずに外れ値除去そのものが機能しなくなる（実データで発生を確認済み）。 */
  function pairTransform(a, b, medScale) {
    const dxr = b.refX - a.refX, dyr = b.refY - a.refY;
    const sx = Math.abs(dxr) >= MIN_SPAN_FOR_SCALE ? (b.inX - a.inX) / dxr : medScale;
    const sy = Math.abs(dyr) >= MIN_SPAN_FOR_SCALE ? (b.inY - a.inY) / dyr : medScale;
    if (!isFinite(sx) || !isFinite(sy)) return null;
    return { sx, sy, tx: a.inX - sx * a.refX, ty: a.inY - sy * a.refY };
  }
  function residual(p, tf) {
    return Math.max(Math.abs(p.inX - (tf.sx * p.refX + tf.tx)), Math.abs(p.inY - (tf.sy * p.refY + tf.ty)));
  }

  /* ── 誤マッチした対応点を捨てる（ペア総当たりによる多数決＝RANSACの簡易版）───
     以前は「倍率の中央値を仮定し、そこから外れた点を捨てる」中央値ベースの1回判定
     だったが、これは誤マッチが半数近く（実測: 4点中2点）になると中央値自体が両陣営の
     間に落ちてしまい、1件も検出できない実例が出た。
     代わりに、2点の組み合わせを総当たりして各ペアが示す変換を求め、他の点が何個その
     変換に乗るか（＝支持するか）を数える。最も支持を集めたペアの変換を「多数派」として
     採用する。誤マッチ同士がたまたま似た変換を示す確率は低いため、正しい点が過半数を
     割っていても多数派を正しく見つけられる（実際、上の実例では2/4が誤マッチという
     多数決が効かないはずのケースで正しく2点を除外できることを確認済み）。
     支持点を数える際、各アンカーがテンプレート探索で独立に検出した倍率の中央値
     （medScale）と大きく食い違うペアの変換は候補から外す。これが無いと、絶対値としては
     一致点を稼げても sx が0.3倍等の非現実的な変換が「たまたま」複数点を説明してしまい、
     誤って多数派に選ばれることがあった（実データで実際に発生を確認）。 */
  function ransacInliers(pairs, medScale) {
    let best = null, bestSupport = -1;
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const tf = pairTransform(pairs[i], pairs[j], medScale);
        if (!tf || tf.sx < 0.4 || tf.sx > 2.5 || tf.sy < 0.4 || tf.sy > 2.5) continue;
        if (Math.abs(tf.sx - medScale) > SCALE_AGREE_TOL * medScale) continue;
        if (Math.abs(tf.sy - medScale) > SCALE_AGREE_TOL * medScale) continue;
        const inliers = pairs.filter(p => residual(p, tf) <= OUTLIER_TOL_PX);
        const support = inliers.reduce((s, p) => s + (p.score || 0.5), 0);
        if (inliers.length > (best ? best.length : 0) || (best && inliers.length === best.length && support > bestSupport)) {
          best = inliers; bestSupport = support;
        }
      }
    }
    return (best && best.length >= 2) ? best : pairs;   // 有効なペアが無ければ従来通り全点使う
  }

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
  function estimateTransform(all) {
    if (all.length === 0) return { sx: 1, sy: 1, tx: 0, ty: 0, n: 0, dropped: 0, kept: [] };
    if (all.length === 1) {
      const f = all[0].scale || 1;
      return {
        sx: f, sy: f, tx: all[0].inX - f * all[0].refX, ty: all[0].inY - f * all[0].refY,
        n: 1, dropped: 0, kept: all,
      };
    }
    /* 照合倍率の中央値（探索は 0.6〜2.0 と広く、密集アンカーでも安定して得られる） */
    const medScaleAll = median(all.map(p => p.scale || 1));
    /* 別の場所へ誤マッチした点を先に捨てる。倍率だけでなく平行移動も、誤マッチ点が
       加重平均に混じるとその分だけ引きずられるため、推定前に取り除く必要がある。
       ペア総当たりは3点未満では機能しない（2点は常に一致するペアが1組しか無く、
       多数決にならない）ため、2点以下はそのまま使う。 */
    const pairs = all.length >= 3 ? ransacInliers(all, medScaleAll) : all;
    const dropped = all.length - pairs.length;
    const n = pairs.length;
    const medScale = dropped ? median(pairs.map(p => p.scale || 1)) : medScaleAll;
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
        /* 十分広い＝位置回帰を信頼。ただし各アンカーが独立に検出した倍率の中央値と
           大きく食い違う場合は、残った誤マッチや位置ノイズで回帰が壊れた可能性が高い
           ため採らない（SCALE_AGREE_TOL 参照）。 */
        if (isFinite(sReg) && sReg >= 0.4 && sReg <= 2.5
            && Math.abs(sReg - medScale) <= SCALE_AGREE_TOL * medScale) s = sReg;
      }
      return { s, t: mi - s * mr };
    };
    const X = axis(p => p.refX, p => p.inX);
    const Y = axis(p => p.refY, p => p.inY);
    return { sx: X.s, sy: Y.s, tx: X.t, ty: Y.t, n, dropped, kept: pairs };
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
         導出したwhitelistをそのまま渡す。数字（小数点を含めてもよい）の欄では
         桁区切り記号（, ， 空白 ¥ ￥ $）も許可し、Tesseractに記号として分類させた
         うえで後段のNUM_NOISE除去で落とす（記号を無理に数字化させないため）。
         小数点「.」を許可文字に加えた欄（例: 1,234.56）もここに含める。以前は
         「全桁が数字」だけを見ていたため、小数点を加えただけで桁区切り記号の
         whitelistが付かなくなり、Tesseractがカンマを出力できず最も近い許可文字
         （小数点自身等）に丸めてしまっていた（"1,234.56"→"1,234,56"のように
         カンマと小数点が区別できなくなる）。 */
      const wl = CharConstraint.derivedWhitelist(rule);
      if (!wl) return { lang: 'eng', whitelist: '' };
      const isDigitOrDot = [...wl].every(c => (c >= '0' && c <= '9') || c === '.');
      return { lang: 'eng', whitelist: isDigitOrDot ? wl + ',， ¥￥$' : wl };
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

  /* ── OCR前処理: 行トリム → 拡大 → 二値化＋角戻し ──────────
     英数字・記号のみの「単一値」欄（金額・コード等）専用。切り出しに写り込んだ
     薄いゴースト行（罫線除去の残像・隣接行）を落とし、値の行だけを十分な大きさ・
     背景ムラの無い状態でTesseractへ渡す。日本語欄・自由記述欄・複数行欄には適用しない
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
   * ここでは二値化せず（binarizeSoft が後段で行う）、トリム判定にだけ大津しきい値を使う。
   * 悪化しそうな退化ケースは元キャンバスを返す。
   * 拡大より先に呼ぶこと（ocrInputCanvas の順序に関する注記を参照）。
   * @param {HTMLCanvasElement} canvas
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

  /* σ=0.8 の3タップ・ガウシアン（cv2.GaussianBlur(ksize=3) 相当）を分離適用する。 */
  const GAUSS3 = [0.2261, 0.5478, 0.2261];

  /**
   * 大津で二値化し、直後に軽いガウシアンで輪郭の角を戻す。
   *
   * ノイズの多い切り出し（罫線除去の残像・背景ムラ・斑点）をグレーのまま渡すと、
   * Tesseractが背景の濃淡を文字の一部と見なして余計な文字を挿入する
   * （例: AA1237→AA1L237 / AL2451→AGE2451。実測でゴミありの正答率19%）。
   * 二値化すると背景は消えるが、今度は輪郭が階段状になり、きれいな切り出しの精度が
   * 落ちる（92%→83%）。二値化の直後に軽く平滑化して角を戻すと、背景を消したまま
   * 輪郭のなめらかさも保てる。実測（未知データ224件）で、きれい・ゴミあり・低DPI・
   * 高DPIの全条件で現行を上回ることを確認している（合計 49%→71%）。
   *
   * なお中央値フィルタによるノイズ除去も試したが、細い字画（1・L）を消して落字を
   * 招くため採用しない（実測で正答率が下がった）。
   */
  function binarizeSoft(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w < 3 || h < 3) return canvas;
    const gray = toGrayOverWhite(canvas);
    const thr = otsuThreshold(gray);
    const bin = new Float32Array(w * h);
    for (let i = 0; i < bin.length; i++) bin[i] = gray[i] < thr ? 0 : 255;

    /* 横方向 → 縦方向の順に1次元で畳み込む（端は最近傍で補う） */
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        tmp[base + x] = GAUSS3[0] * bin[base + (x > 0 ? x - 1 : 0)]
                      + GAUSS3[1] * bin[base + x]
                      + GAUSS3[2] * bin[base + (x < w - 1 ? x + 1 : w - 1)];
      }
    }
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d', { willReadFrequently: true });
    const img = octx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : 0) * w, cur = y * w, dn = (y < h - 1 ? y + 1 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        const v = Math.round(GAUSS3[0] * tmp[up + x] + GAUSS3[1] * tmp[cur + x] + GAUSS3[2] * tmp[dn + x]);
        const p = (cur + x) * 4;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
        img.data[p + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  /** 構造化された「英数字・記号のみの単一値」欄か。
      true の欄にだけ 行トリム＋拡大（①④）と PSM=ブロック（③）を適用する。 */
  function isSingleValueField(rule) {
    return CharConstraint.isActive(rule) && CharConstraint.isLatinOnly(rule);
  }

  /** OCR入力キャンバスを構築する。
      単一値欄は 行トリム → 拡大 → 二値化＋角戻し。それ以外の欄は従来通り拡大のみ。

      ★順序が重要: 必ず行トリムを先に行う。
      拡大するかどうかは「文字の高さ」で決めたいが、切り出しには上下の余白やゴースト行が
      含まれるため、キャンバス全体の高さで判断すると実態とかけ離れる。先に拡大していた
      従来の順序では、余白を含めた高さが目標値を超えていると「もう十分大きい」と誤判断して
      拡大せず、その後のトリムで文字が小さいまま Tesseract へ渡っていた
      （実測: 51pxの切り出しが拡大されないままトリムされ、文字はわずか15pxで渡っていた）。
      トリムを先にすれば、目標高さが本当に文字の高さに対して効くようになる。 */
  function ocrInputCanvas(cropCanvas, single) {
    if (!single) return upscaleForOcr(cropCanvas);
    const trimmed = preprocessSingleLine(cropCanvas);
    const scaled = upscaleForOcr(trimmed, SINGLE_TARGET_H, SINGLE_MAX_SCALE);
    return binarizeSoft(scaled);
  }

  /* PSM: 単一値欄は「単一の均一ブロック」(6) で読む。単一行(7)は最上行だけを読むため、
     ゴーストのヘッダー行が上に残ると値（下段の数字）を取りこぼす。6なら全行を読み、
     数字以外はwhitelistで落ちるので値だけが残る。一般欄は従来通りフォーム設定のPSM。 */
  const SINGLE_LINE_PSM = 6;

  /* 文字制約に不合格だったときに読み直す代替PSM（7=単一行, 8=単一語, 13=生の行）。
     実測（Tesseract 5.3.4・ゴミありの切り出し168件）で、PSM6が外した中の一部は
     別のPSMなら正しく読めており、制約の合否で選ぶと 66%→73% に改善した。
     救済されるのは「余分な1文字を拾う」失敗が中心で、報告された症状と一致する。 */
  const RETRY_PSMS = [7, 8, 13];

  /* 生データの文字数と固定長ルールの桁数の許容ズレ。これを超えたら「桁数が大きく
     違うので信頼できない」と判定し、制約自体はvalid=trueでも読み直しの対象にする。
     extractStr（値の前後の余分な文字を除去する仕組み）は「最も一致する固定長の窓」を
     機械的に選ぶだけで、窓の外にどれだけ余分な文字があったかは見ない。そのため
     生データが桁数を大きく超過していても（例: 6桁のところ9文字読んでしまった）、
     窓選択後にcorrectCharの誤認補正（0↔Q等）が偶然辻褄を合わせてしまうと、
     本来は信頼できない読み取りが constraintValid=true になり得る（実例:
     "-AB0Q0684"→"AB0006"とvalid判定されたが、正しい値は"AB0684"だった）。
     1文字程度の超過（薄いゴミ1文字の混入）はextractStrの本来の役割なので許容し、
     2文字以上の乖離だけを「疑わしい」とみなす。 */
  const LENGTH_MISMATCH_TOL = 2;

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

    /* ④ 原点の再ローカライズ: 位置合わせに使うアンカーを角度固定で再マッチ → 相似変換を
       推定（複数アンカーが取れればスケール=拡大率と位置ずれを同時に補正）。
       「帳票判定のみ」の役割のアンカーはここでは使わない。判定用は他の帳票と見分けるため
       広く取ることが多く、広い範囲はページ内の局所的な印刷ズレを平均した「妥協点」に
       一致しやすい。スコアは高くても位置がぶれるため、対応点に混ぜると位置合わせが悪化する
       （判定を良くしようと目印を足したら位置合わせがずれる、という形で実際に現れる）。 */
    stage('原点の確定', 0.25);
    const anchors = (form.anchors || []).filter(AnchorRoles.usedForAlign);
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
          name: t.a.name || '',
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
    else                         transform = { sx: 1, sy: 1, tx: 0, ty: 0, n: 0, dropped: 0, kept: [] };
    const tLocalize = performance.now();

    /* 位置合わせの診断。OCR欄の位置がずれたとき、原因が
         ・目印が別の場所に一致した（誤マッチ）
         ・基準画像と入力の解像度が違う（倍率が1.0のままでは合わない）
         ・目印が近くに固まっていて倍率が決まらない
       のどれなのかは、対応点そのものを見ないと切り分けられないため一覧で出す。
       「ずれ」= 採用した変換で基準座標を写した位置と、実際に一致した位置との差。
       正しく合っていれば全て数px以内に収まる。特定の1点だけ大きい＝その目印が犯人。 */
    if (allMatches.length) {
      console.log(`[align] 基準画像 ${form.referenceImage ? form.referenceImage.w + 'x' + form.referenceImage.h : '?'}`
        + ` → 入力 ${rotated.width}x${rotated.height}`
        + ` / 変換 倍率${transform.sx.toFixed(3)}x${transform.sy.toFixed(3)}`
        + ` 平行移動(${Math.round(transform.tx)},${Math.round(transform.ty)})`
        + ` 採用${transform.n}点 除外${transform.dropped || 0}点`);
      allMatches.forEach(p => {
        const used = transform.kept.includes(p);
        const dx = p.inX - (transform.sx * p.refX + transform.tx);
        const dy = p.inY - (transform.sy * p.refY + transform.ty);
        console.log(`[align]   ${used ? '採用' : '除外'} "${p.name}" 基準(${Math.round(p.refX)},${Math.round(p.refY)})`
          + ` → 一致(${Math.round(p.inX)},${Math.round(p.inY)})`
          + ` ずれ(${Math.round(dx)},${Math.round(dy)}) スコア${p.score.toFixed(2)} 検出倍率${p.scale}`);
      });
    }

    /* 一致品質の診断: 基準画像と入力画像の縮尺が大きく違うと、ここでの探索
       （LOCALIZE_SCALES の範囲内）で真の倍率を捉えきれず、OCR領域の位置が
       ずれたまま気づかれない恐れがある。検出倍率が探索範囲の端に張り付いて
       いる／信頼できる一致が1つも無い場合は、呼び出し側で警告できるように
       フラグを返す（例: PDFの読み込みDPIが登録時と違いすぎるケース）。 */
    /* 誤マッチとして捨てた点は以降の判断からも外す（欄ごとの局所変換にも混ぜない）。 */
    const usedMatches = transform.kept.length ? transform.kept : (good.length ? good : allMatches.slice(0, 1));
    /* 局所アンカー位置決め用の対応点（信頼できる一致が2点以上あるときだけ）。 */
    const anchorPoints = transform.kept.length >= 2 ? transform.kept : null;
    const scaleMin = LOCALIZE_SCALES[0], scaleMax = LOCALIZE_SCALES[LOCALIZE_SCALES.length - 1];
    const matchQuality = {
      n: transform.n,
      bestScore: allMatches.length ? allMatches[0].score : 0,
      bestScale: allMatches.length ? allMatches[0].scale : 1,
      scaleEdge: usedMatches.some(p => p.scale <= scaleMin || p.scale >= scaleMax),
      weakMatch: !good.length,
      /* 誤マッチとして除外した目印の数。0でなければ、その目印は他の場所（似た四角など）
         と区別が付いていないため、利用者に作り直しを促す。 */
      droppedOutliers: transform.dropped || 0,
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
    /* OCR結果を最終的な値へ整える（行選択 → 正規化 → パターン抽出 → 文字制約）。
       PSMを変えて読み直したときに同じ手順を再適用するため、関数へ切り出してある。 */
    const finishText = (res, region, rule, active, single) => {
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
      let constraintValid = true, lengthSuspicious = false, ambiguous = false;
      if (active) {
        const cc = CharConstraint.apply(text, rule);
        text = cc.text; constraintValid = cc.valid; ambiguous = !!cc.ambiguous;
        const norm = CharConstraint.normalize(rule);
        if (norm && !norm.variable) {
          lengthSuspicious = Math.abs([...raw.trim()].length - norm.len) >= LENGTH_MISMATCH_TOL;
        }
      }
      return { text, raw, constraintValid, lengthSuspicious, ambiguous };
    };

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
      const onProg = prog => cb.onOcr && cb.onOcr(oi, regions.length, region.name, prog.status, prog.progress);
      let res = await OcrProcessor.recognize(inputCanvas, usePsm, onProg, useLang, useWl);
      let out = finishText(res, region, rule, active, single);
      let readPsm = usePsm;
      /* 診断: 生データ→制約適用後の値と合否をPSM試行ごとに残す。スクリーンショット
         なしでも「どのPSMで何が読めたか」を診断コピーだけで追跡できるようにする
         （抽出窓の誤選択・途中への1文字混入等の切り分けに使う）。 */
      console.log(`[ocr]   "${region.name}" psm=${usePsm} raw=${JSON.stringify(out.raw)} `
        + `→ ${JSON.stringify(out.text)} valid=${out.constraintValid} lengthSuspicious=${out.lengthSuspicious} ambiguous=${out.ambiguous}`);
      /* 文字制約に不合格、桁数が大きく食い違う、または抽出候補が複数同点で
         決められない(ambiguous)なら、別のレイアウト解釈(PSM)で読み直して
         いずれも満たすものを探す。
         Tesseractは同じ画像でもPSMによって字の切り出し方が変わり、汚れや字間を
         余分な1文字として拾ってしまう失敗（AL2451→AL24521、JL3331→JIL3331 等）が
         PSMを変えるだけで解けることがある。桁数と桁ごとの字種を宣言済みの欄だけが
         対象で、合否という客観的な判定材料があるからこそ選べる。
         lengthSuspiciousも見るのは、extractStr（前後の余分な文字を除去する仕組み）が
         「桁数に最も合う窓」を機械的に選ぶだけで、窓の外にどれだけ余分な文字が
         あったかは見ないため。生データが桁数を大きく超過していても、窓選択後に
         誤認補正（0↔Q等）が偶然辻褄を合わせてしまうと、本来信頼できない読み取りが
         constraintValid=trueになり得る（実例: "-AB0Q0684"→"AB0006"とvalid判定
         されたが、正しい値は"AB0684"だった）。
         ambiguousも見るのは、紛れ込み文字（例:Q）に加えて別の桁でも0↔O等の
         字種またぎの誤認が重なると、どの1文字を削除するかで結果が変わる
         候補同士が同点になり得るため（実例: "ABOQ750"は"Q"を消せば正しく
         "AB0750"になるが"B"を消しても同点で"AO0750"になる）。文字種だけでは
         どちらが正しいか決められないので、確信を持てないまま片方を採用せず
         読み直しに回す。
         1回目が全て満たせばそのまま採用するので、これまで正しく読めていた欄の結果は
         変わらない。追加のOCRは疑わしい欄にだけ発生する。 */
      if (single && (!out.constraintValid || out.lengthSuspicious || out.ambiguous)) {
        for (const altPsm of RETRY_PSMS) {
          if (altPsm === usePsm) continue;
          const altRes = await OcrProcessor.recognize(inputCanvas, altPsm, onProg, useLang, useWl);
          const altOut = finishText(altRes, region, rule, active, single);
          console.log(`[ocr]   "${region.name}" psm=${altPsm}(再読取) raw=${JSON.stringify(altOut.raw)} `
            + `→ ${JSON.stringify(altOut.text)} valid=${altOut.constraintValid} lengthSuspicious=${altOut.lengthSuspicious} ambiguous=${altOut.ambiguous}`);
          if (altOut.constraintValid && !altOut.lengthSuspicious && !altOut.ambiguous) { res = altRes; out = altOut; readPsm = altPsm; break; }
        }
      }
      const { text, raw, constraintValid, lengthSuspicious, ambiguous } = out;
      /* 言語がページ間・領域間で切り替わるとTesseractの言語データ再読み込みが走り
         大幅に遅くなることがあるため、領域ごとの所要時間と使用言語を記録する。
         採用結果（raw/text/valid）も添えることで、再読取してもどれも制約を
         満たせず最初の結果へ戻ったケース（[ocr]の最終行だけでは分かりにくい）も
         このサマリ行単体で追える。 */
      console.log(`[perf]   OCR "${region.name}" lang=${useLang} psm=${readPsm}${readPsm !== usePsm ? '(再読取)' : ''} `
        + `${(performance.now() - tFieldStart).toFixed(0)}ms 採用: raw=${JSON.stringify(raw)} → ${JSON.stringify(text)} `
        + `valid=${constraintValid} ambiguous=${ambiguous}`);
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
        /* 桁数超過・抽出候補の同点（ambiguous）が読み直しでも解消しなかった場合は、
           既存の「制約不合格」表示に乗せて利用者へ伝える（constraintValid自体は
           trueでも、値としては信用できないことに変わりないため。
           LENGTH_MISMATCH_TOL・extractStrのambiguous判定を参照）。 */
        constraintValid: constraintValid && !lengthSuspicious && !ambiguous,
        symbols: res.symbols || [],
        cropDataURL: cropCanvas.toDataURL('image/png'),
        /* 診断: 実際にOCRへ渡した画像（前処理後）と使用パラメータ。
           前処理が効いたか／ゴーストが除けたかを目視で確認できるようにする。
           前処理を通す単一値欄のみPNG化する（他欄は元切り出しとほぼ同一で無駄なため）。 */
        ocrInputDataURL: single ? inputCanvas.toDataURL('image/png') : null,
        ocrInfo: { preprocessed: single, psm: readPsm, retried: readPsm !== usePsm, lang: useLang, whitelist: useWl },
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
