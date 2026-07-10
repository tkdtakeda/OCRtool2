/* ════════════════════════════════════════════════════════
   studio_ui.js  統合ツール UI レンダラー
   Responsibility: DOM 生成・描画のみ。業務ロジック・状態は持たない。
   ════════════════════════════════════════════════════════ */
'use strict';

const StudioUI = (() => {

  const $ = id => document.getElementById(id);
  const REGION_COLORS = ['#1D6BB0', '#0F7D5E', '#7C3AED', '#B45309', '#BE1818', '#0E6E80'];
  const ANCHOR_COLOR  = '#1D6BB0';
  const OCR_COLOR     = '#7C3AED';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── Toast ──────────────────────────────────────────── */
  const TOAST_ICONS = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
  function toast(message, type = 'info', duration = 2800) {
    const c = $('toastContainer'); if (!c) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<i class="fas ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i><span>${esc(message)}</span>`;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('is-visible'));
    setTimeout(() => { t.classList.remove('is-visible'); setTimeout(() => { try { c.removeChild(t); } catch (_) {} }, 280); }, duration);
  }

  /* ── 登録ステップのチェックリスト ───────────────────── */
  function refreshRegSteps(flags) {
    document.querySelectorAll('#regSteps .reg-step').forEach(el => {
      el.classList.toggle('done', !!flags[el.dataset.k]);
    });
  }

  /* ── 帳票ライブラリ ─────────────────────────────────── */
  function renderFormLibrary(forms, handlers) {
    const c = $('formLibList'); if (!c) return;
    if (!forms.length) { c.innerHTML = '<div class="empty-hint"><i class="fas fa-inbox"></i><span>帳票未登録</span><span style="font-size:.7rem">「新規」で作成 / レイアウト設定JSONをここにドロップで読込</span></div>'; return; }
    c.innerHTML = '';
    forms.forEach(f => {
      const card = document.createElement('div');
      card.className = 'form-card' + (f.isSample ? ' is-sample' : '');
      card.innerHTML = `
        <img src="${f.referenceImage?.dataURL || ''}" alt="">
        <div class="form-card-body">
          <span class="form-card-name">${esc(f.name)}</span>
          <span class="form-card-meta">アンカー${(f.anchors || []).length} / OCR${(f.ocrRegions || []).length}</span>
          <div class="form-card-acts">
            <button class="btn btn-ghost btn-sm" data-act="edit"><i class="fas fa-pen"></i></button>
            <button class="btn btn-ghost btn-sm" data-act="del"><i class="fas fa-trash-can"></i></button>
          </div>
        </div>`;
      card.querySelector('[data-act=edit]').addEventListener('click', e => { e.stopPropagation(); handlers.onEdit(f.id); });
      card.querySelector('[data-act=del]').addEventListener('click', e => { e.stopPropagation(); handlers.onDelete(f.id); });
      card.addEventListener('click', () => handlers.onEdit(f.id));
      c.appendChild(card);
    });
  }

  /* ── 識別アンカー / OCR領域 ミニリスト ──────────────── */
  function renderAnchorList(anchors, onRemove) {
    const c = $('anchorList'); $('anchorCount').textContent = anchors.length;
    if (!anchors.length) { c.innerHTML = '<div class="mini-empty">未登録（左の画像上にドラッグ）</div>'; return; }
    c.innerHTML = '';
    anchors.forEach((a, i) => {
      const item = document.createElement('div'); item.className = 'mini-item';
      item.innerHTML = `
        <span class="midx" style="background:${ANCHOR_COLOR}">${i + 1}</span>
        <img class="mthumb" src="${a.dataURL}" alt="">
        <span class="mname">${esc(a.name)}</span>
        <span class="mpos">${a.refX},${a.refY}</span>
        <button class="btn-icon-sm" title="削除"><i class="fas fa-xmark"></i></button>`;
      item.querySelector('button').addEventListener('click', () => onRemove(a.id));
      c.appendChild(item);
    });
  }

  function renderRegionList(regions, onRemove, onPattern, onEditConstraint) {
    const c = $('ocrRegionList'); $('ocrCount').textContent = regions.length;
    if (!regions.length) { c.innerHTML = '<div class="mini-empty">未登録（OCR領域モードで描画）</div>'; return; }
    c.innerHTML = '';
    regions.forEach((r, i) => {
      const col = REGION_COLORS[i % REGION_COLORS.length];
      const rule = r.charRule || r.constraint;   // 旧形式(文字列)も互換表示
      const active = CharConstraint.isActive(rule);
      const consLabel = active ? `${CharConstraint.lengthLabel(rule)}: ${CharConstraint.describe(rule)}` : '設定する';
      const block = document.createElement('div'); block.className = 'mini-region';
      block.innerHTML = `
        <div class="mini-item">
          <span class="midx" style="background:${col}">${i + 1}</span>
          <span class="mname">${esc(r.name)}</span>
          <span class="mpos">${r.x},${r.y} ${r.w}×${r.h}</span>
          <button class="btn-icon-sm" title="削除"><i class="fas fa-xmark"></i></button>
        </div>
        <button class="mini-cons${active ? ' is-set' : ''}" type="button" title="桁数と各桁の文字を設定">
          <i class="fas fa-keyboard"></i><span class="mini-cons-lbl">文字制約: </span><b class="mini-cons-val"></b>
        </button>
        <input class="mini-pattern" placeholder="抽出パターン(任意) 例: [A-Z]{2}\\d{4}" spellcheck="false">`;
      block.querySelector('.btn-icon-sm').addEventListener('click', () => onRemove(r.id));
      block.querySelector('.mini-cons-val').textContent = consLabel;
      block.querySelector('.mini-cons').addEventListener('click', () => onEditConstraint && onEditConstraint(r.id));
      const inp = block.querySelector('.mini-pattern');
      inp.value = r.pattern || '';
      inp.addEventListener('change', () => onPattern && onPattern(r.id, inp.value));
      c.appendChild(block);
    });
  }

  /* ── パイプライン状態 ───────────────────────────────── */
  const PL_ORDER = ['match', 'decide', 'rotate', 'line', 'ocr'];
  function setPipeline(activeKey, doneKeys = []) {
    document.querySelectorAll('#pipeline .pl-step').forEach(el => {
      const k = el.dataset.pl;
      el.classList.toggle('active', k === activeKey);
      el.classList.toggle('done', doneKeys.includes(k));
    });
  }
  function resetPipeline() { setPipeline(null, []); }

  /* ── 判定パネル ─────────────────────────────────────── */
  const VERDICT_TEXT = { accepted: '採用', review: '要確認', rejected: '不一致' };
  function scoreClass(v) { return v >= 0.8 ? 'hi' : v >= 0.5 ? 'mid' : 'lo'; }

  function renderDecision(result, forms, handlers) {
    $('decisionPanel').classList.remove('hidden');
    const badge = $('dpBadge');
    badge.className = 'dp-badge ' + result.decision;
    badge.textContent = VERDICT_TEXT[result.decision] || '—';

    const confPct = Math.round(result.confidence * 100);
    $('dpConfVal').textContent = confPct + '%';
    $('dpConfBar').style.width = confPct + '%';

    const best = result.best;
    const ls = result.legacySignal;
    let reason;
    if (result.decision === 'accepted') {
      reason = `「${best.formName}」を採用（peak ${best.peak.toFixed(2)} = アンカー一致度, margin ${result.margin.toFixed(2)} = 2位との差）。`;
    } else if (result.decision === 'review') {
      /* なぜ確信度が低いのかを診断的に説明（peak が低い vs margin が小さい） */
      if (best && best.peak < 0.7) {
        reason = `候補「${best.formName}」のアンカー一致度が中程度です（peak ${best.peak.toFixed(2)}）。原因の多くは画像のズレ・サイズ/傾き差・ノイズです。アンカーが入力に鮮明に写っているか、切り取り倍率が大きく違わないか確認を。下の「アンカー別」で低いアンカーが分かります。`;
      } else {
        reason = `候補「${best ? best.formName : '—'}」は一致(peak ${best ? best.peak.toFixed(2) : '0'})していますが、他帳票との差が小さく自動確定できません（margin ${result.margin.toFixed(2)}）。より識別的な領域をアンカーに追加すると安定します。「この帳票でOCR」で続行できます。`;
      }
    } else {
      reason = `十分に一致する帳票がありません（最良 peak ${best ? best.peak.toFixed(2) : '0'}）。未登録の帳票か、アンカーが写っていない可能性があります。`;
    }
    $('dpReason').textContent = reason;

    /* 補助指標（ユーザー提案ルール） */
    /* 内部の補助指標は技術的なため、詳細はツールチップに退避（画面はすっきり） */
    $('dpLegacy').textContent = '';
    $('dpLegacy').title = `補助指標(順位ルール): 上位3に同一${ls.top3SameCount}件 / 上位5に${ls.top5SameCount}件 → ${ls.passesUserRule ? '合致' : '不合致'}`;

    /* 帳票セレクタ */
    const sel = $('dpFormSelect');
    sel.innerHTML = '';
    forms.forEach(f => {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = f.name;
      if (best && f.id === best.formId) o.selected = true;
      sel.appendChild(o);
    });

    /* ランキング */
    const list = $('dpRankList'); list.innerHTML = '';
    result.ranking.forEach((row, i) => {
      const pct = Math.max(0, Math.round(row.peak * 100));
      const cls = scoreClass(row.peak);
      const el = document.createElement('div');
      el.className = 'rank-row' + (best && row.formId === best.formId ? ' is-best' : '');
      el.innerHTML = `
        <div class="rank-no">${i + 1}</div>
        <div class="rank-info">
          <div class="rank-name">${esc(row.formName)}</div>
          <div class="rank-bar-track"><div class="rank-bar sc-${cls}" style="width:${pct}%"></div></div>
          <div class="rank-meta">
            <span class="rank-chip scv-${cls}" title="アンカー画像が入力にどれだけ一致したか">一致度 ${pct}%</span>
            <span class="rank-chip" title="しっかり一致した目印(アンカー)の数">一致した目印 ${row.support}</span>
            <span class="rank-chip" title="補正した傾き"><i class="fas fa-rotate"></i> ${row.angle > 0 ? '+' : ''}${row.angle}°</span>
          </div>
          ${(row.anchors && row.anchors.length) ? `<div class="rank-anchors"><span class="rank-anchors-lbl">目印ごとの一致度:</span>${row.anchors.map(a => `<span class="anchor-chip scv-${scoreClass(a.score)}" title="一致度">${esc(a.name || '目印')} ${Math.round(a.score * 100)}%</span>`).join('')}</div>` : ''}
        </div>`;
      list.appendChild(el);
    });

    handlers && handlers.afterRender && handlers.afterRender();
  }

  /* ── 認識プレビュー（罫線除去結果 + OCR領域重畳） ───── */
  function renderRecogPreview(resultCanvas, transform, regions, angle, zoom = 1) {
    const c = $('recogResultCanvas'); if (!c || !resultCanvas) return 1;
    const wrap = c.parentElement;
    const maxW = (wrap?.clientWidth || 500) - 24;
    const fit = Math.min(1, maxW / resultCanvas.width);   // 横幅フィットを 100% の基準とする
    const scale = Math.max(0.05, fit * zoom);
    c.width = Math.round(resultCanvas.width * scale);
    c.height = Math.round(resultCanvas.height * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(resultCanvas, 0, 0, c.width, c.height);
    const tf = transform || { sx: 1, sy: 1, tx: 0, ty: 0 };
    (regions || []).forEach((r, i) => {
      const col = REGION_COLORS[i % REGION_COLORS.length];
      /* 軸独立スケール変換で入力座標へ写像してから表示スケールを掛ける */
      const rx = Math.round((tf.sx * r.x + tf.tx) * scale);
      const ry = Math.round((tf.sy * r.y + tf.ty) * scale);
      const rw = Math.max(2, Math.round(tf.sx * r.w * scale));
      const rh = Math.max(2, Math.round(tf.sy * r.h * scale));
      ctx.fillStyle = col + '22'; ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillStyle = col; ctx.font = 'bold 10px sans-serif'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${i + 1}.${r.name}`, rx + 2, Math.max(10, ry - 2));
      ctx.textBaseline = 'alphabetic';
    });
    const sxPct = Math.round((tf.sx || 1) * 100), syPct = Math.round((tf.sy || 1) * 100);
    const sizeTxt = (sxPct === syPct) ? `${sxPct}%` : `${sxPct}%×${syPct}%`;
    $('rrAngle').textContent = `傾き ${angle > 0 ? '+' : ''}${angle}° / 倍率 ${sizeTxt} / アンカー${tf.n || 0}点`;
    return scale;
  }

  /* ── OCR フィールド結果 ─────────────────────────────── */
  function confClass(c) { return c >= 85 ? 'hi' : c >= 60 ? 'mid' : 'lo'; }
  /** 文字別の確信度チップ（低信頼の原因箇所が一目で分かる） */
  function symbolChipsHTML(symbols) {
    if (!symbols || !symbols.length) return '<span class="field-syms-empty">（文字別データなし）</span>';
    return symbols.map(s => {
      const t = s.text === ' ' ? '␣' : esc(s.text);
      return `<span class="sym-chip ${confClass(s.confidence)}" title="${s.confidence}%">${t}<small>${s.confidence}</small></span>`;
    }).join('');
  }
  function renderFieldResults(fields) {
    const c = $('fieldResults'); c.innerHTML = '';
    fields.forEach((f, i) => {
      const col = REGION_COLORS[i % REGION_COLORS.length];
      const badge = f.error ? '<span class="conf-badge lo">ERR</span>'
        : `<span class="conf-badge ${confClass(f.confidence)}">${f.confidence}%</span>`;
      /* 文字制約に一致しない（補正でも満たせなかった）場合は注意を表示 */
      const consWarn = (!f.error && f.constraint && f.constraintValid === false && f.text)
        ? `<span class="conf-badge lo" title="文字制約「${esc(f.constraint)}」に一致しません"><i class="fas fa-triangle-exclamation"></i> 制約</span>` : '';
      const row = document.createElement('div');
      row.className = 'field-row'; row.style.animationDelay = `${(i * 0.05).toFixed(2)}s`;
      const txt = f.error ? `[エラー: ${f.error}]` : f.text;
      /* 抽出パターン適用で生テキストと変わった場合は元の値を併記 */
      const rawHint = (f.raw !== undefined && f.raw !== f.text)
        ? `<span class="field-raw" title="抽出パターン適用前">元: ${esc(f.raw || '（空）')}</span>` : '';
      const hasDetail = !!(f.cropDataURL || (f.symbols && f.symbols.length));
      const detailBtn = hasDetail
        ? `<button class="field-detail-btn" title="切り出し画像と文字別の確信度を表示"><i class="fas fa-magnifying-glass-chart"></i></button>` : '';
      row.innerHTML = `
        <div class="field-row-hdr">
          <span class="field-idx" style="background:${col}">${i + 1}</span>
          <span class="field-name">${esc(f.name)}</span>
          ${rawHint}
          ${consWarn}
          ${badge}
          ${detailBtn}
        </div>
        <textarea class="field-text" readonly>${esc(txt)}</textarea>
        ${hasDetail ? `
        <div class="field-detail hidden">
          <div class="field-detail-col">
            <span class="field-detail-lbl">切り出し画像（OCR対象）</span>
            <img class="field-crop" src="${f.cropDataURL || ''}" alt="">
          </div>
          <div class="field-detail-col">
            <span class="field-detail-lbl">文字別の確信度（OCR生データ）</span>
            <div class="field-syms">${symbolChipsHTML(f.symbols)}</div>
            <p class="field-detail-hint">低い箇所が原因です。画像にノイズ・罫線が写っていないか確認し、①OCR領域を値だけにタイトに ②罫線除去/二値化を調整 ③PDFはDPIを上げる と改善します。</p>
          </div>
        </div>` : ''}`;
      if (hasDetail) {
        const btn = row.querySelector('.field-detail-btn');
        const detail = row.querySelector('.field-detail');
        btn.addEventListener('click', () => { detail.classList.toggle('hidden'); btn.classList.toggle('is-open'); });
      }
      c.appendChild(row);
    });
  }

  function showRecogProgress(show) {
    $('recogProgress').classList.toggle('hidden', !show);
  }
  function updateRecogProgress(msg, pct) {
    $('recogProgressFill').style.width = `${Math.round((pct || 0) * 100)}%`;
    $('recogProgressMsg').textContent = msg || '処理中…';
  }

  /* ── 履歴 ───────────────────────────────────────────── */
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const VERDICT_SHORT = { accepted: '採用', review: '要確認', rejected: '不一致' };
  function renderHistory(results, handlers) {
    const c = $('historyList'); if (!c) return;
    if (!results.length) { c.innerHTML = '<div class="empty-hint"><i class="fas fa-inbox"></i><span>履歴なし</span></div>'; return; }
    c.innerHTML = '';
    results.forEach(r => {
      const item = document.createElement('div'); item.className = 'hist-item';
      const fieldsHtml = (r.fields || []).map(f => `
        <div class="hist-field">
          <span class="hf-name">${esc(f.name)}</span>
          <span class="hf-text">${esc(f.text || (f.error ? '[エラー]' : ''))}</span>
          <span class="hf-conf scv-${confClass(f.confidence)}">${f.confidence}%</span>
        </div>`).join('');
      item.innerHTML = `
        <div class="hist-row">
          <img class="hist-thumb" src="${r.sourceThumb || ''}" alt="">
          <div class="hist-info">
            <div class="hist-form">${esc(r.formName || '—')}</div>
            <div class="hist-time">${r.page ? `P${r.page} ・ ` : ''}${fmtTime(r.createdAt)} ・ 確信度 ${Math.round((r.confidence || 0) * 100)}%</div>
          </div>
          <span class="hist-verdict ${r.decision}">${VERDICT_SHORT[r.decision] || '—'}</span>
          <button class="btn-icon-sm" data-act="del" title="削除"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="hist-detail">${fieldsHtml || '<div class="hint-text">フィールドなし</div>'}</div>`;
      const row = item.querySelector('.hist-row');
      const detail = item.querySelector('.hist-detail');
      row.addEventListener('click', e => { if (e.target.closest('[data-act=del]')) return; detail.classList.toggle('open'); });
      item.querySelector('[data-act=del]').addEventListener('click', e => { e.stopPropagation(); handlers.onDelete(r.id); });
      c.appendChild(item);
    });
  }

  /* ── 複数ページ一括OCR モーダル ─────────────────────── */
  function openBatchModal(total, resuming) {
    $('batchModal').classList.remove('hidden');
    $('batchProgress').classList.remove('hidden');
    $('batchCancel').style.display = '';
    $('batchSummary').classList.add('hidden');
    $('batchList').innerHTML = '';
    updateBatchProgress(resuming ? `続きから残り ${total} ページを認識します…` : `${total} ページを認識します…`, 0);
  }
  function closeBatchModal() { $('batchModal').classList.add('hidden'); }
  function updateBatchProgress(msg, pct) {
    $('batchProgressFill').style.width = `${Math.round((pct || 0) * 100)}%`;
    $('batchProgressMsg').textContent = msg || '処理中…';
  }
  const BATCH_RENDER_CAP = 200;   // 大量ページでもDOMが重くならないよう表示は上限まで
  function renderBatchResults(results, opts) {
    $('batchProgress').classList.add('hidden');
    $('batchCancel').style.display = 'none';
    const review = $('batchReview'); if (review) review.style.display = (opts && opts.hasNav) ? '' : 'none';
    const resume = $('batchResume');
    if (resume) {
      const show = !!(opts && opts.canResume);
      resume.style.display = show ? '' : 'none';
      if (show) resume.innerHTML = `<i class="fas fa-play"></i> 続きから実行（残り${opts.resumeCount}ページ）`;
    }
    const count = k => results.filter(r => r.decision === k).length;
    const sum = $('batchSummary');
    sum.classList.remove('hidden');
    sum.innerHTML = `全 <b>${results.length}</b> ページ ・ <span class="bs-ok">採用 ${count('accepted')}</span> / `
      + `<span class="bs-rv">要確認 ${count('review')}</span> / <span class="bs-rj">不一致 ${count('rejected')}</span>`
      + (count('error') ? ` / <span class="bs-er">エラー ${count('error')}</span>` : '');
    const c = $('batchList'); c.innerHTML = '';
    const shown = results.slice(0, BATCH_RENDER_CAP);
    shown.forEach(r => {
      const item = document.createElement('div'); item.className = 'batch-card';
      const verdict = VERDICT_SHORT[r.decision] || (r.decision === 'error' ? 'エラー' : '—');
      const fieldsHtml = (r.fields || []).length
        ? (r.fields).map(f => `<div class="batch-field"><span class="bf-name">${esc(f.name)}</span><span class="bf-text">${esc(f.text || (f.error ? '[エラー]' : ''))}</span><span class="bf-conf scv-${confClass(f.confidence)}">${f.confidence != null ? f.confidence + '%' : ''}</span></div>`).join('')
        : `<div class="batch-none">${esc(r.error || '採用された帳票がありません')}</div>`;
      item.innerHTML = `
        <div class="batch-card-hdr">
          <span class="batch-page">P${r.page}</span>
          <span class="batch-form">${esc(r.formName || '—')}</span>
          <span class="hist-verdict ${r.decision}">${verdict}</span>
        </div>
        <img class="batch-thumb" src="${r.thumb || ''}" alt="">
        <div class="batch-fields">${fieldsHtml}</div>`;
      c.appendChild(item);
    });
    if (results.length > BATCH_RENDER_CAP) {
      const more = document.createElement('div'); more.className = 'batch-more';
      more.textContent = `… 表示は先頭 ${BATCH_RENDER_CAP} 件のみ（全 ${results.length} 件は「CSV出力」または認識履歴で確認できます）`;
      c.appendChild(more);
    }
  }

  return {
    $, esc, toast, REGION_COLORS, ANCHOR_COLOR, OCR_COLOR,
    refreshRegSteps, renderFormLibrary, renderAnchorList, renderRegionList,
    setPipeline, resetPipeline,
    renderDecision, renderRecogPreview, renderFieldResults, symbolChipsHTML, confClass,
    showRecogProgress, updateRecogProgress, renderHistory,
    openBatchModal, closeBatchModal, updateBatchProgress, renderBatchResults,
  };

})();
