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

  /** 帳票配列から「全アンカー」を matcher 用テンプレート配列へ展開 */
  async function buildAnchorTemplates(forms) {
    const list = [];
    for (const form of forms) {
      for (const a of (form.anchors || [])) {
        list.push({ id: a.id, imageElement: await dataURLtoImg(a.dataURL) });
      }
    }
    return list;
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
    if (active && CharConstraint.isLatinOnly(rule)) return { lang: 'eng', whitelist: '' };
    return { lang: fallbackLang, whitelist: active ? (CharConstraint.derivedWhitelist(rule) || fallbackWhitelist) : fallbackWhitelist };
  }

  /** OCR結果の信頼度（単語別平均、空/0なら領域全体平均で補う）。 */
  function confOf(res) {
    if (res.error) return 0;
    const wordAvg = res.words.length ? res.words.reduce((s, w) => s + w.confidence, 0) / res.words.length : 0;
    return Math.round(wordAvg > 0 ? wordAvg : (res.confidence || 0));
  }

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
    const scores = MatcherEngine.matchAll(sourceCanvas, tpls, { angleRange, angleStep, scaleFactors });
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

    /* ③ 傾き補正 */
    stage('傾き補正', 0.1);
    const angle = matchInfo.angle || 0;
    const rotated = LineRemovalProcessor.rotateCanvas(sourceCanvas, angle);

    /* ④ 原点の再ローカライズ: 全アンカーを角度固定で再マッチ → 相似変換を推定
       （複数アンカーが取れればスケール=拡大率と位置ずれを同時に補正） */
    stage('原点の確定', 0.25);
    const anchors = form.anchors || [];
    const allMatches = [];
    try {
      const tpls = await Promise.all(anchors.map(async a => ({ id: a.id, a, imageElement: await dataURLtoImg(a.dataURL) })));
      /* 角度固定・スケール探索で再マッチ（切り取り倍率の違いを吸収） */
      const m = MatcherEngine.matchAll(rotated, tpls.map(t => ({ id: t.id, imageElement: t.imageElement })),
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

    /* ⑤ 罫線除去（登録された罫線除去パラメータを引き継ぎ） */
    stage('罫線除去', 0.45);
    const params = form.lineRemoval || LineRemovalProcessor.defaultParams();
    const proc   = LineRemovalProcessor.process(rotated, params);
    if (proc.error) {
      LineRemovalProcessor.cleanupMats(proc.mats);
      return { angle, transform, resultCanvas: null, previewMats: [], error: proc.error };
    }
    /* mats[3] = 罫線除去結果。OCR 入力用に独立キャンバスへ描画 */
    const resultCanvas = document.createElement('canvas');
    const resMat = proc.mats[3];
    resultCanvas.width  = resMat.cols;
    resultCanvas.height = resMat.rows;
    LineRemovalProcessor.renderToCanvas(resMat, resultCanvas);

    return { angle, transform, resultCanvas, previewMats: proc.mats, error: null };
  }

  async function runOcr(sourceCanvas, form, matchInfo, opts = {}, cb = {}) {
    const stage = (name, pct) => cb.onStage && cb.onStage(name, pct);

    const prep = await prepare(sourceCanvas, form, matchInfo, cb);
    if (prep.error) {
      return { angle: prep.angle, transform: prep.transform, resultCanvas: null, previewMats: [], fields: [], error: prep.error };
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
      return { region, rule, active: CharConstraint.isActive(rule), lang: p.lang, whitelist: p.whitelist };
    });
    /* 言語切替（worker再初期化）を最小化するため同一言語をまとめて処理する */
    const order = plan.map((_, i) => i).sort((a, b) => (plan[a].lang < plan[b].lang ? -1 : plan[a].lang > plan[b].lang ? 1 : 0));
    const fields = new Array(regions.length);
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi];
      const { region, rule, active, lang: useLang, whitelist: useWl } = plan[i];
      stage(`OCR ${oi + 1}/${regions.length}`, 0.55 + 0.4 * (oi / Math.max(1, regions.length)));
      const cropCanvas = LineRemovalProcessor.extractRect(resultCanvas, mapRect(region, transform));
      if (!cropCanvas) {
        fields[i] = { name: region.name, text: '', confidence: 0, error: '領域の切り出しに失敗しました' };
        continue;
      }
      const res = await OcrProcessor.recognize(cropCanvas, psm, prog => {
        cb.onOcr && cb.onOcr(oi, regions.length, region.name, prog.status, prog.progress);
      }, useLang, useWl);
      const conf = confOf(res);
      let text = (res.fullText || '').trim();
      if (doNorm) text = OcrProcessor.normalize(text);
      if (doKanji) text = OcrProcessor.kanjiToNum(text);
      const raw = text;
      if (region.pattern) text = applyPattern(text, region.pattern);   // 期待書式で抽出
      /* 文字制約による桁別チェック＋誤認補正（O↔0 等）＋前後の余分文字除去 */
      let constraintValid = true;
      if (active) { const cc = CharConstraint.apply(text, rule); text = cc.text; constraintValid = cc.valid; }
      fields[i] = {
        name: region.name,
        text,
        raw,
        confidence: conf,
        error: res.error || null,
        constraint: active ? CharConstraint.describe(rule) : '',
        constraintValid,
        cropDataURL: cropCanvas.toDataURL('image/png'),
      };
    }

    stage('完了', 1);
    return { angle, transform, resultCanvas, previewMats: prep.previewMats, fields, error: null };
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
    const { lang: useLang, whitelist: regWhitelist } = recogParamsFor(rule, lang, whitelist);
    const crop = LineRemovalProcessor.extractRect(resultCanvas, mapRect(region, transform));
    const out = [];
    for (let i = 0; i < psmList.length; i++) {
      const psm = psmList[i];
      if (onProg) onProg(i, psmList.length, psm);
      if (!crop) { out.push({ psm, text: '', confidence: 0, error: '領域切り出し失敗' }); continue; }
      const res = await OcrProcessor.recognize(crop, psm, () => {}, useLang, regWhitelist);
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
