/* ════════════════════════════════════════════════════════
   matcher_engine.js  画像マッチングエンジン（Pythonサーバー呼び出し版）
   Responsibility: マッチング処理の依頼のみ。DOM 操作なし
   ────────────────────────────────────────────────────────
   以前はOpenCV.js(WASM)でここに直接テンプレートマッチングを実装していたが、
   処理速度向上のためローカルのPythonサーバー（/api/match、matcher.py）
   へ移した。公開関数名・引数・戻り値の形は完全に維持しているため、呼び出し側
   （recognizer.js・studio_app.js）は無修正で動く。アルゴリズム自体（角度×
   スケール探索、コントラストに基づく信頼性減衰）もPython側でこれまでと
   同じ定数・同じ手順のまま動く。
   ════════════════════════════════════════════════════════ */
'use strict';

const MatcherEngine = (() => {

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

  /**
   * canvas または img 要素を PNG dataURL にする（元のcv.imreadが両対応
   * だったのに合わせ、こちらも両方受け付ける）。
   * @param {HTMLCanvasElement|HTMLImageElement} source
   * @returns {string}
   */
  function toDataURL(source) {
    if (source instanceof HTMLCanvasElement) return source.toDataURL('image/png');
    const c = document.createElement('canvas');
    c.width = source.naturalWidth || source.width;
    c.height = source.naturalHeight || source.height;
    c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0);
    return c.toDataURL('image/png');
  }

  /* ── メイン: 傾き補正付き一括マッチング ────────────── */

  /**
   * 登録済みの全テンプレートを、角度×スケールの探索付きで一括照合する。
   *
   * @param {HTMLCanvasElement|HTMLImageElement} fullCanvas  判定対象画像（フル帳票）
   * @param {Array<{
   *   id:           string,
   *   imageElement: HTMLImageElement   // 読み込み済み
   * }>} templates                       照合テンプレート配列
   * @param {object}  opts
   * @param {number}  opts.angleRange    補正角度範囲 ± (度)  default 2
   * @param {number}  opts.angleStep     ステップ (度)         default 1
   * @param {number[]} opts.scaleFactors スケール探索係数      default [1]
   * @returns {Promise<Map<string, {
   *   score: number,
   *   angle: number,
   *   scale: number,
   *   loc:   {x:number, y:number}
   * }>>}  テンプレート id → ベストスコア情報
   */
  async function matchAll(fullCanvas, templates, opts = {}) {
    const angleRange = opts.angleRange ?? 2;
    const angleStep  = Math.max(0.1, opts.angleStep ?? 1);
    const scaleFactors = (Array.isArray(opts.scaleFactors) && opts.scaleFactors.length)
      ? opts.scaleFactors : [1];

    const results = new Map();
    templates.forEach(t => results.set(t.id, { score: -Infinity, angle: 0, scale: 1, loc: { x: 0, y: 0 } }));
    if (!templates.length) return results;

    /* テンプレートは登録時のdataURLをそのまま送れる場合はそれを使う。
       imageElementから作り直すと <img>→canvas→PNG圧縮→base64 を毎回やり直す
       ことになり、同じ絵を何度も再圧縮するだけの純粋な無駄になる
       （呼び出しのたびに全テンプレートぶん発生していた）。 */
    const t0 = performance.now();
    const templatePayload = templates.map(t => ({ id: t.id, image: t.dataURL || toDataURL(t.imageElement) }));
    /* フル画像は、呼び出し側が「同じ絵を複数回照合する」と分かっている場合、
       ImageRef({dataURL,id,send}) を渡せば初回だけ本体を送り、2回目以降は id
       だけで参照できる（サーバー側がidで覚えている。app.py の _resolve_image）。 */
    const ref = opts.image || null;
    const image = ref ? ref.dataURL : toDataURL(fullCanvas);
    const tEnc = performance.now();

    const body = {
      templates: templatePayload,
      angleRange, angleStep, scaleFactors,
      ...(Array.isArray(opts.angles) && opts.angles.length ? { angles: opts.angles } : {}),
      ...(ref ? { imageId: ref.id } : {}),
      ...(!ref || ref.send !== false ? { image } : {}),
    };
    let json = await postJSON('/api/match', body);
    /* サーバーが画像を保持していなければ（再起動・押し出し）本体付きで送り直す。 */
    let resent = false;
    if (json.error === 'IMAGE_CACHE_MISS') {
      resent = true;
      json = await postJSON('/api/match', { ...body, image });
    }
    const tEnd = performance.now();
    if (ref && !json.error) ref.send = false;   // 以降は id 参照でよい
    /* 画像の用意(PNG圧縮)と往復のどちらに時間が掛かっているかを分けて出す。
       サーバー側の[perf]は実処理だけを測るため、両者の差＝この行でしか見えない。 */
    console.log(`[perf]   match encode=${(tEnc - t0).toFixed(0)}ms roundTrip=${(tEnd - tEnc).toFixed(0)}ms`
      + ` (templates=${templates.length}`
      + `${ref ? (body.image ? ', 画像を送信' : ', 画像はサーバー側を参照') : ''}`
      + `${resent ? '/キャッシュ切れのため再送' : ''})`);
    if (json.error) throw new Error(json.error);

    templates.forEach(t => {
      const r = json.results[t.id];
      results.set(t.id, r
        ? { score: r.score, angle: r.angle, scale: r.scale, loc: { x: r.loc.x, y: r.loc.y } }
        : { score: 0, angle: 0, scale: 1, loc: { x: 0, y: 0 } });
    });
    return results;
  }

  /**
   * 各テンプレートが「基準画像の中で一意か」を調べる（登録時の診断用）。
   * 位置合わせ用の目印に必要なのは同じページ内で紛らわしい相手がいないことなので、
   * 最良ピークと、その周辺を除いた次点ピークの差（margin）を返す。この判定は
   * 登録スケール(1.0)のみで行う（既存動作。危険/警告バッジの根拠として使う）。
   *
   * opts.scales を渡すと、追加で「他のスケールでも基準画像内に強い一致がないか」
   * を走査する（matcher.py scan_scales）。等倍では一意でも、他スケールでは
   * 基準画像内の別の場所と酷似する目印を見逃さないための補助情報で、危険/安全の
   * 自動判定はしない（生のスコア・位置をそのまま返し、判断は呼び出し側に委ねる。
   * 理由は scan_scales のdocstring参照）。scales省略時は scan は空のまま。
   *
   * @param {HTMLCanvasElement|HTMLImageElement} refCanvas 基準画像
   * @param {Array<{id:string, imageElement:HTMLImageElement}>} templates
   * @param {{scales?: number[]}} [opts]
   * @returns {Promise<{
   *   results: Map<string, { best:number, bestLoc:{x,y}, second:number, secondLoc:{x,y}, margin:number }>,
   *   scan: Map<string, Array<{ scale:number, best:number, bestLoc:{x,y} }>>
   * }>}
   */
  async function checkUniqueness(refCanvas, templates, opts = {}) {
    const results = new Map();
    const scan = new Map();
    if (!templates.length) return { results, scan };
    const json = await postJSON('/api/anchor-uniqueness', {
      image: toDataURL(refCanvas),
      templates: templates.map(t => ({ id: t.id, image: toDataURL(t.imageElement) })),
      scales: opts.scales && opts.scales.length ? opts.scales : undefined,
    });
    if (json.error) throw new Error(json.error);
    templates.forEach(t => { if (json.results[t.id]) results.set(t.id, json.results[t.id]); });
    if (json.scan) templates.forEach(t => { if (json.scan[t.id]) scan.set(t.id, json.scan[t.id]); });
    return { results, scan };
  }

  /* ── 結果可視化 ─────────────────────────────────────── */

  /**
   * フル画像上のマッチング位置に赤枠を描画したサムネイルキャンバスを返す。
   * 座標は回転補正前の元画像座標なので概算表示となる。
   * （純粋なCanvas2D描画のみで cv 非依存だったため無変更）
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
  return { matchAll, checkUniqueness, drawMatchResult };

})();
