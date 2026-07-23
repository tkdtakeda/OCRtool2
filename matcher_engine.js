/* ════════════════════════════════════════════════════════
   matcher_engine.js  画像マッチングエンジン（Pythonサーバー呼び出し版）
   Responsibility: マッチング処理の依頼のみ。DOM 操作なし
   ────────────────────────────────────────────────────────
   以前はOpenCV.js(WASM)でここに直接テンプレートマッチングを実装していたが、
   処理速度向上のためローカルのPythonサーバー（/api/match、server/matcher.py）
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

    const templatePayload = templates.map(t => ({ id: t.id, image: toDataURL(t.imageElement) }));

    const json = await postJSON('/api/match', {
      image: toDataURL(fullCanvas),
      templates: templatePayload,
      angleRange, angleStep, scaleFactors,
    });
    if (json.error) throw new Error(json.error);

    templates.forEach(t => {
      const r = json.results[t.id];
      results.set(t.id, r
        ? { score: r.score, angle: r.angle, scale: r.scale, loc: { x: r.loc.x, y: r.loc.y } }
        : { score: 0, angle: 0, scale: 1, loc: { x: 0, y: 0 } });
    });
    return results;
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
  return { matchAll, drawMatchResult };

})();
