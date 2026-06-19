/* ════════════════════════════════════════════════════════
   matcher_app.js  帳票マッチングアプリ制御
   Responsibility: 状態管理・UI 制御・イベント処理
   ════════════════════════════════════════════════════════ */
'use strict';

const MatcherApp = (() => {

  /* ── State ─────────────────────────────────────────── */
  const state = {
    cvReady:          false,
    templates:        [],         // { id, formName, partName, dataURL, isSample }
    fullImageCanvas:  null,       // HTMLCanvasElement（入力画像描画用、非表示）
    fullImageIsSample: false,
    settings: {
      angleRange: 2,
      angleStep:  1,
    },
  };

  /* ── Utilities ─────────────────────────────────────── */
  function uid() {
    return Math.random().toString(36).slice(2, 11);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(id) { return document.getElementById(id); }

  /** DataURL を読み込み済み HTMLImageElement に変換 */
  function dataURLtoImg(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload  = () => res(img);
      img.onerror = () => rej(new Error('画像の読み込みに失敗しました'));
      img.src = url;
    });
  }

  /** File / Blob を DataURL に変換 */
  function fileToDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = e => res(e.target.result);
      r.onerror = () => rej(new Error('ファイルの読み込みに失敗しました'));
      r.readAsDataURL(file);
    });
  }

  /* ── OpenCV Ready ──────────────────────────────────── */
  function onCVReady() {
    state.cvReady = true;
    el('cv-loading').style.display = 'none';
    el('app-main').style.display   = 'flex';
  }

  /* ── Template Management ───────────────────────────── */
  function addTemplate(formName, partName, dataURL, isSample = false) {
    state.templates.push({
      id: uid(),
      formName: formName.trim(),
      partName:  partName.trim(),
      dataURL,
      isSample,
    });
    renderTemplateList();
  }

  function removeTemplate(id) {
    state.templates = state.templates.filter(t => t.id !== id);
    renderTemplateList();
    clearResults();
  }

  function clearSampleTemplates() {
    state.templates = state.templates.filter(t => !t.isSample);
    if (state.fullImageIsSample) clearFullImage();
    renderTemplateList();
    clearResults();
  }

  /* ── Full Image Management ─────────────────────────── */
  function setFullImage(dataURL, isSample = false) {
    state.fullImageIsSample = isSample;

    el('full-image-preview').src           = dataURL;
    el('full-image-preview').style.display = 'block';
    el('full-drop-hint').style.display     = 'none';
    el('full-image-clear').style.display   = 'inline-flex';
    clearResults();

    /* 非表示キャンバスに描画（matchAll へ渡す用） */
    const img = new Image();
    img.onload = () => {
      if (!state.fullImageCanvas) {
        state.fullImageCanvas = document.createElement('canvas');
      }
      state.fullImageCanvas.width  = img.naturalWidth;
      state.fullImageCanvas.height = img.naturalHeight;
      state.fullImageCanvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = dataURL;
  }

  function clearFullImage() {
    state.fullImageCanvas    = null;
    state.fullImageIsSample  = false;
    el('full-image-preview').style.display = 'none';
    el('full-drop-hint').style.display     = 'flex';
    el('full-image-clear').style.display   = 'none';
    clearResults();
  }

  /* ── Results ───────────────────────────────────────── */
  function clearResults() {
    el('results-container').innerHTML   = '';
    el('results-section').style.display = 'none';
  }

  /* ── Matching ──────────────────────────────────────── */
  async function runMatching() {
    if (!state.cvReady) {
      alert('OpenCV.js を読み込み中です。しばらくお待ちください。');
      return;
    }
    if (!state.fullImageCanvas) {
      alert('判定対象画像を設定してください。');
      return;
    }
    if (state.templates.length === 0) {
      alert('テンプレートを 1 件以上登録してください。');
      return;
    }

    const btn  = el('run-btn');
    const prog = el('progress-wrap');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 判定中...';
    prog.style.display   = 'block';
    el('progress-bar').style.width = '0%';

    /* UI 更新を先に反映させる */
    await new Promise(r => setTimeout(r, 60));

    try {
      /* テンプレートを読み込み済み Image 要素へ変換 */
      const tplImgs = await Promise.all(
        state.templates.map(async t => ({
          id:           t.id,
          imageElement: await dataURLtoImg(t.dataURL),
        }))
      );

      el('progress-bar').style.width = '25%';
      await new Promise(r => setTimeout(r, 0));

      /* マッチング実行（同期・OpenCV.js） */
      const resultMap = MatcherEngine.matchAll(
        state.fullImageCanvas,
        tplImgs,
        {
          angleRange: state.settings.angleRange,
          angleStep:  state.settings.angleStep,
        }
      );

      el('progress-bar').style.width = '100%';
      await new Promise(r => setTimeout(r, 180));

      renderResults(resultMap);

    } catch (e) {
      console.error('[MatcherApp] runMatching error:', e);
      alert('マッチング中にエラーが発生しました: ' + (e.message || String(e)));
    } finally {
      btn.disabled  = false;
      btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> 判定実行';
      setTimeout(() => {
        prog.style.display   = 'none';
        el('progress-bar').style.width = '0%';
      }, 500);
    }
  }

  /* ── Render: Template List ─────────────────────────── */
  function renderTemplateList() {
    const container = el('template-list');

    if (state.templates.length === 0) {
      container.innerHTML = `
        <div class="empty-hint">
          <i class="fa-solid fa-images"></i>
          <span>テンプレート未登録</span>
        </div>`;
      return;
    }

    /* 帳票名でグループ化 */
    const groups = {};
    state.templates.forEach(t => {
      (groups[t.formName] = groups[t.formName] || []).push(t);
    });

    container.innerHTML = Object.entries(groups).map(([name, items]) => `
      <div class="template-group">
        <div class="group-header">
          <i class="fa-solid fa-file-lines"></i>
          <span>${esc(name)}</span>
          <span class="badge">${items.length}</span>
        </div>
        <div class="template-items">
          ${items.map(t => `
            <div class="template-item${t.isSample ? ' is-sample' : ''}">
              <img src="${t.dataURL}" class="template-thumb" alt="">
              <span class="part-name" title="${esc(t.partName)}">${esc(t.partName)}</span>
              ${t.isSample ? '<span class="sample-badge">sample</span>' : ''}
              <button class="btn-icon" onclick="MatcherApp.removeTemplate('${t.id}')" title="削除">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  /* ── Render: Results ───────────────────────────────── */
  function renderResults(resultMap) {
    /* スコアで降順ソート */
    const sorted = state.templates
      .map(t => ({
        ...t,
        ...(resultMap.get(t.id) || { score: 0, angle: 0, loc: { x: 0, y: 0 } }),
      }))
      .sort((a, b) => b.score - a.score);

    el('results-section').style.display = 'block';
    el('results-count').textContent     = `${sorted.length} 件`;

    el('results-container').innerHTML = sorted.map((item, idx) => {
      const pct      = Math.max(0, Math.round(item.score * 100));
      const cls      = item.score >= 0.8 ? 'score-high'
                     : item.score >= 0.5 ? 'score-mid'
                     : 'score-low';
      const rankCls  = idx < 3 ? `rank-${idx + 1}` : '';
      const sign     = item.angle > 0 ? '+' : '';
      const delay    = (idx * 0.04).toFixed(2);

      return `
        <div class="result-row ${rankCls}" style="animation-delay:${delay}s">
          <div class="rank-badge">${idx + 1}</div>
          <div class="result-info">
            <div class="result-names">
              <span class="form-name">${esc(item.formName)}</span>
              <span class="sep">/</span>
              <span class="part-name">${esc(item.partName)}</span>
            </div>
            <div class="score-bar-wrap">
              <div class="score-bar ${cls}" style="width:${pct}%"></div>
            </div>
            <div class="score-meta">
              <span class="score-val ${cls}">${item.score.toFixed(4)}</span>
              <span class="meta-chip">
                <i class="fa-solid fa-rotate"></i> ${sign}${item.angle}°
              </span>
              <span class="meta-chip">
                <i class="fa-solid fa-location-dot"></i> (${item.loc.x}, ${item.loc.y})
              </span>
            </div>
          </div>
          <div class="result-thumb-wrap">
            <canvas id="thumb-${item.id}" class="result-thumb"
              title="${esc(item.partName)} のマッチング位置"></canvas>
          </div>
        </div>`;
    }).join('');

    /* サムネイルを非同期で描画 */
    sorted.forEach(item => {
      dataURLtoImg(item.dataURL).then(tplImg => {
        const thumb = MatcherEngine.drawMatchResult(
          state.fullImageCanvas,
          { w: tplImg.naturalWidth, h: tplImg.naturalHeight },
          item.loc,
          item.angle
        );
        const canvas = el(`thumb-${item.id}`);
        if (!canvas) return;
        canvas.width  = thumb.width;
        canvas.height = thumb.height;
        canvas.getContext('2d').drawImage(thumb, 0, 0);
      }).catch(() => {/* サムネイル生成失敗は無視 */});
    });
  }

  /* ── Sample Data ───────────────────────────────────── */
  function loadSampleData() {
    if (typeof SampleDataGenerator === 'undefined') {
      alert('サンプルデータ生成スクリプト (sample_generator.js) が見つかりません。');
      return;
    }
    const forms = SampleDataGenerator.generateAll();
    forms.forEach(form =>
      form.templates.forEach(tpl =>
        addTemplate(form.formName, tpl.partName, tpl.dataURL, true)
      )
    );
    /* 帳票A の全体画像を入力画像としてセット */
    setFullImage(forms[0].fullDataURL, true);
  }

  /* ── Registration Modal ────────────────────────────── */
  let _modalDataURL = null;

  function openRegisterModal() {
    _modalDataURL = null;
    el('modal-form-name').value         = '';
    el('modal-part-name').value         = '';
    el('modal-preview').style.display   = 'none';
    el('modal-drop-hint').style.display = 'flex';
    el('modal-drop-zone').style.borderColor = '';
    el('register-modal').classList.add('open');
    setTimeout(() => el('modal-form-name').focus(), 60);
  }

  function closeRegisterModal() {
    el('register-modal').classList.remove('open');
  }

  function setModalPreview(dataURL) {
    _modalDataURL = dataURL;
    el('modal-preview').src             = dataURL;
    el('modal-preview').style.display   = 'block';
    el('modal-drop-hint').style.display = 'none';

    /* 画像設定フィードバック */
    const zone = el('modal-drop-zone');
    zone.style.borderColor = 'var(--primary)';
    setTimeout(() => { zone.style.borderColor = ''; }, 900);
  }

  function registerFromModal() {
    const fn = el('modal-form-name').value.trim();
    const pn = el('modal-part-name').value.trim();
    if (!fn)           { el('modal-form-name').focus(); return; }
    if (!pn)           { el('modal-part-name').focus(); return; }
    if (!_modalDataURL){ alert('テンプレート画像を設定してください。'); return; }
    addTemplate(fn, pn, _modalDataURL);
    closeRegisterModal();
  }

  /* ── Settings Panel ────────────────────────────────── */
  function toggleSettings() {
    const body   = el('settings-body');
    const toggle = el('settings-toggle');
    const isOpen = body.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
  }

  /* ── Help Modal ────────────────────────────────────── */
  function openHelp()  { el('help-modal').classList.add('open'); }
  function closeHelp() { el('help-modal').classList.remove('open'); }

  /* ── Drop & Paste Handlers ─────────────────────────── */
  function setupDropZone(zoneId, onDataURL) {
    const zone = el(zoneId);
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        onDataURL(await fileToDataURL(file));
      }
    });
  }

  /**
   * グローバルペーストリスナー
   * モーダルが開いていればテンプレート画像へ、
   * そうでなければ入力画像エリアへルーティングする。
   */
  function setupGlobalPaste() {
    document.addEventListener('paste', async e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const url = await fileToDataURL(item.getAsFile());
        if (el('register-modal').classList.contains('open')) {
          setModalPreview(url);
        } else {
          setFullImage(url);
        }
        break;
      }
    });
  }

  /* ── Init ──────────────────────────────────────────── */
  function init() {
    /* ドロップゾーン設定 */
    setupDropZone('full-image-zone', url => setFullImage(url));
    setupDropZone('modal-drop-zone', url => setModalPreview(url));

    /* グローバルペースト */
    setupGlobalPaste();

    /* モーダル: Enter キーでフォーカス移動 / 登録確定 */
    el('modal-form-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') el('modal-part-name').focus();
    });
    el('modal-part-name').addEventListener('keydown', e => {
      if (e.key === 'Enter' && _modalDataURL) registerFromModal();
    });

    /* オーバーレイクリックでモーダルを閉じる */
    el('register-modal').addEventListener('click', e => {
      if (e.target === el('register-modal')) closeRegisterModal();
    });
    el('help-modal').addEventListener('click', e => {
      if (e.target === el('help-modal')) closeHelp();
    });

    /* 設定値変更 */
    el('angle-range-input').addEventListener('change', e => {
      state.settings.angleRange = Math.max(0, parseFloat(e.target.value) || 0);
    });
    el('angle-step-input').addEventListener('change', e => {
      state.settings.angleStep = Math.max(0.5, parseFloat(e.target.value) || 1);
    });

    renderTemplateList();
  }

  /* ── Public API ────────────────────────────────────── */
  return {
    onCVReady,
    init,
    removeTemplate,
    clearSampleTemplates,
    loadSampleData,
    setFullImage,
    clearFullImage,
    openRegisterModal,
    closeRegisterModal,
    registerFromModal,
    toggleSettings,
    openHelp,
    closeHelp,
    runMatching,
  };

})();
