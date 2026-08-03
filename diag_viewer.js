/* ════════════════════════════════════════════════════════
   diag_viewer.js  診断ログのHTML整形ビュー
   Responsibility: 診断ログ（テキスト）を解析してHTML文字列を組み立てるのみ。
     DOM への挿入・モーダルの開閉は呼び出し側（studio_app.js）が行う。
   ────────────────────────────────────────────────────────
   「診断情報をコピー」はテキストをそのまま会話に貼り付けるには便利だが、
   利用者自身がその場でログを読んで状況を理解するには向かない。特に[align]
   （位置合わせ）行は「基準座標→一致座標・ずれ・スコア・検出倍率」と情報密度が
   高く、生テキストのままでは「どの目印が怪しいのか」を読み取るのに慣れが要る。
   ここでは[align]行を表形式にしてズレの大きい目印を色分けするだけでなく、
   採用された目印同士の2点間ペアから逆算した倍率も併記する。帳票内の複数の
   目印が「たまたま同じ間違った変換」を一貫して支持してしまうケース（実例:
   4点とも77%で一致したが、広く離れた2点だけを見ると実際にはほぼ100%だった）
   は、採用点の一覧だけを眺めても気づきにくく、ペア同士の倍率を比較して
   初めて「採用された77%より、100%に近いペアがある」と分かるため。
   ════════════════════════════════════════════════════════ */
'use strict';

const DiagViewer = (() => {

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* recognizer.js の OUTLIER_TOL_PX と同じ値（「正しく一致した点同士の残差は
     最大でも数十px」という実測に基づく閾値）。診断ビューアは表示専用の別モジュール
     のため、recognizer.js の値を直接参照できず、ここに同じ値を再掲する。
     recognizer.js 側で値を変更した場合はここも合わせること。 */
  const OUTLIER_TOL_PX = 40;
  /* ペア推定倍率の比較に使う最小の基準座標差(px)。recognizer.js の
     MIN_SPAN_FOR_SCALE と同じ理由（狭い間隔では数pxの検出誤差で倍率が暴れる）。 */
  const MIN_SPAN_FOR_SCALE = 200;

  /* ── [align] 行のパース ────────────────────────────────
     サマリ行: [align] 基準画像 WxH → 入力 WxH / 変換 倍率SxSy 平行移動(tx,ty) 採用N点 除外M点
     各点行  : [align]   採用|除外 "名前" 基準(rx,ry) → 一致(ix,iy) ずれ(dx,dy) スコアS 検出倍率F */
  const RE_SUMMARY = /^\[align\] 基準画像 (\S+) → 入力 (\S+) \/ 変換 倍率([\d.]+)x([\d.]+) 平行移動\((-?\d+),(-?\d+)\) 採用(\d+)点 除外(\d+)点$/;
  const RE_POINT = /^\[align\]\s+(採用|除外) "([^"]*)" 基準\((-?\d+),(-?\d+)\) → 一致\((-?\d+),(-?\d+)\) ずれ\((-?\d+),(-?\d+)\) スコア([\d.]+) 検出倍率([\d.]+)$/;

  function parseAlignBlocks(lines) {
    const blocks = [];
    let cur = null;
    lines.forEach(line => {
      const s = RE_SUMMARY.exec(line);
      if (s) {
        cur = {
          refSize: s[1], inSize: s[2], sx: parseFloat(s[3]), sy: parseFloat(s[4]),
          tx: parseInt(s[5], 10), ty: parseInt(s[6], 10),
          nUsed: parseInt(s[7], 10), nDropped: parseInt(s[8], 10),
          points: [],
        };
        blocks.push(cur);
        return;
      }
      const p = cur && RE_POINT.exec(line);
      if (p) {
        cur.points.push({
          used: p[1] === '採用', name: p[2],
          refX: +p[3], refY: +p[4], inX: +p[5], inY: +p[6],
          dx: +p[7], dy: +p[8], score: parseFloat(p[9]), scale: parseFloat(p[10]),
        });
      }
    });
    return blocks;
  }

  /** 採用点の全ペアから軸独立の倍率を逆算し、確定倍率と大きく食い違うペアを探す。
      recognizer.js の pairTransform の簡易版（回転なし・2点のみ）。 */
  function analyzePairs(block) {
    const used = block.points.filter(p => p.used);
    const pairs = [];
    for (let i = 0; i < used.length; i++) {
      for (let j = i + 1; j < used.length; j++) {
        const a = used[i], b = used[j];
        const dxr = b.refX - a.refX, dyr = b.refY - a.refY;
        const wideX = Math.abs(dxr) >= MIN_SPAN_FOR_SCALE;
        const wideY = Math.abs(dyr) >= MIN_SPAN_FOR_SCALE;
        if (!wideX && !wideY) continue;   // どちらの軸も狭すぎて倍率を出せない
        const sx = wideX ? (b.inX - a.inX) / dxr : null;
        const sy = wideY ? (b.inY - a.inY) / dyr : null;
        pairs.push({ a: a.name, b: b.name, sx, sy });
      }
    }
    return pairs;
  }

  function fmtScale(v) { return v == null ? '－' : `${Math.round(v * 100)}%`; }

  function renderAlignBlock(block, idx) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    const sizeMismatch = block.refSize !== block.inSize;
    const rows = block.points.map(p => {
      const maxRes = Math.max(Math.abs(p.dx), Math.abs(p.dy));
      const bad = p.used && maxRes > OUTLIER_TOL_PX;
      return `<tr class="${p.used ? '' : 'diag-row-dropped'}${bad ? ' diag-row-bad' : ''}">
        <td>${esc(p.name)}</td>
        <td>${p.used ? '<span class="diag-tag-used">採用</span>' : '<span class="diag-tag-dropped">除外</span>'}</td>
        <td class="diag-mono">(${p.refX},${p.refY})</td>
        <td class="diag-mono">(${p.inX},${p.inY})</td>
        <td class="diag-mono${bad ? ' diag-text-bad' : ''}">(${p.dx},${p.dy})${bad ? ' <i class="fas fa-triangle-exclamation" title="採用点なのに確定した変換との差が大きい（40px超）"></i>' : ''}</td>
        <td class="diag-mono">${p.score.toFixed(2)}</td>
        <td class="diag-mono">${fmtScale(p.scale)}</td>
      </tr>`;
    }).join('');

    const pairs = analyzePairs(block);
    const confirmedPct = (block.sx + block.sy) / 2;
    const suspiciousPairs = pairs.filter(pr => {
      const vals = [pr.sx, pr.sy].filter(v => v != null);
      return vals.some(v => Math.abs(v - confirmedPct) > 0.15 * confirmedPct);
    });
    let pairsHtml = '';
    if (pairs.length) {
      pairsHtml = `
        <p class="diag-subhdr">採用点どうしのペアから逆算した倍率（参考）</p>
        <p class="diag-note">2点の基準座標が十分離れている(${MIN_SPAN_FOR_SCALE}px以上)組み合わせだけを計算。
          確定倍率(${pct(confirmedPct)})と15%以上食い違うペアは、採用された変換そのものが
          怪しい可能性を示します（複数の目印が帳票内の別の場所へ揃って誤マッチした場合に起こりえます）。</p>
        <table class="diag-table diag-table-sm"><thead><tr><th>目印A</th><th>目印B</th><th>推定倍率(横)</th><th>推定倍率(縦)</th></tr></thead><tbody>
          ${pairs.map(pr => {
            const flag = suspiciousPairs.includes(pr);
            return `<tr class="${flag ? 'diag-row-bad' : ''}">
              <td>${esc(pr.a)}</td><td>${esc(pr.b)}</td>
              <td class="diag-mono${flag ? ' diag-text-bad' : ''}">${fmtScale(pr.sx)}</td>
              <td class="diag-mono${flag ? ' diag-text-bad' : ''}">${fmtScale(pr.sy)}</td>
            </tr>`;
          }).join('')}
        </tbody></table>`;
      if (suspiciousPairs.length) {
        pairsHtml += `<p class="diag-warn-box"><i class="fas fa-triangle-exclamation"></i>
          確定した倍率(${pct(confirmedPct)})と大きく食い違うペアが${suspiciousPairs.length}件あります。
          採用された変換自体が、複数の目印の誤マッチにより歪んでいる可能性があります。
          「レイアウト登録」画面で該当の目印を文字を含む範囲へ描き直すか、削除してください。</p>`;
      }
    }

    return `
      <div class="diag-align-block">
        <div class="diag-align-summary">
          <span class="diag-scale-big${(block.sx < 0.85 || block.sx > 1.22 || block.sy < 0.85 || block.sy > 1.22) ? ' diag-text-bad' : ''}">
            倍率 ${pct(block.sx)}${block.sx !== block.sy ? ` × ${pct(block.sy)}` : ''}
          </span>
          <span class="diag-mono">平行移動(${block.tx},${block.ty}) ／ 採用${block.nUsed}点 除外${block.nDropped}点</span>
          ${sizeMismatch ? `<span class="diag-mono">基準${block.refSize} → 入力${block.inSize}</span>` : ''}
        </div>
        <table class="diag-table"><thead><tr>
          <th>目印</th><th>採否</th><th>基準座標</th><th>一致座標</th><th>ずれ</th><th>スコア</th><th>検出倍率</th>
        </tr></thead><tbody>${rows}</tbody></table>
        ${pairsHtml}
      </div>`;
  }

  /* ── [classify] 行: 帳票自動判定の結果 ──────────────────────────
     複数の帳票（レイアウト）を登録している場合、「間違った帳票が選ばれ、その
     帳票のアンカーが今回の入力とは一致しない」という、[align]セクションだけでは
     見分けられない原因がある。1位と2位のスコア差が小さい場合は、帳票の取り違えを
     疑うよう案内する（studio_app.js logClassifyDecision が出力するログを解析）。 */
  const RE_CLASSIFY = /^\[classify\] 判定=(\S+) 確信度=(\d+)% 採用="([^"]*)"(?: peak=([\d.]+) agg=([\d.]+))?(?: \/ 次点="([^"]*)" agg=([\d.]+)| \/ 次点なし)$/;
  /* 1位と2位のagg差がこの割合未満なら「僅差」として注意を促す。断定的な閾値では
     ないため、UNIQUENESS同様に中立的な表示に留める。 */
  const CLASSIFY_CLOSE_MARGIN_RATIO = 0.20;

  function renderClassifySection(lines) {
    const entries = [];
    lines.forEach(line => {
      const m = RE_CLASSIFY.exec(line);
      if (m) entries.push({
        decision: m[1], confidence: +m[2], formName: m[3],
        peak: m[4] != null ? parseFloat(m[4]) : null, agg: m[5] != null ? parseFloat(m[5]) : null,
        runnerName: m[6] || null, runnerAgg: m[7] != null ? parseFloat(m[7]) : null,
      });
    });
    if (!entries.length) return '';
    /* 同じ設定で繰り返し実行されることが多いため、直近1件だけを主表示にし、
       残りは生ログとして折りたたむ（[align]と同様、最新の状態が分かればよい）。 */
    const last = entries[entries.length - 1];
    const closeCall = last.runnerName && last.agg != null && last.runnerAgg != null
      && (last.agg - last.runnerAgg) < CLASSIFY_CLOSE_MARGIN_RATIO * last.agg;
    return `
      <p class="diag-subhdr">帳票自動判定</p>
      <div class="diag-align-block">
        <div class="diag-align-summary">
          <span class="diag-mono">判定=${esc(last.decision)} ／ 確信度${last.confidence}%</span>
        </div>
        <table class="diag-table"><thead><tr><th></th><th>帳票名</th><th>peak</th><th>agg</th></tr></thead><tbody>
          <tr><td>採用</td><td>${esc(last.formName)}</td><td class="diag-mono">${last.peak != null ? last.peak.toFixed(2) : '－'}</td><td class="diag-mono">${last.agg != null ? last.agg.toFixed(2) : '－'}</td></tr>
          ${last.runnerName ? `<tr class="${closeCall ? 'diag-row-bad' : ''}"><td>次点</td><td>${esc(last.runnerName)}</td><td class="diag-mono">－</td><td class="diag-mono${closeCall ? ' diag-text-bad' : ''}">${last.runnerAgg.toFixed(2)}</td></tr>` : ''}
        </tbody></table>
        ${closeCall ? `<p class="diag-warn-box"><i class="fas fa-triangle-exclamation"></i>
          採用した帳票「${esc(last.formName)}」と次点「${esc(last.runnerName)}」のスコア差が僅かです。
          もし位置合わせや読み取り結果がおかしい場合、実は次点の帳票の方が正しい可能性があります。
          「OCR実行」画面で帳票を手動選択し、次点の帳票でも試してみてください。</p>` : ''}
        ${entries.length > 1 ? `<p class="diag-note">直近の判定のみ表示（計${entries.length}回分のログあり）</p>` : ''}
      </div>`;
  }

  /* ── [ocr] 行: 領域名でグルーピングして時系列のまま表示 ──────────── */
  const RE_OCR_NAME = /^\[ocr\]\s+"([^"]*)"\s?(.*)$/;
  function renderOcrSection(lines) {
    const groups = [];   // [{ name, items:[text,...] }]
    const byName = new Map();
    lines.forEach(line => {
      const m = RE_OCR_NAME.exec(line);
      if (!m) return;
      const [, name, rest] = m;
      if (!byName.has(name)) { const g = { name, items: [] }; byName.set(name, g); groups.push(g); }
      byName.get(name).items.push(rest);
    });
    if (!groups.length) return '';
    return `<p class="diag-subhdr">OCR結果（領域ごと）</p>` + groups.map(g => `
      <div class="diag-ocr-card">
        <div class="diag-ocr-name">${esc(g.name)}</div>
        <ul class="diag-ocr-lines">${g.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`).join('');
  }

  /* ── その他の行: プレフィックス別に色分けしたリスト ──────────────── */
  function renderRawSection(title, lines, cls) {
    if (!lines.length) return '';
    return `<details class="diag-details">
      <summary>${esc(title)} (${lines.length}行)</summary>
      <div class="diag-raw ${cls || ''}">${lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
    </details>`;
  }

  /**
   * 診断ログ全文（copyDiagnostics と同じテキスト）を解析し、モーダル本体用の
   * HTML文字列を返す。
   * @param {string} text
   * @returns {string}
   */
  function render(text) {
    const lines = String(text || '').split('\n');
    const headLines = [];
    const perfLines = [], healthLines = [], warnLines = [], errLines = [], ocrLines = [], alignLines = [], classifyLines = [], otherLines = [];
    let inHeader = true;
    lines.forEach(line => {
      if (line.startsWith('--- サーバー') || line.startsWith('--- ブラウザ')) { inHeader = false; return; }
      if (inHeader) { headLines.push(line); return; }
      if (line.startsWith('[align]')) alignLines.push(line);
      else if (line.startsWith('[classify]')) classifyLines.push(line);
      else if (line.startsWith('[ocr]')) ocrLines.push(line);
      else if (line.startsWith('[perf]')) perfLines.push(line);
      else if (line.startsWith('[health]')) healthLines.push(line);
      else if (line.startsWith('[warn]')) warnLines.push(line);
      else if (line.toLowerCase().includes('error') || line.startsWith('[error]')) errLines.push(line);
      else if (line.trim()) otherLines.push(line);
    });

    const classifyHtml = renderClassifySection(classifyLines);
    const alignBlocks = parseAlignBlocks(alignLines);
    const alignHtml = alignBlocks.length
      ? `<p class="diag-subhdr">位置合わせ（目印マッチング）</p>${alignBlocks.map(renderAlignBlock).join('')}`
      : '';
    const ocrHtml = renderOcrSection(ocrLines);

    const headHtml = headLines.filter(l => l.trim()).map(l => `<div>${esc(l)}</div>`).join('');
    const warnHtml = warnLines.length
      ? `<div class="diag-warn-box">${warnLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : '';
    const errHtml = errLines.length
      ? `<div class="diag-warn-box diag-warn-box--err">${errLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : '';

    if (!classifyLines.length && !alignBlocks.length && !ocrLines.length && !perfLines.length && !healthLines.length && !warnLines.length) {
      return `<div class="diag-head">${headHtml}</div><p class="diag-loading">認識をまだ実行していないか、ログが空です。「OCR実行」を一度行ってから開き直してください。</p>`;
    }

    return `
      <div class="diag-head">${headHtml}</div>
      ${errHtml}
      ${warnHtml}
      ${classifyHtml}
      ${alignHtml}
      ${ocrHtml}
      ${renderRawSection('速度ログ', perfLines, 'diag-raw-perf')}
      ${renderRawSection('健全性ログ', healthLines, 'diag-raw-health')}
      ${renderRawSection('その他', otherLines, '')}
    `;
  }

  return { render };

})();
