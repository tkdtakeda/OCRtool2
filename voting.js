/* ════════════════════════════════════════════════════════
   voting.js  帳票自動判定ロジック
   Responsibility: 「どの帳票か」をスコアから決定する純粋関数のみ。
                   DOM 操作・OpenCV 依存なし（単体テスト可能）。
   ────────────────────────────────────────────────────────
   設計方針（ユーザー提案ルールの弱点を補う）:
   ─ 提案ルール「上位5中・上位3に同一2件以上 かつ 全体半数以上」は
     ランク(順位)のみを見るため、(1)スコアの絶対値を無視し弱い一致でも
     採用しうる、(2)アンカー登録数が多い帳票がランキングを占有して
     有利になる、という誤判定リスクがある。
   ─ 本実装は「スコア加重集約 + 確信度 + 棄却(abstention)」を採用:
       * 帳票ごとに最良アンカースコア(peak)を主証拠とする
       * 複数アンカーの裏付け(corroboration)は小さな加点に留め、
         登録数による占有バイアスを排除
       * 1位と2位の差(margin)と絶対スコアから確信度を算出
       * 低確信なら『要確認(review)』、最良でも閾値未満なら
         『不一致(rejected)』として人手確認に回す
   ─ 提案ルールの判定結果も legacySignal として併記し、UI で参照可能にする。
   ════════════════════════════════════════════════════════ */
'use strict';

const FormVoting = (() => {

  /* ── 既定パラメータ（UI から上書き可能） ───────────── */
  const defaults = () => ({
    acceptFloor:   0.45,  // これ未満の peak は「不一致」（未登録帳票の可能性）
    acceptConf:    0.70,  // これ以上の確信度で「採用」
    nearExact:     0.90,  // peak がこれ以上なら margin によらず「採用」（ほぼ一致）
    marginMin:     0.06,  // 1位-2位スコア差の最低要件
    corroborateTau:0.40,  // 「裏付けアンカー」とみなすスコア閾値
    corroborateBeta:0.06, // 裏付け1件ごとの peak 加点率（占有バイアス抑制のため小さく）
    confAbsLo:     0.35,  // 確信度算出: 絶対スコアの下限ランプ
    confAbsHi:     0.85,  // 　〃　上限ランプ
    confMarginHi:  0.25,  // 　〃　margin の上限ランプ
    wAbs:          0.6,   // 確信度の重み（絶対スコア）
    wMargin:       0.4,   // 確信度の重み（margin）
  });

  const clamp01 = v => Math.max(0, Math.min(1, v));
  /** lo→hi を 0→1 に線形ランプ（範囲外はクランプ） */
  const ramp = (v, lo, hi) => hi <= lo ? (v >= hi ? 1 : 0) : clamp01((v - lo) / (hi - lo));

  /* ── メイン判定 ─────────────────────────────────────── */
  /**
   * @param {Array<{ id:string, name:string, anchors:Array<{id:string,name:string}> }>} forms
   * @param {Map<string,{score:number,angle:number,loc:{x,y}}>} anchorScores  anchorId→結果
   * @param {object} [opts]  defaults() を上書き
   * @returns {{
   *   decision:'accepted'|'review'|'rejected',
   *   confidence:number,
   *   best:null|{formId,formName,peak,agg,angle,loc,anchorId},
   *   runnerUp:null|{formId,formName,agg},
   *   margin:number,
   *   ranking:Array<object>,
   *   legacySignal:object,
   *   params:object
   * }}
   */
  function decide(forms, anchorScores, opts = {}) {
    const p = { ...defaults(), ...opts };
    const s = id => {
      const r = anchorScores.get(id);
      return r ? Math.max(0, r.score) : 0;   // 負の相関は 0 に丸める
    };

    /* 1) 帳票ごとに集約 */
    const ranking = forms.map(form => {
      const anchors = (form.anchors || []).map(a => {
        const r = anchorScores.get(a.id) || { score: 0, angle: 0, loc: { x: 0, y: 0 } };
        return { id: a.id, name: a.name, score: Math.max(0, r.score), angle: r.angle, loc: r.loc };
      }).sort((x, y) => y.score - x.score);

      const peak    = anchors.length ? anchors[0].score : 0;
      const support = anchors.filter(a => a.score >= p.corroborateTau).length;
      /* 裏付けによる加点は peak を基準にした小さなボーナス（占有バイアス抑制） */
      const agg     = peak * (1 + p.corroborateBeta * Math.max(0, support - 1));
      const top     = anchors[0] || { id: null, angle: 0, loc: { x: 0, y: 0 } };

      return {
        formId:       form.id,
        formName:     form.name,
        peak, support, agg,
        angle:        top.angle,
        loc:          top.loc,
        bestAnchorId: top.id,
        anchors,
      };
    }).sort((a, b) => b.agg - a.agg);

    /* 2) 1位・2位と margin */
    const first  = ranking[0] || null;
    const second = ranking[1] || null;
    const margin = first ? first.agg - (second ? second.agg : 0) : 0;

    /* 3) 確信度（絶対スコア + margin の加重） */
    let confidence = first
      ? clamp01(p.wAbs * ramp(first.peak, p.confAbsLo, p.confAbsHi)
              + p.wMargin * ramp(margin, 0, p.confMarginHi))
      : 0;

    /* 4) 判定。peak が極めて高い（ほぼ一致）なら margin によらず採用する
       ＝同一画像/ほぼ同一画像が「要確認」で止まらないように。確信度も peak に引き上げる。 */
    let decision;
    if (!first || first.peak < p.acceptFloor)          decision = 'rejected';
    else if (first.peak >= p.nearExact)              { decision = 'accepted'; confidence = Math.max(confidence, first.peak); }
    else if (confidence >= p.acceptConf && margin >= p.marginMin) decision = 'accepted';
    else                                               decision = 'review';

    /* 5) ユーザー提案ルール（ランクベース）を補助指標として算出 */
    const legacySignal = computeLegacySignal(forms, anchorScores, first ? first.formId : null);

    return {
      decision,
      confidence,
      best: first ? {
        formId: first.formId, formName: first.formName,
        peak: first.peak, agg: first.agg,
        angle: first.angle, loc: first.loc, anchorId: first.bestAnchorId,
      } : null,
      runnerUp: second ? { formId: second.formId, formName: second.formName, agg: second.agg } : null,
      margin,
      ranking,
      legacySignal,
      params: p,
    };
  }

  /* ── 補助: ユーザー提案ルール（順位ベース） ─────────── */
  /**
   * 上位5アンカー中・上位3に同一帳票2件以上 かつ 上位5の半数以上が同一帳票か。
   * 採用判定には用いず、透明性のため UI 表示する補助指標。
   */
  function computeLegacySignal(forms, anchorScores, candidateFormId) {
    /* anchorId → formId の逆引き */
    const owner = new Map();
    forms.forEach(f => (f.anchors || []).forEach(a => owner.set(a.id, f.id)));

    const flat = [];
    anchorScores.forEach((r, id) => {
      if (owner.has(id)) flat.push({ id, formId: owner.get(id), score: Math.max(0, r.score) });
    });
    flat.sort((a, b) => b.score - a.score);

    const top5 = flat.slice(0, 5);
    const top3 = flat.slice(0, 3);
    const fid  = candidateFormId;

    const top3SameCount = fid ? top3.filter(x => x.formId === fid).length : 0;
    const top5SameCount = fid ? top5.filter(x => x.formId === fid).length : 0;
    const half          = Math.ceil(top5.length / 2);
    const passesUserRule = !!fid && top3SameCount >= 2 && top5SameCount >= half;

    return { top3SameCount, top5SameCount, top5Total: top5.length, half, passesUserRule };
  }

  return { decide, defaults };

})();
