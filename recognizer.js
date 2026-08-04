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
    /* dataURL も一緒に渡す。matcher側はこれをそのまま送れるため、
       imageElementからPNGを再圧縮し直す無駄が無くなる（imageElementは
       サイズ取得など他の用途で引き続き必要なので残す）。 */
    return Promise.all(anchors.map(async a => ({ id: a.id, dataURL: a.dataURL, imageElement: await dataURLtoImg(a.dataURL) })));
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
     誤って多数派に選ばれることがあった（実データで実際に発生を確認）。

     ただし、この medScale 制約自体が仇になるケースが実機で見つかった: 3つの独立した
     アンカーが、それぞれ単体のテンプレート探索でも一貫して間違った倍率（実測77%。
     帳票内の別の場所に、たまたま揃って高いスコアで誤マッチした）を検出したため、
     medScale 自体がその77%に汚染された。この状態では、アンカー同士の相対位置から
     計算すると残差数px・角度差1°未満で無矛盾に説明できる「真に正しい変換」（実測で
     ほぼ100%）が、「medScaleと食い違う」という理由だけで候補から弾かれ、逆に77%という
     誤った変換の方が「多数決で勝つ」という転倒が起きていた。
     対策として、medScale制約ありの結果と、値域チェック(0.4〜2.5)のみで制約なしの結果を
     両方評価し、制約なしの方が同じかそれ以上の点数を、大幅に（半分未満に）小さい残差で
     説明できる場合はそちらを採用する。「大幅に小さい」という条件が、SCALE_AGREE_TOL
     本来の目的（非現実的な変換が偶然複数点を通ってしまうのを防ぐ）の代役を果たす
     （非現実的な変換が実在の複数点を、制約ありの場合の半分未満の残差で説明できる
     確率は低い）。
     戻り値に scaleOverride を含めるのは、ここで見つけた「ペア自身が示す信頼できる
     倍率」を estimateTransform 側の後続処理にも伝えるため。除外点が0（=全点が
     inlierとして残る）だと estimateTransform は medScale を素通しで使い続けるが、
     それは今回のように「全員が独立に同じ間違った倍率を検出した」ケースでは汚染
     されたままの値であり、後段の位置回帰（axis関数）が正しい回帰結果を「medScaleと
     食い違う」という理由で再び棄却してしまう（実機で確認済み）。scaleOverride を
     渡せば、この転倒を防げる。 */
  function ransacInliers(pairs, medScale) {
    const evaluate = (constrainToMedScale) => {
      let best = null, bestTf = null, bestSupport = -1;
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          const tf = pairTransform(pairs[i], pairs[j], medScale);
          if (!tf || tf.sx < 0.4 || tf.sx > 2.5 || tf.sy < 0.4 || tf.sy > 2.5) continue;
          if (constrainToMedScale) {
            if (Math.abs(tf.sx - medScale) > SCALE_AGREE_TOL * medScale) continue;
            if (Math.abs(tf.sy - medScale) > SCALE_AGREE_TOL * medScale) continue;
          }
          const inliers = pairs.filter(p => residual(p, tf) <= OUTLIER_TOL_PX);
          const support = inliers.reduce((s, p) => s + (p.score || 0.5), 0);
          if (inliers.length > (best ? best.length : 0) || (best && inliers.length === best.length && support > bestSupport)) {
            best = inliers; bestTf = tf; bestSupport = support;
          }
        }
      }
      return best ? { inliers: best, tf: bestTf, maxResidual: Math.max(...best.map(p => residual(p, bestTf))) } : null;
    };

    const constrained = evaluate(true);
    /* 2点（ペア1組だけ）でも意味がある: constrained/fallbackは同じ唯一のペアを
       評価するが、そのペアの変換がmedScaleと一致すれば両者は同じ結果になり
       （残差も同一なので下の0.5倍判定でfallbackが不要に選ばれることはない）、
       食い違えばconstrainedが候補なし(null)になり、fallback（値域チェックのみ）
       だけがそのペアを拾える。1点は比較対象が無いためそもそも呼ばれない
       （estimateTransform側の分岐）。 */
    const fallback = pairs.length >= 2 ? evaluate(false) : null;
    if (fallback && fallback.inliers.length >= 2
        && (!constrained
            || (fallback.inliers.length >= constrained.inliers.length
                && fallback.maxResidual < constrained.maxResidual * 0.5))) {
      return { points: fallback.inliers, scaleOverride: { sx: fallback.tf.sx, sy: fallback.tf.sy } };
    }
    return { points: (constrained && constrained.inliers.length >= 2) ? constrained.inliers : pairs, scaleOverride: null };   // 有効なペアが無ければ従来通り全点使う
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
    /* 除外（外れ値を捨てる）ための多数決は3点未満では機能しない（2点は常に一致する
       ペアが1組しか無く、多数決にならない）。しかし ransacInliers が持つもう一つの
       役割——「唯一のペア自身が示す変換が medScale と食い違う場合に、そちらを
       信頼できる scaleOverride として返す」——は、多数決ではなく2点1組の関係だけで
       完結するため2点でも意味がある。実機で、位置合わせ用アンカーが2点しか無い
       帳票（他のアンカーを判定のみに変更した後等）でも、その2点が両方とも独立に
       同じ間違った倍率を検出してしまい、medScaleがその2点だけで汚染されるケースが
       確認された。3点以上なら複数ペアの多数決で真の変換を見つけられるが、2点では
       唯一のペア自身の変換をmedScale制約なしで信頼するしかなく、それでも「値域
       チェック(0.4〜2.5)」は残るため、非現実的な変換まで無条件に信頼するわけでは
       ない。1点はそもそも比較対象が無く呼び出し不要。 */
    const ransac = all.length >= 2 ? ransacInliers(all, medScaleAll) : { points: all, scaleOverride: null };
    const pairs = ransac.points;
    const dropped = all.length - pairs.length;
    const n = pairs.length;
    /* medScale の決定: ransacInliers が「各アンカー個別のmedScale制約」をバイパスして
       採用した場合（scaleOverride あり）は、その根拠になった信頼できる倍率をそのまま
       引き継ぐ。そうしないと、除外点が0（=全点がinlierとして残る）のケースで下の
       axis関数が medScaleAll（汚染されている可能性がある値）を素通しで使い続け、
       ransacInliers がせっかく見つけた正しい変換を、位置回帰(sReg)が「medScaleと
       食い違う」という理由で再び棄却してしまう（ransacInliersのコメント参照）。 */
    const medScaleX = ransac.scaleOverride ? ransac.scaleOverride.sx
                     : (dropped ? median(pairs.map(p => p.scale || 1)) : medScaleAll);
    const medScaleY = ransac.scaleOverride ? ransac.scaleOverride.sy
                     : (dropped ? median(pairs.map(p => p.scale || 1)) : medScaleAll);
    /* 加重は score をそのまま使う（呼び出し側は score>=0.4 のみを渡すため、常に正）。
       スコア差を過度に増幅しないよう線形のまま用いる。 */
    const weights = pairs.map(p => Math.max(1e-3, p.score || 0));
    const wSum = weights.reduce((a, b) => a + b, 0);
    /* 軸ごと: 広がりが十分なら加重位置回帰で連続倍率を精密化、狭ければ照合倍率を採用。
       平行移動は採用倍率 s を固定して t = 加重平均(in - s*ref)（＝回帰の切片と同値だが、
       倍率誤差から切り離した頑健な平行移動になる）。 */
    const axis = (gr, gi, medScale) => {
      let mr = 0, mi = 0, lo = Infinity, hi = -Infinity;
      pairs.forEach((p, i) => { const r = gr(p); mr += weights[i] * r; mi += weights[i] * gi(p); if (r < lo) lo = r; if (r > hi) hi = r; });
      mr /= wSum; mi /= wSum;
      let s = medScale;
      const wide = (hi - lo) >= MIN_SPAN_FOR_SCALE;
      if (wide) {
        let num = 0, den = 0;
        pairs.forEach((p, i) => { const dr = gr(p) - mr, di = gi(p) - mi; num += weights[i] * dr * di; den += weights[i] * dr * dr; });
        const sReg = den > 1e-6 ? num / den : NaN;
        /* 十分広い＝位置回帰を信頼。ただし各アンカーが独立に検出した倍率の中央値と
           大きく食い違う場合は、残った誤マッチや位置ノイズで回帰が壊れた可能性が高い
           ため採らない（SCALE_AGREE_TOL 参照）。 */
        if (isFinite(sReg) && sReg >= 0.4 && sReg <= 2.5
            && Math.abs(sReg - medScale) <= SCALE_AGREE_TOL * medScale) s = sReg;
      }
      /* wide: この軸に倍率を独自に決める情報があったか（広がり不足なら medScale を
         素通ししただけ＝この軸単独では倍率を検証できていない）。mr/mi は後段の
         「片方の軸を他方の倍率で補う」補正で、加重平均を保ったまま倍率だけ
         差し替えるために必要。 */
      return { s, t: mi - s * mr, wide, mr, mi };
    };
    let X = axis(p => p.refX, p => p.inX, medScaleX);
    let Y = axis(p => p.refY, p => p.inY, medScaleY);
    /* 片方の軸だけアンカーの広がりが足りず（MIN_SPAN_FOR_SCALE未満）、medScaleを
       素通ししただけの倍率が残るケースを補う。紙のスキャン・撮影は通常縦横で同じ
       倍率になるため、もう片方の軸（広がりが十分で、回帰またはscaleOverrideにより
       確定した信頼できる倍率）と大きく食い違うなら、そちらの倍率で置き換える
       （平行移動は各軸の加重平均位置を保ったまま倍率だけ差し替える）。
       実機で、2点しかアンカーが無く、その2点のX座標がたまたま近い（間隔59px）
       帳票では、Y軸は正しく100%近くに修正できたのに、X軸だけ情報不足で汚染された
       77%のまま残るケースを確認した。 */
    if (!X.wide && Y.wide && Math.abs(X.s - Y.s) > SCALE_AGREE_TOL * Y.s) {
      X = { s: Y.s, t: X.mi - Y.s * X.mr };
    } else if (!Y.wide && X.wide && Math.abs(Y.s - X.s) > SCALE_AGREE_TOL * X.s) {
      Y = { s: X.s, t: Y.mi - X.s * Y.mr };
    }
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
   *
   * erodePx=1 を渡すと、二値化の直後にインクを1px痩せさせてからガウスを掛ける。
   * これは本線の入力ではなく、セカンドオピニオン用の「別の見え方の画像」を作る
   * ためのオプション（SECOND_OPINION の解説を参照）。痩せは細い字画を消す危険が
   * あるため本線には使わないが、意見が割れたときの検算材料としては、本線と
   * 誤りが相関しない画像として価値がある。
   */
  function binarizeSoft(canvas, erodePx = 0) {
    const w = canvas.width, h = canvas.height;
    if (w < 3 || h < 3) return canvas;
    const gray = toGrayOverWhite(canvas);
    const thr = otsuThreshold(gray);
    const bin = new Float32Array(w * h);
    for (let i = 0; i < bin.length; i++) bin[i] = gray[i] < thr ? 0 : 255;
    if (erodePx > 0) erodeInk(bin, w, h);

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

  /** 二値配列(0=インク/255=白)のインクを1px痩せさせる（8近傍に白が1つでもあれば白へ）。
      画像端の外は白とみなす。binarizeSoftのerodePx用の内部ヘルパー。 */
  function erodeInk(bin, w, h) {
    const src = Float32Array.from(bin);
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 255 : src[y * w + x];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x] !== 0) continue;
        let touchesWhite = false;
        for (let dy = -1; dy <= 1 && !touchesWhite; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (at(x + dx, y + dy) !== 0) { touchesWhite = true; break; }
          }
        }
        if (touchesWhite) bin[y * w + x] = 255;
      }
    }
  }

  /* OCR入力の四辺に足す白余白(px)。
     Tesseract(LSTM)は行の周囲に十分な余白が無いと行の正規化が乱れ、字形を丸ごと
     別の文字として誤分類することがある（公式FAQも境界余白の追加を推奨している）。
     行トリム（preprocessSingleLine）は上下に2pxしか余白を残さないため、このツールの
     単一値欄はまさにその「余白不足」の状態でTesseractへ渡っていた。
     実測: 縦棒がほぼ垂直な等幅書体（Courier系）の太字「704」が、余白不足だと
     "104"（7が丸ごと1に誤分類）や "7104"（7が7+ゴースト1に二重検出）になる現象を
     サンドボックスで再現できた（実機の矩形ログと同一シグネチャ）。四辺に12pxの
     白枠を足すだけで、再現した誤読10ケース全てが "704" に戻り、フォント6種×
     サイズ×劣化条件の回帰ベンチでも悪化しないことを確認して採用した。 */
  const OCR_MARGIN_PX = 12;

  /** キャンバスの四辺に白余白を付けたコピーを返す（OCR入力専用） */
  function padCanvas(canvas, m) {
    const c = document.createElement('canvas');
    c.width = canvas.width + m * 2;
    c.height = canvas.height + m * 2;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, m, m);
    return c;
  }

  /** 構造化された「英数字・記号のみの単一値」欄か。
      true の欄にだけ 行トリム＋拡大（①④）と PSM=ブロック（③）を適用する。 */
  function isSingleValueField(rule) {
    return CharConstraint.isActive(rule) && CharConstraint.isLatinOnly(rule);
  }

  /** 単一値欄のOCR入力一式を構築する。
      main  = 本線の入力（行トリム → 拡大 → 二値化＋角戻し → 白枠）。
      erode / gray = セカンドオピニオン用の変種（必要になるまで作らない遅延生成）。
        erode: 二値化時にインクを1px痩せさせた版。太字で字画同士が近づいた見え方を戻す。
        gray : 二値化せずグレーのまま渡す版。二値化そのものが招いた誤読の検算用。
      いずれも同じトリム・拡大結果を共有し、白枠（OCR_MARGIN_PX）も同様に付ける。

      ★順序が重要: 必ず行トリムを先に行う。
      拡大するかどうかは「文字の高さ」で決めたいが、切り出しには上下の余白やゴースト行が
      含まれるため、キャンバス全体の高さで判断すると実態とかけ離れる。先に拡大していた
      従来の順序では、余白を含めた高さが目標値を超えていると「もう十分大きい」と誤判断して
      拡大せず、その後のトリムで文字が小さいまま Tesseract へ渡っていた
      （実測: 51pxの切り出しが拡大されないままトリムされ、文字はわずか15pxで渡っていた）。
      トリムを先にすれば、目標高さが本当に文字の高さに対して効くようになる。 */
  function buildSingleInputs(cropCanvas) {
    const trimmed = preprocessSingleLine(cropCanvas);
    const scaled = upscaleForOcr(trimmed, SINGLE_TARGET_H, SINGLE_MAX_SCALE);
    return {
      main:  padCanvas(binarizeSoft(scaled), OCR_MARGIN_PX),
      erode: () => padCanvas(binarizeSoft(scaled, 1), OCR_MARGIN_PX),
      gray:  () => padCanvas(scaled, OCR_MARGIN_PX),
    };
  }

  /** OCR入力キャンバス（本線のみ）。単一値欄以外は従来通り拡大のみ。 */
  function ocrInputCanvas(cropCanvas, single) {
    if (!single) return upscaleForOcr(cropCanvas);
    return buildSingleInputs(cropCanvas).main;
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

  /* 分割された断片とみなす中心間隔の上限（字形ピッチに対する比）。
     隣り合う本物の字形は必ずピッチ（字送り幅）ぶん離れているのに対し、
     1つの字形が複数に分割された断片同士はほぼ同じ位置に重なって出る。
     実測（実機ログ3件）では本物の間隔が48〜53pxだったのに対し、断片同士は
     2.5〜14.5pxしかなく、両者の差は極めて大きい。0.5（ピッチの半分）で
     切れば双方に十分な余裕がある。 */
  const GLYPH_MERGE_PITCH_RATIO = 0.5;

  /* 分割された字形のどの断片を残すかを決める際、予測位置からのズレの許容量
     （ピッチに対する比）。これを超える場合はピッチの当てはめ自体が怪しい
     ＝信用できないので修復しない。 */
  const GLYPH_SLOT_TOLERANCE = 0.4;

  /* pickByWidthで、幅の自然さの決着に必要な上位2候補の差（中央値に対する比）。
     これ未満の差では「どちらが本物か幅からは決められない」とみなし、その
     まとまりの修復自体を諦める（誤った方を自信満々に確定させるより安全）。 */
  const GLYPH_WIDTH_MARGIN = 0.15;

  /* pickByWidthで、まとまり中の最も太い矩形がこの倍率（中央値に対する比）以上
     なら、そのまとまりは「1つの字形の二重検出（本物+ゴースト）」ではなく
     「字画が接触した2文字以上を1つの矩形として検出した」ものとみなし、1文字に
     絞り込まずまとまりごと修復を諦める。
     根拠: 二重検出のゴーストは本物の字形の一部（破片）にしかならないため、
     GLYPH_OVERLAP_MERGE_RATIO導入の実測（"7104"→"704"、7104_boxes: 7幅22px+
     1(ゴースト)幅12px、基準幅25px）でもゴーストは基準幅を上回らなかった。
     一方、実機で報告された金額欄「5,002,800」の誤読は、末尾の0が2つ接触し、
     基準幅23pxに対し幅22px（正常）と幅50px（基準の約2.2倍）の矩形が重なって
     検出されていた。幅50pxの矩形は2文字ぶんのインクを1つにまとめただけで
     ゴーストではないため、中央値に近い22px側だけを残す従来の判定では、
     除外してはいけない本物の桁を消してしまう（"5,002,800"→"500,280"）。
     字形検証(SEVEN_WIDTH_MAX_RATIO=1.3)でも「基準幅の1.3倍を超える矩形は
     隣接字形の混入で信用できない」とみなしており、本物の字形1つが基準幅の
     1.6倍に達することは通常無い。2文字ぶん(≈2.0倍)との間に十分な余裕を
     残しつつ、正常な字形の太り（太字・にじみ等）を誤って弾かない値として
     1.6を採用する。 */
  const GLYPH_MERGED_WIDTH_RATIO = 1.6;

  /* ── まとまりが「本当に1つの字形か」の検算（固定長・可変長の共通ガード）──
     v.2026-07-29.11 には「複数の本物の字形を巻き込んで消す事故」を防ぐための
     クラスタ幅ガード（字形1つ分の1.8倍超なら畳まない）があったが、
     v.2026-07-29.12 で判定方式を「矩形の重なり」から「字送りの規則性」へ
     作り替えた際に失われた。その結果、実機で注文番号"A94813"が"A94818"に
     化ける事故が起きたため、2つの独立した根拠で作り直す。

     実測値（すべて実機ログの矩形データ。ref=単独検出された字形の幅の中央値）:
                                             広がり/ref   断片間の隙間
       畳んでよい（1つの字形の二重検出）:
         "7104"→"704"      7+1                1.10倍        -6px
         "AB0750" 0の2分割  O+Q                1.54倍        -8px
         "AB0746" 0の3分割  0+O+Q              1.67倍     -11,-9px
         "AA1227" 1の3分割  L+1+L              1.68倍      -6, 0px
         "AB0684" 0の3分割  O+Q+O              1.86倍     -12, 0px
       畳んではいけない（別々の本物の字形）:
         "A94813"→"A94818" 1[233-245]+3[257-272]  1.86倍     +12px ★
         "5,002,800"→"500280" 0[292-314]+0[294-344] 2.26倍    -20px ★

     ここから分かるのは、「広がり」だけでは A94813(1.86) と AB0684(1.86) を
     区別できないということ。両者を分けるのは隙間の符号である:
       ① 同じインクを重複して指した断片は、必ず重なるか接する（隙間 ≦ 0px）。
          実測でも畳んでよい5件はすべて -12〜0px に収まっている。
       ② 逆に断片同士のあいだに白い隙間が空いている（A94813 の +12px）なら、
          それは物理的に別々のインク＝別々の字形である動かぬ証拠になる。
     そこで判定を2本立てにする:
       ・隙間ガード: 白い隙間が字形幅の25%を超えたら畳まない（①②より。
         インクのかすれで断片が数px途切れる可能性は残すため0ではなく25%）。
       ・広がりガード: 隙間が無く（＝重なって）いても、まとまりが2文字分
         （≒2.0倍。v.2026-07-29.11の「本当に隣り合う2文字は2倍前後」という
         実測と一致）まで広がっているなら畳まない。"5,002,800" の 2.26倍は
         これで捕まる。
     2本立てにしたことで、畳んでよい実測（最大1.86倍・隙間0px）と、畳んでは
     いけない実測（1.86倍だが隙間+12px／隙間は無いが2.26倍）が、どちらの軸でも
     十分な余裕をもって分離される。 */
  const GLYPH_CLUSTER_SPAN_MAX_RATIO = 2.0;
  const GLYPH_CLUSTER_GAP_MAX_RATIO  = 0.25;

  /* ── 可変長欄（金額欄等）のセカンドオピニオン ─────────────
     可変長欄は桁数という検算材料が無いため、字形が丸ごと別の文字として
     誤分類された場合（実機で "704" が "104" と読まれ、7の矩形が1個だけ・
     幅も他の数字と同等で、矩形からは異常を検出できなかった例がある）、
     何のフラグも立たないまま確信度86%の緑表示で通ってしまう。

     以前は「同じ画像を別のレイアウト解釈（PSM7）で読み直す」方式だったが、
     この誤読をサンドボックスで再現して測ったところ、PSM6で"104"になる画像は
     PSM7でも全ケース"104"になった（実機でも同様で、要確認フラグは立たなかった）。
     同じ画像を見る限り、レイアウト解釈を変えても誤りは相関する。

     そこで検算は「同じ画像の別解釈」ではなく「別の見え方に加工した画像」で行う。
     本線（二値化＋角戻し）に対し、①インクを1px痩せさせた版（erode）で読み直し、
     一致すればそのまま採用。食い違えば ②グレー版（gray・二値化なし）でもう一度
     読み、2対1の多数決で決める。本線が少数派なら多数派の値を採用し（実測で、
     再現した"104"誤読はerode版・gray版とも"704"と正しく読めた）、三者三様なら
     どれも信用できないので本線の値のまま「要確認」として利用者に知らせる。
     比較は生データではなく「正規化・制約適用後の最終値」同士で行う。
     生データだと "591,800" と "591,800," のような表記ゆれで誤検知するが、
     最終値ではどちらも "591800" に落ち着くため。 */

  /** sub が sup から文字を取り除くだけで作れるか（＝部分列か）。
      再読取りの生データが「元の読みから余分な文字を落としただけ」なのか、
      「別の文字として読み直した」のかを見分けるのに使う（RETRY_PSMSの解説参照）。 */
  function isSubsequenceOf(sub, sup) {
    let i = 0;
    for (const c of sup) if (i < sub.length && sub[i] === c) i++;
    return i === sub.length;
  }

  /** 数値配列の中央値。 */
  function medianOf(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* 文字単位の外接矩形から「同じ字形を複数に分割して読んだ」断片を取り除く。
     文字種の情報だけでは原理的に解けない誤読（例: 生データ "ABOT755" は
     "O"を消せば"AB7755"、"T"を消せば"AB0755"となり、どちらも「1文字だけ
     CONFUSE表で補正すれば桁が揃う」ため同点になる）を、字形の位置という
     別の情報で決着させるために使う。

     当初は「矩形同士が重なっているか」で判定していたが、実機ログの3例で
     いずれも失敗した。分割された断片は必ずしも重ならないためで、例えば
     "AB0684"では 0 が O[143-168] Q[156-160] O[160-184] の3つに分割された
     ものの、Q と 後ろのO は重なっておらず（160で接するだけ）連鎖が途切れる。
     "AB0755"に至っては T[164-184] と 7[178-199] の重なりが狭い方の幅の30%
     しかなく、しきい値にわずかに届かなかった。

     そこで判定を「字送りの規則性」に変えた。固定書式の欄は字形が等間隔に
     並ぶため、本物の字形同士の中心間隔（ピッチ）は一定になる。一方、1つの
     字形の断片同士はほぼ同じ位置に出るので間隔が極端に小さい。実測でも
     本物48〜53pxに対し断片2.5〜14.5pxと明確に分かれていた。
     手順は、①ピッチを推定し、②間隔がピッチの半分未満の矩形をひとかたまり
     （＝1つの字形）にまとめ、③まとまりの数が桁数と一致した時だけ、
     ④各まとまりから「等間隔に並ぶはずの位置に最も近い」1つを代表として残す。
     まとまりの数が桁数と一致しない場合は、値の前後に付いた本物のゴミなど
     別の要因が混ざっているので手を出さない（既存の前後除去に任せる）。

     金額欄等の可変長ルールには「期待される桁数」自体が無い（帳票ごとに
     金額の桁が違って当然のため）。この場合はexpectedLenを渡せないので、
     等間隔の当てはめではなく「間隔の分布そのものから断片と本物の境目を
     見つける」自己整合的な方式（groupByNaturalGaps）に切り替える。

     @param {string} text        矩形と対応する生の認識文字列
     @param {Array}  charBoxes   文字単位の外接矩形
     @param {number} expectedLen 期待される桁数（固定長ルールのみ。0/未指定なら可変長として扱う）
     @returns {{ text:string, dropped:Array }|null} 修復できない場合は null。 */
  function repairSplitGlyphs(text, charBoxes, expectedLen, logPrefix = '[ocr]') {
    const L = expectedLen | 0;
    if (!Array.isArray(charBoxes) || charBoxes.length < 2) return null;
    if (L && charBoxes.length <= L) return null;   // 桁数既知で余分が無ければ何もしない
    /* 矩形列と実際に採用したテキストがずれている場合（PSMやTSVとboxで
       セグメンテーションが食い違う等）は、対応が取れないので手を出さない。 */
    if (charBoxes.map(b => b.text).join('') !== [...text].filter(c => !/\s/.test(c)).join('')) return null;

    const items = charBoxes.map((b, i) => ({ b, i, c: (b.x0 + b.x1) / 2 })).sort((p, q) => p.c - q.c);
    const gaps = [];
    for (let k = 0; k + 1 < items.length; k++) gaps.push(items[k + 1].c - items[k].c);

    const groups = L ? groupByExpectedLen(items, gaps, L) : groupByNaturalGaps(items, gaps);
    if (!groups || !groups.some(g => g.length > 1)) return null;
    if (clusterTooWide(groups, logPrefix)) return null;

    /* まとまりの中でどれを残すかは、桁数が既知かどうかで信頼できる根拠が違う。
       桁数既知（固定長）なら「等間隔に並ぶはずの位置」を他の桁から当てはめられる
       （4〜5桁分の参照点があり、内挿で済むことが多い）。桁数不明（可変長）だと
       参照点が少なく（最少2つ）、まとまりが先頭・末尾にあると外挿になり信頼性が
       落ちる（実際、2参照点からの外挿で先頭のゴーストの方を残し本物の桁を
       落とす誤判定をテストで確認した）。そのため可変長では位置の当てはめを
       使わず、より単純で外挿に頼らない「幅の自然さ」だけで決める
       （pickByWidth）。 */
    const drop = L ? pickByPositionFit(groups) : pickByWidth(groups);
    if (!drop || !drop.size) return null;
    return {
      text: charBoxes.filter((_, i) => !drop.has(i)).map(b => b.text).join(''),
      dropped: charBoxes.filter((_, i) => drop.has(i)),
    };
  }
  /* まとまりが本当に「1つの字形の断片」かを検算する（固定長・可変長の共通ガード）。
     1つでも怪しいまとまりがあれば、その中から代表1つを選ぶ操作自体が本物の字形を
     消す危険があるため、修復全体を諦める（安全側に倒す）。判断材料は必ず診断ログへ
     出す。実機で誤判定が起きたとき、矩形の羅列だけでは「なぜ畳んだ／畳まなかったか」
     が追えず、原因究明のたびに実データの提供をお願いすることになるため
     （しきい値の根拠となる実測値との突き合わせをログだけで行えるようにする）。 */
  function clusterTooWide(groups, logPrefix) {
    const widthOf = p => p.b.x1 - p.b.x0;
    const soloWidths = groups.filter(g => g.length === 1).map(g => widthOf(g[0]));
    const ref = medianOf(soloWidths.length ? soloWidths : groups.flat().map(widthOf));
    if (!ref) return false;
    let reject = false;
    for (const g of groups) {
      if (g.length < 2) continue;
      const span = Math.max(...g.map(p => p.b.x1)) - Math.min(...g.map(p => p.b.x0));
      const ratio = span / ref;
      /* 断片同士の白い隙間。同じ字形の二重検出なら重なるか接する（≦0）のが実測。
         正の隙間が空いている＝物理的に別々のインク＝別々の字形の証拠。 */
      const sorted = [...g].sort((a, b) => a.b.x0 - b.b.x0);
      const holes = sorted.slice(1).map((p, k) => p.b.x0 - sorted[k].b.x1);
      const maxHole = Math.max(...holes);
      const wide = ratio >= GLYPH_CLUSTER_SPAN_MAX_RATIO;
      const apart = maxHole > GLYPH_CLUSTER_GAP_MAX_RATIO * ref;
      if (wide || apart) reject = true;
      console.log(`${logPrefix} まとまり[${g.map(p => p.b.text).join('+')}] `
        + `広がり${span}px = 字形1つ分(${Math.round(ref)}px)の${ratio.toFixed(2)}倍 `
        + `断片間の隙間[${holes.join(',')}]px`
        + (apart ? ` → 隙間が字形幅の${GLYPH_CLUSTER_GAP_MAX_RATIO * 100}%(${Math.round(GLYPH_CLUSTER_GAP_MAX_RATIO * ref)}px)超。別々の字形と判断し修復を中止` : '')
        + (wide ? ` → ${GLYPH_CLUSTER_SPAN_MAX_RATIO}倍以上に広がっている。別々の字形と判断し修復を中止` : ''));
    }
    return reject;
  }
  /* 固定長ルール向け: 断片を含まないまとまりだけから「等間隔に並ぶはずの位置」
     （中心 ≒ 切片 + ピッチ×番号）を当てはめる。左端のゴミを巻き込んで太った
     矩形など外れ値があっても効くよう、全ペアの傾きと切片の中央値で求める。 */
  function pickByPositionFit(groups) {
    const solo = groups.map((g, gi) => ({ gi, c: g[0].c, single: g.length === 1 })).filter(s => s.single);
    if (solo.length < 2) return null;
    const slopes = [];
    for (let a = 0; a < solo.length; a++) {
      for (let b = a + 1; b < solo.length; b++) slopes.push((solo[b].c - solo[a].c) / (solo[b].gi - solo[a].gi));
    }
    const fitPitch = medianOf(slopes);
    if (!fitPitch || fitPitch <= 0) return null;
    const base = medianOf(solo.map(s => s.c - fitPitch * s.gi));
    if (base === null) return null;

    const drop = new Set();
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.length < 2) continue;
      const want = base + fitPitch * gi;
      const ranked = g.map(p => ({ p, off: Math.abs(p.c - want) })).sort((a, b) => a.off - b.off);
      /* 当てはめた位置から遠すぎる＝そもそも規則性の推定が怪しい。 */
      if (ranked[0].off > GLYPH_SLOT_TOLERANCE * fitPitch) return null;
      for (const r of ranked.slice(1)) drop.add(r.p.i);
    }
    return drop;
  }
  /* 可変長ルール向け: 断片を含まないまとまり（幅）の中央値に対して、
     まとまり内の各候補が「補正なしでどれだけ自然な幅か」で決める。
     位置の当てはめ（pickByPositionFit）は参照点が少ない可変長では外挿に
     頼りがちで信頼できないため使わない。上位2つの幅の差が乏しい場合は
     決められないとみなし、そのまとまりごと諦める（無理に選ばない）。 */
  function pickByWidth(groups) {
    const widthOf = g => g.b.x1 - g.b.x0;
    const soloWidths = groups.filter(g => g.length === 1).map(g => widthOf(g[0]));
    const basis = soloWidths.length ? soloWidths : groups.flat().map(widthOf);
    const median = medianOf(basis);
    if (!median) return null;

    const drop = new Set();
    for (const g of groups) {
      if (g.length < 2) continue;
      /* まとまり中に基準幅よりずっと太い矩形がある＝複数の本物の字形が接触して
         1つの矩形にまとまった疑いが強く、1文字への絞り込み自体が信頼できない
         （GLYPH_MERGED_WIDTH_RATIO参照）。 */
      if (Math.max(...g.map(widthOf)) >= GLYPH_MERGED_WIDTH_RATIO * median) return null;
      const ranked = g.map(p => ({ p, dev: Math.abs(widthOf(p) - median) })).sort((a, b) => a.dev - b.dev);
      if (ranked[1].dev - ranked[0].dev < GLYPH_WIDTH_MARGIN * median) return null;
      for (const r of ranked.slice(1)) drop.add(r.p.i);
    }
    return drop;
  }
  /* 固定長ルール向け: ピッチを「大きい方から桁数-1個」の間隔の中央値で見積もり
     （小さい間隔＝断片同士なので混ぜると過小評価される）、ピッチの半分未満の
     間隔をひとかたまりにする。まとまりの数が桁数と一致しない場合は別の要因
     （前後の本物のゴミ等）が混ざっているとみなし null を返す。 */
  function groupByExpectedLen(items, gaps, L) {
    if (gaps.length < L - 1) return null;
    const pitch = medianOf([...gaps].sort((a, b) => b - a).slice(0, L - 1));
    if (!pitch || pitch <= 0) return null;
    const groups = [[items[0]]];
    for (let k = 1; k < items.length; k++) {
      if (items[k].c - items[k - 1].c < GLYPH_MERGE_PITCH_RATIO * pitch) groups[groups.length - 1].push(items[k]);
      else groups.push([items[k]]);
    }
    return groups.length === L ? groups : null;
  }
  /* 隣接する矩形が物理的に重なっている（同じ横位置を取り合っている）とみなす
     重なり率（狭い方の幅に対する比）。2文字が印字上・本当に重なることは
     無いので、これを超える重なりは「同じ字形を二重に検出した」ことの直接
     証拠になる（実機ログで確認: "704"の"7"が"7"+ゴースト"1"の2検出に分裂
     した例で、重なりは狭い方(ゴースト)の幅のちょうど50%だった）。間隔の
     自然な境目（GLYPH_NATURAL_BREAK_MIN_RATIO）と違い、他の桁との比較なしに
     2矩形だけで判定できるため、可変長で参照点が少ない場合でも効く。 */
  const GLYPH_OVERLAP_MERGE_RATIO = 0.3;

  /* 可変長ルール向け（期待桁数が無い金額欄等）: 桁数を仮定できないため、
     ①物理的な重なり、②間隔の分布から見つかる自然な境目、の2つの根拠で
     「同じ字形の断片」を判定する。
     ①は上記の通り2矩形だけで判定できる直接証拠。②は間隔を昇順に並べ、
     隣り合う値の比が最も大きく開く箇所（自然な境目・1次元のJenks breaksに
     相当）を探し、それより小さい間隔だけを断片とみなす方式で、重なっては
     いないが明らかに詰まっている断片（実機ログの"AB0684"の3分割例等）を
     拾うために残している。境目の飛び幅が乏しい（全体になだらか）場合は
     ②の根拠は使えないが、①（重なり）だけでも判定は成立する。

     固定長ルールと違い「桁数が合うまとまり数に絞り込む」検算が使えないため
     （可変長は最終的に何文字になるべきか分からない）、②のしきい値は保守的に
     取る。実測（固定長の実機ログ3件）では本物の間隔が48〜53pxに対し断片が
     2.5〜14.5pxで、比にすると3.3倍以上あった。一方、単に「別々の本物の
     文字がたまたま少し詰まっている」場合の間隔の揺れは経験上2倍未満に収まる
     ため、その中間である3.0倍を境目の採用ラインとする（これ未満の飛び幅は
     「断片が混じっている」と決め打つ根拠として弱いとみなし、①が無ければ
     手を出さない）。 */
  const GLYPH_NATURAL_BREAK_MIN_RATIO = 3.0;
  function groupByNaturalGaps(items, gaps) {
    const overlapRatios = items.slice(1).map((cur, k) => {
      const prev = items[k].b, c = cur.b;
      const overlap = Math.min(prev.x1, c.x1) - Math.max(prev.x0, c.x0);
      const narrow = Math.min(prev.x1 - prev.x0, c.x1 - c.x0);
      return narrow > 0 ? overlap / narrow : 0;
    });

    let gapThreshold = null;
    if (gaps.length >= 2) {   // 比較対象が2つ以上あれば「狭い/広い」の境目を探せる
      const sorted = [...gaps].sort((a, b) => a - b);
      let breakIdx = -1, breakRatio = GLYPH_NATURAL_BREAK_MIN_RATIO;
      for (let i = 0; i + 1 < sorted.length; i++) {
        const ratio = (sorted[i + 1] + 1) / (sorted[i] + 1);
        if (ratio > breakRatio) { breakRatio = ratio; breakIdx = i; }
      }
      if (breakIdx >= 0) gapThreshold = (sorted[breakIdx] + sorted[breakIdx + 1]) / 2;
    }

    const groups = [[items[0]]];
    for (let k = 1; k < items.length; k++) {
      const byOverlap = overlapRatios[k - 1] >= GLYPH_OVERLAP_MERGE_RATIO;
      const byGap = gapThreshold != null && (items[k].c - items[k - 1].c) < gapThreshold;
      if (byOverlap || byGap) groups[groups.length - 1].push(items[k]);
      else groups.push([items[k]]);
    }
    return groups.length < items.length ? groups : null;   // 何も併合されなければ判定材料なし
  }

  /* ── 字形検証: 「1」と読まれた字形が本当は「7」ではないかを画素で確かめる ──
     背景: 縦棒がほぼ垂直な書体（Courier系等幅など）の「7」は、LSTMに字形丸ごと
     「1」と誤分類されることがある（実機の"704"→"104"。矩形の個数も幅も正常で、
     白枠の追加や、別前処理画像（痩せ版）での読み直しでも「104」のまま直らない
     頑固なケースが実在する）。OCRで読み直す限り、同じ絵を見ている誤りは相関して
     しまうため、この1↔7だけはOCRに頼らず字形の物理的性質で判定する:
       「7」の上部横バーは標準的な数字幅のほぼ全域を塗るが、
       「1」の上部（旗＋縦棒）はどの書体でもそこまで届かない。
     メトリクスは「字形上部28%の行の最長連続インクラン長 ÷ Wref」。
       ・最長連続ランなので、隣の字形の欠片が矩形に紛れ込んでも値が膨らまない
       ・Wref（標準的な数字幅）は同じ読み取り結果の「1以外の数字」矩形幅の中央値
         ＝同一書体・同一条件の実測値。比較対象が無い値（1だけ等）は判定しない
     さらに前提条件として、字形幅がWrefの72%〜130%の範囲内であることも要求する
     （下限: ほとんどの書体の本物の1は細く、画素を見るまでもなく除外できる。
      上限: 幅がWrefを大きく超える矩形は、隣の字形の断片が紛れ込んで矩形自体が
      壊れている可能性が高く、上部バー率の値も信頼できないため対象外にする）。

     しきい値の実測（本番の前処理パイプライン全体を通した17書体×サイズ6×ブラー4
     ×値13種、幅が正常範囲(0.72〜1.3)の字形のみ、計約2800件）:
       当初、単一文字だけを理想的に描画した簡易実測（1の最大0.720/7の最小0.815）
       から0.78を採用したが、本番と同じ前処理（フィールド全体を描画→行トリム→
       拡大→二値化→白枠）を通した条件で再実測したところ、本物の「1」でも
       LiberationMono等の一部書体・小サイズでratio=0.78〜0.84に達する例が
       見つかり、実際に本物の"71"を"77"に誤って書き換える事故（誤フリップ）が
       発生した。「1」を誤って"7"にする害（正しく読めていた値を壊す）は、
       「7」を検出し損ねる害（元々読めなかった値が読めないまま）より遥かに
       重いため、閾値を0.85まで引き上げた。この設定で同データセットの「1」の
       誤フリップは0件（1452件中）、「7」の正しい検出率は96.6%を維持する
       （0.78時点の98.6%からの低下は許容する）。実機の"704"→"104"の再現
       ケース（頑固8件）は0.85でも全件検出できることを確認済み。 */
  const SEVEN_TOPBAR_MIN_RATIO = 0.85;   // 上部バー率がこれ以上なら「7」と判定
  const SEVEN_TOPBAR_TOP_FRAC  = 0.28;   // 「上部」= 字形の実インク高さの上から28%
  const SEVEN_WIDTH_MIN_RATIO  = 0.72;   // 判定の前提: 字形幅 ≥ Wref×この値
  const SEVEN_WIDTH_MAX_RATIO  = 1.3;    // 判定の前提: 字形幅 ≤ Wref×この値（隣接字形の混入を除外）

  /** 矩形内の画素から「上部の最長連続インクラン ÷ wref」を求める。 */
  function sevenTopBarRatio(canvas, box, wref) {
    const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
    const x1 = Math.min(canvas.width, Math.ceil(box.x1)), y1 = Math.min(canvas.height, Math.ceil(box.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return 0;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
    /* 白地合成の輝度<128をインクとする（本線・変種とも白背景の画像なので固定で足りる） */
    const ink = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
      const a = d[i + 3] / 255;
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
      ink[p] = lum < 128 ? 1 : 0;
    }
    /* 矩形はTesseract報告のままだと余白を含むことがあるため、実インクの上下端に詰める */
    let top = -1, bottom = -1;
    for (let y = 0; y < h && top < 0; y++) { for (let x = 0; x < w; x++) if (ink[y * w + x]) { top = y; break; } }
    for (let y = h - 1; y >= 0 && bottom < 0; y--) { for (let x = 0; x < w; x++) if (ink[y * w + x]) { bottom = y; break; } }
    if (top < 0) return 0;
    const rows = Math.max(1, Math.ceil((bottom - top + 1) * SEVEN_TOPBAR_TOP_FRAC));
    let best = 0;
    for (let y = top; y < top + rows && y <= bottom; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        if (ink[y * w + x]) { run++; if (run > best) best = run; }
        else run = 0;
      }
    }
    return best / wref;
  }

  /** 「1」と読まれた各字形を画素検証し、7と判定されれば置換した文字列を返す。
      置換が1つも無ければ null。canvas はその矩形群を生成したOCR入力画像。 */
  function fixSevenReadAsOne(canvas, boxes, logPrefix) {
    if (!canvas || !Array.isArray(boxes) || boxes.length < 2) return null;
    const otherWidths = boxes.filter(b => b.text >= '0' && b.text <= '9' && b.text !== '1')
                             .map(b => b.x1 - b.x0);
    /* 基準幅(wref)の根拠が1個だけだと、その1個自体が破損（隣接文字が滲んで
       融合した等）していた場合に無防備になる。936ケース回帰で見つかった
       残存誤フリップ('1,000'→70, LiberationMono/11px/blur0.7)はまさにこの
       ケースで、本来3個あるはずの'0'がrepairViaBoxesの分割統合処理で1個
       (幅17px)に潰され、その単独の幅がそのままwrefとして採用されていた。
       2個以上の裏付けを必須にすることで、この誤フリップは実測でゼロになり、
       正しい「7」検出（頑固197ケース・936ケース双方）には影響しないことを
       確認済み。 */
    if (otherWidths.length < 2) return null;
    const wref = medianOf(otherWidths);
    if (!wref || wref < 4) return null;   // 数px程度では画素検証の分解能が無い
    let flipped = 0;
    const texts = boxes.map(b => {
      if (b.text !== '1') return b.text;
      const w = b.x1 - b.x0;
      if (w < SEVEN_WIDTH_MIN_RATIO * wref) return b.text;   // 細い＝本物の1
      if (w > SEVEN_WIDTH_MAX_RATIO * wref) return b.text;   // 太すぎ＝隣接字形の混入で矩形自体が信用できない
      const ratio = sevenTopBarRatio(canvas, b, wref);
      if (ratio >= SEVEN_TOPBAR_MIN_RATIO) {
        console.log(`${logPrefix} 字形検証: 「1」[${b.x0}-${b.x1}]は上部バー率${ratio.toFixed(2)}`
          + `≥${SEVEN_TOPBAR_MIN_RATIO}（幅${b.x1 - b.x0}px/基準${Math.round(wref)}px）→「7」に修正`);
        flipped++;
        return '7';
      }
      return b.text;
    });
    return flipped ? texts.join('') : null;
  }

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

  /* ── 帳票判定の段階的な角度探索 ───────────────────────────
     判定は「テンプレート数 × 角度数 × スケール数」の掛け算で効き、実測では
     1ページ7.5秒のうち2.3秒（105回の照合＝7テンプレ×5角度×3スケール）を
     占める最大の工程だった。一方、フラットベッドスキャナー運用では実測ログの
     採用角度が一貫して0°で、±1°・±2°の探索は毎回ほぼ空振りしている。

     そこで「まず0°だけ照合し、確信を持って採用できたらそこで止める。
     できなければ残りの角度も照合して併合する」という2段階にする。
     matchAllは全 角度×スケール の中の最大スコアを返すので、角度集合を分割して
     呼び出し、スコアの大きい方で併合した結果は、一度に全角度を探索したのと
     数学的に完全に同じになる（matcher.match_allのdocstring参照）。つまり
     打ち切らなかった場合の精度・結果は現状と1ビットも変わらず、二度手間にも
     ならない。近似が入るのは「打ち切ったとき」だけなので、その条件を
     既定のしきい値よりかなり厳しく取る（下記）。 */
  /* 0°だけで打ち切ってよい確信度・1位2位差。voting.jsの既定（採用は確信度0.70・
     差0.06から）よりはっきり厳しくし、少しでも曖昧なら全角度を探索させる。
     実測の正常ケース（確信度100%・差0.46）は余裕で通り、傾いたページは
     0°でのスコアが落ちるため自然に全角度探索へ回る。 */
  const CLASSIFY_FAST_CONF_MIN   = 0.90;
  const CLASSIFY_FAST_MARGIN_MIN = 0.20;

  /** 2つの照合結果を「スコアの高い方」で併合する（角度集合を分割したぶんを統合）。 */
  function mergeScores(a, b) {
    const out = new Map(a);
    b.forEach((r, id) => { const cur = out.get(id); if (!cur || r.score > cur.score) out.set(id, r); });
    return out;
  }

  async function classify(sourceCanvas, forms, opts = {}) {
    const angleRange = opts.angleRange ?? 2;
    const angleStep  = opts.angleStep  ?? 1;
    const scaleFactors = opts.scaleFactors || CLASSIFY_SCALES;
    const tpls   = await buildAnchorTemplates(forms);
    /* 判定対象の画像も1度だけPNG化して、2段階になっても再圧縮しない。 */
    const imageDataURL = sourceCanvas.toDataURL('image/png');
    const allAngles = [];
    for (let a = -angleRange; a <= angleRange + 1e-9; a += Math.max(0.1, angleStep)) {
      allAngles.push(Math.round(a * 1000) / 1000);
    }
    const hasZero = allAngles.some(a => Math.abs(a) < 1e-9);
    const rest = allAngles.filter(a => Math.abs(a) >= 1e-9);
    /* 0°が探索対象に無い設定（角度をずらして探す特殊な使い方）なら段階分けの
       意味が無いので従来どおり一括で探索する。 */
    if (!hasZero || !rest.length) {
      const scores = await MatcherEngine.matchAll(sourceCanvas, tpls, { angleRange, angleStep, scaleFactors, imageDataURL });
      return { decision: FormVoting.decide(forms, scores, opts.voting || {}), scores };
    }

    const fastScores = await MatcherEngine.matchAll(sourceCanvas, tpls, { angles: [0], scaleFactors, imageDataURL });
    const fastDecision = FormVoting.decide(forms, fastScores, opts.voting || {});
    if (fastDecision.decision === 'accepted'
        && fastDecision.confidence >= CLASSIFY_FAST_CONF_MIN
        && fastDecision.margin >= CLASSIFY_FAST_MARGIN_MIN) {
      console.log(`[classify] 0°のみで確定（確信度${Math.round(fastDecision.confidence * 100)}% 1位2位差${fastDecision.margin.toFixed(2)}）`
        + ` → 残り${rest.length}角度(${rest.join('°,')}°)の照合を省略`);
      return { decision: fastDecision, scores: fastScores };
    }
    console.log(`[classify] 0°では確定できず（判定=${fastDecision.decision} 確信度${Math.round(fastDecision.confidence * 100)}%`
      + ` 1位2位差${fastDecision.margin.toFixed(2)}）→ 残り${rest.length}角度(${rest.join('°,')}°)も照合して併合`);
    const restScores = await MatcherEngine.matchAll(sourceCanvas, tpls, { angles: rest, scaleFactors, imageDataURL });
    const scores = mergeScores(fastScores, restScores);
    return { decision: FormVoting.decide(forms, scores, opts.voting || {}), scores };
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
    /* 傾き補正後の画像のPNG（照合2回＋罫線除去で共用）。アンカーが無い等で
       ローカライズを飛ばした場合は null のままで、罫線除去側が自前で用意する。 */
    let rotatedDataURL = null;
    try {
      const tpls = await Promise.all(anchors.map(async a => ({ id: a.id, a, dataURL: a.dataURL, imageElement: await dataURLtoImg(a.dataURL) })));
      const tplList = tpls.map(t => ({ id: t.id, dataURL: t.dataURL, imageElement: t.imageElement }));
      /* 傾き補正後の画像は、この下の粗探索・細探索・（呼び出し元での）罫線除去で
         まったく同じものを使う。canvas→PNG圧縮はブラウザ側で重く、実測では
         サーバーの実処理の外側に1ページあたり約1.8秒（全体の24%）が消えていた。
         ここで1度だけ用意して使い回す。 */
      const tEnc0 = performance.now();
      rotatedDataURL = rotated.toDataURL('image/png');
      console.log(`[perf]   傾き補正後の画像をPNG化(この後3回分を1回で共用): ${(performance.now() - tEnc0).toFixed(0)}ms`);
      /* 粗→細のスケール探索で「拡大・縮小された帳票」を正しく捉える。
         ① 粗く広い範囲(0.6〜2.0)で各アンカーを個別に探索。
         ② 各アンカー自身の暫定倍率(①の自己ベスト)の周辺(±9%)を、アンカーごとに
            独立して細かく再探索し、位置精度を上げる。
         狭い固定範囲だと大きく拡大された帳票でアンカーを取り逃がすか倍率が範囲端に
         張り付き、離れたOCR欄ほどずれていた。細探索を角度固定・少数スケールで足すだけ
         なので追加コストは小さい。
         ※ 以前は②を「全アンカー中の最良スコア1つ」が決めた単一のprovScaleの周辺に
         全アンカー共有で限定していたが、これは自身の粗探索ベストが他アンカーと
         異なるアンカーを、その本来の近傍から一度も探せなくする副作用があった。
         実測（倍率0.799の誤検出調査）で、スコアが最も高かった「宛先」の粗ベスト
         (倍率0.85)が共有provScaleに採用され、「金額①」は自身の粗ベスト(倍率0.6)
         とは無関係にその狭い範囲(0.85±9%)しか探せず、0.799止まりになっていたことを
         [align-scale]ログで直接確認した。1回のmatchAll呼び出しで済ませるため、
         各アンカーの細探索候補の和集合を渡す（各アンカーは返ってきた結果のうち
         自分にとってベストなものを採用するので、アンカーごとに別々に呼び出すのと
         数学的に同じ結果になる）。 */
      const coarse = await MatcherEngine.matchAll(rotated, tplList,
        { angleRange: 0, angleStep: 1, scaleFactors: LOCALIZE_SCALES, imageDataURL: rotatedDataURL });
      const fineScaleUnion = new Set();
      tpls.forEach(t => {
        const rc = coarse.get(t.id);
        fineScalesAround(rc ? (rc.scale || 1) : 1).forEach(s => fineScaleUnion.add(s));
      });
      const fine = await MatcherEngine.matchAll(rotated, tplList,
        { angleRange: 0, angleStep: 1, scaleFactors: Array.from(fineScaleUnion).sort((a, b) => a - b), imageDataURL: rotatedDataURL });
      /* 診断用ログ: 各アンカーが自身の粗探索ベストの近傍をどれだけ細探索で改善できたか。
         もし依然としてアンカー間で粗ベストの倍率が大きく食い違っているなら、
         それはこの探索範囲の問題ではなく、そのアンカー自体の識別性・画像品質の
         問題である可能性が高い（両方を切り分けるための情報として残す）。 */
      console.log(`[align-scale] 各アンカーが自身の粗探索ベストを中心に独立して細探索（共有provScaleは廃止、細探索候補の和集合${fineScaleUnion.size}点）`);
      tpls.forEach(t => {
        const rc = coarse.get(t.id), rf = fine.get(t.id);
        if (!rc) return;
        console.log(`[align-scale]   "${t.a.name || t.id}" 粗探索(0.6〜2.0の全域)自身のベスト: スコア${rc.score.toFixed(2)} 倍率${rc.scale}`
          + (rf ? ` / 自身の近傍での細探索ベスト: スコア${rf.score.toFixed(2)} 倍率${rf.scale}` : ''));
      });
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
    /* 採用点(kept)の中で、確定した変換に対する残差(dx,dyの絶対値)の最大値。
       RANSAC(ransacInliers)はペア単位の残差で多数決を取るため、複数の目印が
       「たまたま同じ間違った変換」を一貫して支持してしまうケース（帳票内の繰り返し
       パターンで複数の目印が揃って別の場所へ誤マッチする等）を弾けないことがある。
       この場合、除外0点・採用点数は正常でも、確定した変換に対する各点の当てはまりは
       悪いままなので、それを別途チェックして matchQuality.residualHigh に反映する
       （OUTLIER_TOL_PXは「正しく一致した点同士の残差は最大でも数十px」という実測に
       基づく値なので、採用点がこれを超えるのはその前提が崩れているサイン）。 */
    let maxKeptResidual = 0;
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
        if (used) maxKeptResidual = Math.max(maxKeptResidual, Math.abs(dx), Math.abs(dy));
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
      /* 採用点同士が確定した変換と矛盾している（=どれかが本来と別の場所に一致している
         可能性が高い）ことを示すフラグ。droppedOutliers=0・scaleEdge=false・
         weakMatch=falseの「一見正常」な表示でも、複数の目印が帳票内の似た構造
         （繰り返す罫線パターン等）へ揃って誤マッチすると、RANSACの多数決では
         誤マッチ側が「多数派」として採用されてしまうことがある。採用点数や検出倍率
         だけでは分からないため、最終変換への当てはまりの悪さを別途チェックする。 */
      residualHigh: maxKeptResidual > OUTLIER_TOL_PX,
    };

    /* ⑤ 罫線除去（登録された罫線除去パラメータを引き継ぎ） */
    stage('罫線除去', 0.45);
    const params = form.lineRemoval || LineRemovalProcessor.defaultParams();
    const proc   = await LineRemovalProcessor.process(rotated, params, rotatedDataURL);
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
      /* 実際にTesseractへ渡す画像。診断表示（切り出し画像との比較）用に保持する。
         単一値欄は変種（erode/gray）も同じトリム・拡大結果から遅延生成できるようにする */
      const inputSet = single ? buildSingleInputs(cropCanvas) : null;
      const inputCanvas = inputSet ? inputSet.main : ocrInputCanvas(cropCanvas, false);
      const onProg = prog => cb.onOcr && cb.onOcr(oi, regions.length, region.name, prog.status, prog.progress);
      let res = await OcrProcessor.recognize(inputCanvas, usePsm, onProg, useLang, useWl);
      let out = finishText(res, region, rule, active, single);
      let readPsm = usePsm;
      /* 診断: 生データ→制約適用後の値と合否をPSM試行ごとに残す。スクリーンショット
         なしでも「どのPSMで何が読めたか」を診断コピーだけで追跡できるようにする
         （抽出窓の誤選択・途中への1文字混入等の切り分けに使う）。 */
      console.log(`[ocr]   "${region.name}" psm=${usePsm} raw=${JSON.stringify(out.raw)} `
        + `→ ${JSON.stringify(out.text)} valid=${out.constraintValid} lengthSuspicious=${out.lengthSuspicious} ambiguous=${out.ambiguous}`);
      /* 疑わしい欄に限り、文字単位の外接矩形を取り直して「1つの字形を複数に
         分割して読んでしまった」断片を字送りの規則性から特定する。文字種だけでは
         同点で決められない誤読（ambiguous）を解くための追加情報で、pytesseract
         経路ではtesseractの再起動を伴うため疑わしい欄だけで実行する。ここで
         解決できればこの後のPSM読み直し（最大3回のOCR）自体が不要になる。
         金額欄等の可変長ルールは「桁数」という判定材料自体が無いため、
         constraintValid/lengthSuspicious/ambiguousがどれも常にtrue/false側に
         倒れて疑わしさを検知できない（実例: "704"のはずが"7104"・"104"と
         誤読されても、可変長ルールはどちらも普通に受理してしまう）。他に
         安価な判定材料が無い以上、可変長の単一値欄は毎回この矩形チェックに
         回す（固定長欄のような「合否で絞ってから」はできない）。 */
      const norm = active ? CharConstraint.normalize(rule) : null;
      const isVariableSingle = single && !!(norm && norm.variable);
      /* 文字矩形を取り直し、分割字形（1つの字形の二重検出）を修復した読み取りを返す。
         修復不要・修復不能・修復結果が制約を満たさない場合は null。
         本線だけでなくセカンドオピニオンの変種画像にも同じ修復を掛けるため関数化
         （変種側にも "7104" のような二重検出は同様に起こり得る）。 */
      const repairViaBoxes = async (canvas, label) => {
        const boxRes = await OcrProcessor.recognize(canvas, usePsm, onProg, useLang, useWl, true);
        const boxes = boxRes.charBoxes;
        if (!Array.isArray(boxes) || !boxes.length) return null;
        const expectedLen = (norm && !norm.variable) ? norm.len : 0;
        const rep = repairSplitGlyphs((boxRes.fullText || '').trim(), boxes, expectedLen,
          `[ocr]   "${region.name}"${label}`);
        const dropped = new Set((rep ? rep.dropped : []));
        console.log(`[ocr]   "${region.name}"${label} 文字矩形: `
          + boxes.map(b => `${b.text}[${b.x0}-${b.x1}]${dropped.has(b) ? '←除外' : ''}`).join(' '));
        /* ① 分割字形（同じ字形の二重検出）の統合 → ② 残った矩形で字形検証（1↔7） */
        const keptBoxes = boxes.filter(b => !dropped.has(b));
        let text = rep ? rep.text : null;
        const geoText = fixSevenReadAsOne(canvas, keptBoxes, `[ocr]   "${region.name}"${label}`);
        let geoFixed = false;
        if (geoText != null) { text = geoText; geoFixed = true; }
        if (text == null) return null;
        const repRes = { ...boxRes, fullText: text, lines: [{ text, confidence: boxRes.confidence || 0 }] };
        const repOut = finishText(repRes, region, rule, active, single);
        console.log(`[ocr]   "${region.name}"${label} ${geoFixed ? '字形検証を反映' : '分割字形を統合'} `
          + `raw=${JSON.stringify(text)} → ${JSON.stringify(repOut.text)} valid=${repOut.constraintValid} `
          + `lengthSuspicious=${repOut.lengthSuspicious} ambiguous=${repOut.ambiguous}`);
        return (repOut.constraintValid && !repOut.lengthSuspicious && !repOut.ambiguous)
          ? { res: repRes, out: repOut, geoFixed } : null;
      };
      let mainGeoFixed = false;
      if (single && (!out.constraintValid || out.lengthSuspicious || out.ambiguous || isVariableSingle)) {
        const fixed = await repairViaBoxes(inputCanvas, '');
        if (fixed) { res = fixed.res; out = fixed.out; mainGeoFixed = !!fixed.geoFixed; }
      }
      /* 可変長欄のセカンドオピニオン: 別の見え方に加工した画像（変種）で読み直し、
         2対1の多数決で確定する（方式の背景と実測はファイル先頭側の
         「可変長欄のセカンドオピニオン」コメント参照）。
         ・本線と痩せ版(erode)が一致 → そのまま採用（追加コストは1回の読みだけ）
         ・食い違えばグレー版(gray)で三者目を読み、多数派の値を採用
         ・三者三様なら本線の値のまま「要確認」フラグ
         変種の読みが本線と食い違った場合、その食い違いが分割字形（二重検出）の
         せいである可能性があるので、比較の前に変種側も矩形修復を試みる。

         字形検証（fixSevenReadAsOne）が本線の値を修正した場合は多数決を行わない。
         この誤読はOCRがどの画像でも同じ間違いをする（誤りが相関する）ことが実測で
         分かっており、画素という物理的証拠に基づく判定を、相関した多数決で
         覆してしまっては本末転倒のため（変種側の読みも同じ"104"側に倒れ、
         2対1で誤った値に戻してしまう）。 */
      let secondOpinionDiff = null;
      let secondOpinionNote = '';
      if (mainGeoFixed) {
        secondOpinionNote = '字形検証で修正';
      } else if (isVariableSingle && inputSet) {
        const eroCanvas = inputSet.erode();
        const eroRes = await OcrProcessor.recognize(eroCanvas, usePsm, onProg, useLang, useWl);
        let ero = { res: eroRes, out: finishText(eroRes, region, rule, active, single) };
        if (ero.out.text !== out.text) {
          console.log(`[ocr]   "${region.name}" セカンドオピニオン不一致: `
            + `本線=${JSON.stringify(out.text)} / 痩せ版=${JSON.stringify(ero.out.text)} → 修復と三者目で裁定`);
          ero = (await repairViaBoxes(eroCanvas, ' 痩せ版')) || ero;
        }
        if (ero.out.text !== out.text) {
          const grayCanvas = inputSet.gray();
          const grayRes = await OcrProcessor.recognize(grayCanvas, usePsm, onProg, useLang, useWl);
          let gray = { res: grayRes, out: finishText(grayRes, region, rule, active, single) };
          if (gray.out.text !== out.text && gray.out.text !== ero.out.text) {
            gray = (await repairViaBoxes(grayCanvas, ' グレー版')) || gray;
          }
          if (gray.out.text === ero.out.text && ero.out.text) {
            /* 本線だけが少数派 → 多数派（痩せ版・グレー版が一致した値）を採用 */
            console.log(`[ocr]   "${region.name}" 多数決で修正: 本線=${JSON.stringify(out.text)}`
              + ` → 採用=${JSON.stringify(ero.out.text)}（痩せ版・グレー版が一致）`);
            secondOpinionNote = `多数決で修正(本線=${JSON.stringify(out.text)})`;
            res = ero.res; out = ero.out;
          } else if (gray.out.text === out.text) {
            /* 本線が多数派 → 痩せ版の少数意見は棄却（フラグも立てない） */
            console.log(`[ocr]   "${region.name}" 本線を維持: グレー版が本線と一致`
              + `（痩せ版=${JSON.stringify(ero.out.text)}は少数派として棄却）`);
          } else {
            /* 三者三様 → どれも信用できない。本線の値のまま要確認 */
            secondOpinionDiff = ero.out.text;
            console.log(`[ocr]   "${region.name}" セカンドオピニオン三者三様: `
              + `本線=${JSON.stringify(out.text)} / 痩せ版=${JSON.stringify(ero.out.text)}`
              + ` / グレー版=${JSON.stringify(gray.out.text)}`
              + ` （どれが正しいか判定できないため「要確認」にします）`);
          }
        }
      }
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
         変わらない。追加のOCRは疑わしい欄にだけ発生する。

         ただし「制約に合格した＝正しい」ではない点に注意が必要で、実機で次の
         転倒が起きた（注文番号 正解"A94813"）:
           psm6  raw="A948138" → "A94813" ambiguous=true   ← 正解
           psm7  raw="A948138" → "A94813" ambiguous=true   ← 正解（独立に一致）
           psm8  raw="AQ4813"  → "AQ4813" ambiguous=false  ← 誤り。だが合格
         psm8は"9"を"Q"と読み違えた結果ちょうど6桁になり、抽出（どの1文字を
         落とすか）が不要になったためambiguousが立たず、「唯一の合格者」として
         正解を上書きしてしまった。桁数がたまたま揃った誤読は、合否だけでは
         正しい読みと区別できない。

         そこで、合格した再読取りを採用する前に「元の読みと矛盾していないか」を
         見る。この読み直しが本来救おうとしているのは、上のコメントにあるとおり
         「汚れや字間を余分な1文字として拾ってしまう」失敗であり、その場合の
         再読取りの生データは元の生データから文字を落としただけ＝部分列になる
         （AL24521→AL2451、JIL3331→JL3331）。逆に、元の生データに一度も現れて
         いない文字を持ち込む再読取り（A948138に無い"Q"）は、切り出し方ではなく
         字形の解釈そのものが違っており、本来の救済対象ではない。
         よって、元の読みが他のPSMにも裏付けられている（同じ値が2回以上出た）
         場合に限り、部分列になっていない再読取りは採用しない。裏付けが無ければ
         比較対象が無いので従来どおり合格者を採用する（既存の救済は維持される）。 */
      if (single && (!out.constraintValid || out.lengthSuspicious || out.ambiguous)) {
        const baseText = out.text;
        const baseRaw = String(out.raw || '').replace(/\s/g, '');
        let support = 1;   // 元の読みと同じ値が出た回数（元の読み自身を1と数える）
        for (const altPsm of RETRY_PSMS) {
          if (altPsm === usePsm) continue;
          const altRes = await OcrProcessor.recognize(inputCanvas, altPsm, onProg, useLang, useWl);
          const altOut = finishText(altRes, region, rule, active, single);
          console.log(`[ocr]   "${region.name}" psm=${altPsm}(再読取) raw=${JSON.stringify(altOut.raw)} `
            + `→ ${JSON.stringify(altOut.text)} valid=${altOut.constraintValid} lengthSuspicious=${altOut.lengthSuspicious} ambiguous=${altOut.ambiguous}`);
          if (altOut.text === baseText) { support++; continue; }   // 元の読みの裏付けが増えただけ
          if (altOut.constraintValid && !altOut.lengthSuspicious && !altOut.ambiguous) {
            const altRaw = String(altOut.raw || '').replace(/\s/g, '');
            const segmentationOnly = isSubsequenceOf(altRaw, baseRaw);
            if (segmentationOnly || support < 2) { res = altRes; out = altOut; readPsm = altPsm; break; }
            console.log(`[ocr]   "${region.name}" psm=${altPsm}(再読取)は不採用: `
              + `元の読み${JSON.stringify(baseText)}が${support}回一致で裏付けられている一方、`
              + `${JSON.stringify(altRaw)}は元の生データ${JSON.stringify(baseRaw)}に無い文字を含む`
              + `（切り出し方の違いではなく字形の解釈違い）ため信用しない`);
          }
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
        + `valid=${constraintValid} ambiguous=${ambiguous}`
        + (secondOpinionDiff !== null ? ` 別解釈=${JSON.stringify(secondOpinionDiff)}(要確認)` : '')
        + (secondOpinionNote ? ` ${secondOpinionNote}` : ''));
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
        /* 桁数超過・抽出候補の同点（ambiguous）・セカンドオピニオンの三者三様
           （secondOpinionDiff）が読み直しでも解消しなかった場合は、既存の
           「制約不合格」表示に乗せて利用者へ伝える（constraintValid自体は
           trueでも、値としては信用できないことに変わりないため。
           LENGTH_MISMATCH_TOL・extractStrのambiguous判定・
           「可変長欄のセカンドオピニオン」コメントを参照）。 */
        constraintValid: constraintValid && !lengthSuspicious && !ambiguous && secondOpinionDiff === null,
        symbols: res.symbols || [],
        cropDataURL: cropCanvas.toDataURL('image/png'),
        /* 診断: 実際にOCRへ渡した画像（前処理後）と使用パラメータ。
           前処理が効いたか／ゴーストが除けたかを目視で確認できるようにする。
           前処理を通す単一値欄のみPNG化する（他欄は元切り出しとほぼ同一で無駄なため）。 */
        ocrInputDataURL: single ? inputCanvas.toDataURL('image/png') : null,
        ocrInfo: { preprocessed: single, psm: readPsm, retried: readPsm !== usePsm, lang: useLang, whitelist: useWl,
                   /* セカンドオピニオンの裁定結果（'' = 一致または対象外）。UIの診断行に出す */
                   opinion: secondOpinionNote || (secondOpinionDiff !== null ? '不一致(要確認)' : '') },
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
