/* ════════════════════════════════════════════════════════
   studio_app.js  帳票OCR統合ツール コントローラー
   Responsibility: モード制御・状態管理・各モジュールの調整
     登録工程: 基準画像へのアンカー/OCR領域描画 → IndexedDB 保存
     OCR工程 : 画像 → マッチング → 帳票判定 → 補正 → 罫線除去 → OCR → 保存
   ════════════════════════════════════════════════════════ */
'use strict';

(function () {

  const $  = id => document.getElementById(id);
  const UI = StudioUI;

  /* ── State ──────────────────────────────────────────── */
  const S = {
    cvReady: false,
    forms: [],
    mode: 'register',
    /* 編集中の帳票 */
    editingId: null, isSampleForm: false,
    refImg: null, refNatW: 0, refNatH: 0, refDataURL: null,
    anchors: [], regions: [],
    /* 描画 */
    drawMode: 'anchor', zoom: 1, baseScale: 1,
    isDrawing: false, ds: { x: 0, y: 0 }, dc: { x: 0, y: 0 }, pending: null,
    /* 認識 */
    recogCanvas: null, lastClassify: null,
    recogFormId: null, recogMatchInfo: null, recogResult: null, rrZoom: 1,
    dbgLoadedFormId: null, patternOverrides: {}, constraintOverrides: {},
    batchResults: null, batchCancel: false, review: null, rec: null,
    recogPageNum: 1, pageNav: null, navReviewMode: false,
  };

  /* PSM 比較用パターン */
  const PSM_LIST = [3, 4, 6, 7, 8, 10, 11, 13];
  const PSM_DESC = { 3: '自動', 4: '縦列(複数行)', 6: '単一ブロック', 7: '単一行', 8: '単一単語', 10: '単一文字', 11: '疎なテキスト', 13: '生の1行' };

  const uid = () => Math.random().toString(36).slice(2, 11);
  const dataURLtoImg = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('load fail')); i.src = url; });
  const fileToDataURL = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = () => rej(new Error('read fail')); r.readAsDataURL(file); });

  function canvasFromImg(img) { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; }
  function thumbURL(canvas, w = 90) { const s = Math.min(1, w / canvas.width); const c = document.createElement('canvas'); c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s); c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height); return c.toDataURL('image/png'); }
  /* 切り出し画像（PNG dataURL）を保存用に縮小＋JPEG化して容量を抑える。照合での見比べ用。 */
  function shrinkDataURL(dataURL, maxW = 260, quality = 0.72) {
    return new Promise(resolve => {
      if (!dataURL) return resolve('');
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, maxW / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s));
        c.height = Math.max(1, Math.round(img.naturalHeight * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve('');
      img.src = dataURL;
    });
  }

  /* ── 設定（判定しきい値・マッチング探索）。localStorage 永続化 ── */
  const SETTINGS_KEY = 'ocrtool_settings';
  const SCALE_PRESETS = { narrow: [1.0], standard: [0.85, 1.0, 1.15], wide: [0.7, 0.85, 1.0, 1.15, 1.3] };
  function defaultSettings() { return { acceptConf: 0.70, nearExact: 0.90, acceptFloor: 0.45, marginMin: 0.06, angleRange: 2, scaleMode: 'standard' }; }
  function loadSettings() {
    try { S.settings = { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
    catch (_) { S.settings = defaultSettings(); }
  }
  function persistSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch (_) {} }
  /* 判定（classify）に渡す探索・しきい値オプションを設定から構築 */
  function classifyOpts() {
    const s = S.settings || defaultSettings();
    return {
      angleRange: s.angleRange, angleStep: 1,
      scaleFactors: SCALE_PRESETS[s.scaleMode] || SCALE_PRESETS.standard,
      voting: { acceptConf: s.acceptConf, nearExact: s.nearExact, acceptFloor: s.acceptFloor, marginMin: s.marginMin },
    };
  }

  /* ── CV lifecycle ───────────────────────────────────── */
  document.addEventListener('cv-ready', () => { S.cvReady = true; $('loadingOverlay').classList.add('hidden'); UI.toast('OpenCV.js の準備が完了しました', 'success'); });
  document.addEventListener('cv-error', () => { $('loadingMsg').innerHTML = 'OpenCV.js を読み込めませんでした。ネット接続を確認するか、サーバー無しで開く場合は <b>opencv.js</b> を index.html と同じフォルダに置いてください。'; UI.toast('OpenCV.js の読み込みに失敗しました', 'error', 6000); });

  /* ── モード切替 ─────────────────────────────────────── */
  function setMode(mode) {
    S.mode = mode;
    $('viewRegister').classList.toggle('hidden', mode !== 'register');
    $('viewRecognize').classList.toggle('hidden', mode !== 'recognize');
    $('modeRegister').classList.toggle('is-active', mode === 'register');
    $('modeRecognize').classList.toggle('is-active', mode === 'recognize');
    if (mode === 'recognize') { refreshHistory(); }
  }

  /* ════════════════════════════════════════════════════
     登録工程
     ════════════════════════════════════════════════════ */

  async function loadForms() {
    try { S.forms = await FormDB.getAllForms(); }
    catch (e) { S.forms = []; UI.toast('IndexedDB 読み込みエラー: ' + e.message, 'error'); }
    UI.renderFormLibrary(S.forms, { onEdit: editForm, onDelete: deleteForm });
  }

  function newForm() {
    S.editingId = null; S.isSampleForm = false;
    S.refImg = null; S.refNatW = 0; S.refNatH = 0; S.refDataURL = null;
    S.anchors = []; S.regions = []; S.pending = null; S.zoom = 1; S.drawMode = 'anchor';
    $('formNameInput').value = '';
    $('refPreview').style.display = 'none'; $('refDropHint').style.display = 'flex';
    $('rectNameInput').value = '';
    applyLineRemovalToUI(LineRemovalProcessor.defaultParams());
    $('regPsm').value = '7'; $('regLang').value = 'eng'; $('regWhitelist').value = ''; $('regNormalize').checked = true; $('regNormalizeKanji').checked = false;
    setDrawMode('anchor');
    $('regCanvas').style.display = 'none'; $('regCanvasPlaceholder').style.display = 'flex';
    $('editorEmpty').classList.add('hidden'); $('editorForm').classList.remove('hidden');
    UI.renderAnchorList(S.anchors, removeAnchor);
    UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor);
    refreshSteps();
    setTimeout(() => $('formNameInput').focus(), 50);
  }

  async function editForm(id) {
    const f = S.forms.find(x => x.id === id); if (!f) return;
    S.editingId = f.id; S.isSampleForm = !!f.isSample;
    $('formNameInput').value = f.name || '';
    S.anchors = (f.anchors || []).map(a => ({ ...a }));
    S.regions = (f.ocrRegions || []).map(r => ({ ...r }));
    S.zoom = 1; S.pending = null;
    applyLineRemovalToUI(f.lineRemoval || LineRemovalProcessor.defaultParams());
    $('regPsm').value = String(f.ocrSettings?.psm ?? 7); $('regLang').value = f.ocrSettings?.lang || 'eng';
    $('regWhitelist').value = f.ocrSettings?.whitelist || ''; $('regNormalize').checked = f.ocrSettings?.normalize !== false; $('regNormalizeKanji').checked = !!f.ocrSettings?.normalizeKanji;
    $('editorEmpty').classList.add('hidden'); $('editorForm').classList.remove('hidden');
    setDrawMode('anchor');
    UI.renderAnchorList(S.anchors, removeAnchor);
    UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor);
    await setReference(f.referenceImage.dataURL);
    refreshSteps();
  }

  async function deleteForm(id) {
    const f = S.forms.find(x => x.id === id);
    if (!confirm(`帳票「${f ? f.name : ''}」を削除しますか？`)) return;
    await FormDB.deleteForm(id);
    if (S.editingId === id) cancelEdit();
    await loadForms();
    UI.toast('帳票を削除しました', 'info');
  }

  function cancelEdit() {
    S.editingId = null;
    $('editorForm').classList.add('hidden'); $('editorEmpty').classList.remove('hidden');
  }

  /* ── 基準画像 ───────────────────────────────────────── */
  async function setReference(dataURL) {
    const img = await dataURLtoImg(dataURL);
    S.refImg = img; S.refNatW = img.naturalWidth; S.refNatH = img.naturalHeight; S.refDataURL = dataURL;
    $('refPreview').src = dataURL; $('refPreview').style.display = 'block'; $('refDropHint').style.display = 'none';
    $('regCanvasPlaceholder').style.display = 'none'; $('regCanvas').style.display = 'block';
    computeBaseScale(); redrawRegCanvas(); refreshSteps();
  }
  function computeBaseScale() {
    const wrap = $('regCanvasWrap');
    const avail = (wrap?.clientWidth || 600) - 24;
    S.baseScale = Math.max(0.1, Math.min(2, avail / (S.refNatW || 1)));
  }
  const activeScale = () => S.baseScale * S.zoom;

  /* ── 描画モード ─────────────────────────────────────── */
  function setDrawMode(m) {
    S.drawMode = m; S.pending = null;
    document.querySelectorAll('#drawModeSwitch .dm-btn').forEach(b => b.classList.toggle('is-active', b.dataset.dm === m));
    const c = $('regCanvas'); if (c) c.style.cursor = m === 'pan' ? 'grab' : 'crosshair';
    if (m !== 'pan') $('rectNameInput').placeholder = m === 'anchor' ? '目印の名前（例：タイトル）' : '読取項目の名前（例：番号）';
    redrawRegCanvas();
  }

  function redrawRegCanvas() {
    const c = $('regCanvas'); if (!c || !S.refImg) return;
    const sc = activeScale();
    c.width = Math.round(S.refNatW * sc); c.height = Math.round(S.refNatH * sc);
    const ctx = c.getContext('2d');
    ctx.drawImage(S.refImg, 0, 0, c.width, c.height);
    /* 識別アンカー（青） */
    S.anchors.forEach((a, i) => drawRect(ctx, a.refX * sc, a.refY * sc, a.w * sc, a.h * sc, UI.ANCHOR_COLOR, `A${i + 1}.${a.name}`));
    /* OCR領域（色分け） */
    S.regions.forEach((r, i) => drawRect(ctx, r.x * sc, r.y * sc, r.w * sc, r.h * sc, UI.REGION_COLORS[i % UI.REGION_COLORS.length], `${i + 1}.${r.name}`));
    /* 描画中／保留 */
    if (S.isDrawing) {
      const x = Math.min(S.ds.x, S.dc.x), y = Math.min(S.ds.y, S.dc.y), w = Math.abs(S.dc.x - S.ds.x), h = Math.abs(S.dc.y - S.ds.y);
      ctx.save(); ctx.strokeStyle = '#FF6B00'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,107,0,.12)'; ctx.fillRect(x, y, w, h); ctx.restore();
    } else if (S.pending) {
      const col = S.drawMode === 'anchor' ? UI.ANCHOR_COLOR : '#FF6B00';
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.setLineDash([5, 3]);
      ctx.strokeRect(S.pending.x * sc, S.pending.y * sc, S.pending.w * sc, S.pending.h * sc);
      ctx.fillStyle = col + '22'; ctx.fillRect(S.pending.x * sc, S.pending.y * sc, S.pending.w * sc, S.pending.h * sc); ctx.restore();
    }
  }
  function drawRect(ctx, x, y, w, h, col, label) {
    ctx.fillStyle = col + '24'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = col; ctx.font = 'bold 10px sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText(label, x + 3, y + 2); ctx.textBaseline = 'alphabetic';
  }

  function initRegCanvasEvents() {
    const c = $('regCanvas'), wrap = $('regCanvasWrap');
    let panStart = null;
    const endPan = () => { if (panStart) { panStart = null; wrap.classList.remove('panning'); $('regCanvas').style.cursor = 'grab'; } };
    c.addEventListener('mousedown', e => {
      if (!S.refImg) return;
      if (S.drawMode === 'pan') {   // ドラッグで画像を移動（パン）
        panStart = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
        wrap.classList.add('panning'); c.style.cursor = 'grabbing'; e.preventDefault(); return;
      }
      S.isDrawing = true; S.ds = { x: e.offsetX, y: e.offsetY }; S.dc = { ...S.ds };
    });
    c.addEventListener('mousemove', e => {
      if (panStart) { wrap.scrollLeft = panStart.sl - (e.clientX - panStart.x); wrap.scrollTop = panStart.st - (e.clientY - panStart.y); return; }
      if (!S.isDrawing) return; S.dc = { x: e.offsetX, y: e.offsetY }; redrawRegCanvas();
    });
    c.addEventListener('mouseup', e => { if (panStart) { endPan(); return; } if (!S.isDrawing) return; S.dc = { x: e.offsetX, y: e.offsetY }; S.isDrawing = false; finishDraw(); });
    c.addEventListener('mouseleave', () => { if (S.isDrawing) { S.isDrawing = false; finishDraw(); } });
    window.addEventListener('mouseup', endPan);   // キャンバス外で離してもパン終了
  }
  function finishDraw() {
    const sc = activeScale();
    const x = Math.min(S.ds.x, S.dc.x), y = Math.min(S.ds.y, S.dc.y), w = Math.abs(S.dc.x - S.ds.x), h = Math.abs(S.dc.y - S.ds.y);
    if (w < 5 || h < 5) { S.pending = null; redrawRegCanvas(); return; }
    S.pending = { x: Math.round(x / sc), y: Math.round(y / sc), w: Math.round(w / sc), h: Math.round(h / sc) };
    redrawRegCanvas();
    if ($('rectNameInput').value.trim()) commitPending(); else { $('btnAddRect').disabled = false; $('rectNameInput').focus(); }
  }
  /* commit pending rect */
  function commitPending() {
    if (!S.pending) { UI.toast('先に画像上でドラッグして範囲を指定してください', 'warning'); return; }
    const name = $('rectNameInput').value.trim();
    if (!name) { UI.toast('名前を入力してください', 'warning'); $('rectNameInput').focus(); return; }
    if (S.drawMode === 'anchor') {
      /* 基準画像から切り出してアンカー画像を生成 */
      const p = S.pending;
      const crop = document.createElement('canvas'); crop.width = p.w; crop.height = p.h;
      crop.getContext('2d').drawImage(S.refImg, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
      S.anchors.push({ id: uid(), name, dataURL: crop.toDataURL('image/png'), w: p.w, h: p.h, refX: p.x, refY: p.y });
      UI.renderAnchorList(S.anchors, removeAnchor);
    } else {
      const p = S.pending;
      S.regions.push({ id: uid(), name, x: p.x, y: p.y, w: p.w, h: p.h });
      UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor);
    }
    S.pending = null; $('rectNameInput').value = ''; $('btnAddRect').disabled = true;
    redrawRegCanvas(); refreshSteps();
    UI.toast(`「${name}」を追加しました`, 'success', 1600);
  }
  function removeAnchor(id) { S.anchors = S.anchors.filter(a => a.id !== id); UI.renderAnchorList(S.anchors, removeAnchor); redrawRegCanvas(); refreshSteps(); }
  function removeRegion(id) { S.regions = S.regions.filter(r => r.id !== id); UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor); redrawRegCanvas(); refreshSteps(); }
  function setRegionPattern(id, val) { const r = S.regions.find(x => x.id === id); if (r) r.pattern = (val || '').trim(); }
  function openRegionConstraintEditor(id) {
    const r = S.regions.find(x => x.id === id); if (!r) return;
    CharRuleEditor.open(r.name, r.charRule || r.constraint, rule => {
      r.charRule = rule; delete r.constraint;   // 旧形式(文字列)は新形式へ移行
      UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor);
    });
  }

  /* ── 別画像から識別アンカーを自動配置 ───────────────── */
  async function addAnchorFromImage(dataURL) {
    if (!S.refImg) { UI.toast('先に基準画像を読み込んでください', 'warning'); return; }
    if (!S.cvReady) { UI.toast('OpenCV.js 読み込み中です', 'warning'); return; }
    try {
      const img = await dataURLtoImg(dataURL);
      const refCanvas = canvasFromImg(S.refImg);
      const map = MatcherEngine.matchAll(refCanvas, [{ id: '_a', imageElement: img }], { angleRange: 0, angleStep: 1 });
      const r = map.get('_a') || { score: 0, loc: { x: 0, y: 0 } };
      if (r.score < 0.5) { UI.toast(`基準画像内に見つかりませんでした（スコア ${r.score.toFixed(2)}）`, 'warning', 4000); return; }
      const name = prompt('識別アンカー名を入力', `アンカー${S.anchors.length + 1}`);
      if (name === null) return;
      S.anchors.push({ id: uid(), name: (name || 'アンカー').trim(), dataURL, w: img.naturalWidth, h: img.naturalHeight, refX: r.loc.x, refY: r.loc.y });
      UI.renderAnchorList(S.anchors, removeAnchor); redrawRegCanvas(); refreshSteps();
      UI.toast(`自動配置しました（スコア ${r.score.toFixed(2)}, 位置 ${r.loc.x},${r.loc.y}）`, 'success', 3500);
    } catch (e) { UI.toast('処理に失敗しました: ' + e.message, 'error'); }
  }

  /* ── 罫線除去パラメータ UI 連携 ─────────────────────── */
  function applyLineRemovalToUI(p) {
    const set = (id, v) => { const e = $(id); if (e) e[e.type === 'checkbox' ? 'checked' : 'value'] = v; };
    const txt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('regBinaryMethod', p.binaryMethod);
    set('regManualThresh', p.manualThresh); txt('regValThresh', p.manualThresh);
    set('regAdaptiveBlock', p.adaptiveBlock); txt('regValBlock', p.adaptiveBlock);
    set('regAdaptiveC', p.adaptiveC); txt('regValC', p.adaptiveC);
    set('regEnableHoriz', p.enableHoriz);
    set('regHorizLen', p.horizLen); txt('regValHLen', p.horizLen);
    set('regHorizThick', p.horizThick); txt('regValHThick', p.horizThick);
    set('regHorizDilate', p.horizDilate); txt('regValHDil', p.horizDilate);
    set('regEnableVert', p.enableVert);
    set('regVertLen', p.vertLen); txt('regValVLen', p.vertLen);
    set('regVertThick', p.vertThick); txt('regValVThick', p.vertThick);
    set('regVertDilate', p.vertDilate); txt('regValVDil', p.vertDilate);
    set('regMaskDilate', p.maskDilate); txt('regValMaskDil', p.maskDilate);
    updateBinaryRows();
  }
  function collectLineRemoval() {
    const v = id => $(id).value, vi = id => parseInt($(id).value, 10), vc = id => $(id).checked;
    return {
      binaryMethod: v('regBinaryMethod'), manualThresh: vi('regManualThresh'),
      adaptiveBlock: vi('regAdaptiveBlock'), adaptiveC: vi('regAdaptiveC'),
      enableHoriz: vc('regEnableHoriz'), horizLen: vi('regHorizLen'), horizThick: vi('regHorizThick'), horizDilate: vi('regHorizDilate'),
      enableVert: vc('regEnableVert'), vertLen: vi('regVertLen'), vertThick: vi('regVertThick'), vertDilate: vi('regVertDilate'),
      maskDilate: vi('regMaskDilate'), outputBase: 'original',
    };
  }
  function updateBinaryRows() {
    const m = $('regBinaryMethod').value;
    $('regRowThresh').classList.toggle('hidden', m !== 'manual');
    $('regRowBlock').classList.toggle('hidden', m !== 'adaptive');
    $('regRowC').classList.toggle('hidden', m !== 'adaptive');
  }

  /* ── 完了チェックリスト ─────────────────────────────── */
  function refreshSteps() {
    UI.refreshRegSteps({
      name: !!$('formNameInput').value.trim(),
      ref: !!S.refImg,
      anchor: S.anchors.length > 0,
      ocr: S.regions.length > 0,
      save: false,
    });
  }

  /* ── 保存 ───────────────────────────────────────────── */
  async function saveForm() {
    const name = $('formNameInput').value.trim();
    if (!name) { $('formNameInput').focus(); return UI.toast('帳票名を入力してください', 'warning'); }
    if (!S.refImg) return UI.toast('基準画像を設定してください', 'warning');
    if (!S.anchors.length) return UI.toast('識別アンカーを1つ以上設定してください', 'warning');
    if (!S.regions.length) return UI.toast('OCR領域を1つ以上設定してください', 'warning');

    const form = {
      id: S.editingId || uid(),
      name,
      referenceImage: { dataURL: S.refDataURL, w: S.refNatW, h: S.refNatH },
      anchors: S.anchors.map(a => ({ ...a })),
      ocrRegions: S.regions.map(r => ({ ...r })),
      ocrSettings: { psm: parseInt($('regPsm').value, 10), lang: $('regLang').value, whitelist: $('regWhitelist').value, normalize: $('regNormalize').checked, normalizeKanji: $('regNormalizeKanji').checked },
      lineRemoval: collectLineRemoval(),
      isSample: S.isSampleForm,
    };
    if (S.editingId) { const old = S.forms.find(f => f.id === S.editingId); if (old) form.createdAt = old.createdAt; }
    /* 即時フィードバック（保存処理がハングしても無反応にならないように） */
    const btn = $('btnSaveForm'); const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 保存中…';
    try {
      await FormDB.putForm(form);
      UI.refreshRegSteps({ name: true, ref: true, anchor: true, ocr: true, save: true });
      await loadForms();
      cancelEdit();
      UI.toast(`帳票「${name}」を保存しました`, 'success');
    } catch (e) {
      UI.toast('保存に失敗しました: ' + (e.message || e), 'error', 6000);
    } finally { btn.disabled = false; btn.innerHTML = orig; }
  }

  /* ── サンプル帳票 ───────────────────────────────────── */
  async function loadSampleForms() {
    try {
      const samples = SampleForms.build();
      for (const f of samples) await FormDB.putForm(f);
      await loadForms();
      UI.toast(`${samples.length} 件のサンプル帳票を登録しました`, 'success');
    } catch (e) { UI.toast('サンプル登録に失敗しました: ' + (e.message || e), 'error', 6000); }
  }
  function openSampleFormModal() {
    const grid = $('sampleFormGrid'); grid.innerHTML = '';
    SampleForms.build().forEach(f => {
      const card = document.createElement('div'); card.className = 'sample-card';
      const img = document.createElement('img'); img.src = f.referenceImage.dataURL; img.style.width = '100%'; img.style.display = 'block';
      const label = document.createElement('span'); label.className = 'sample-name'; label.textContent = f.name + '（テンプレ流用）';
      card.append(img, label);
      card.addEventListener('click', async () => {
        $('closeSampleFormModal').click();
        S.anchors = f.anchors.map(a => ({ ...a, id: uid() }));
        S.regions = f.ocrRegions.map(r => ({ ...r, id: uid() }));
        $('formNameInput').value = f.name;
        applyLineRemovalToUI(f.lineRemoval); $('regPsm').value = String(f.ocrSettings.psm);
        UI.renderAnchorList(S.anchors, removeAnchor); UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor);
        await setReference(f.referenceImage.dataURL);
        UI.toast('サンプルレイアウトを読み込みました。確認して保存してください', 'info', 4000);
      });
      grid.appendChild(card);
    });
    $('sampleFormModal').classList.remove('hidden');
  }

  /* ════════════════════════════════════════════════════
     OCR工程
     ════════════════════════════════════════════════════ */

  function loadRecogImage(canvas, keepNav) {
    S.recogCanvas = canvas; S.lastClassify = null;
    S.recogFormId = null; S.recogMatchInfo = null; S.recogResult = null; S.dbgLoadedFormId = null; S.patternOverrides = {}; S.constraintOverrides = {};
    S.recogPageNum = 1;
    if (!keepNav) releasePageNav();            // 新規読み込みでは一括結果のページ送りを解除
    $('recogPreview').src = canvas.toDataURL('image/png'); $('recogPreview').style.display = 'block'; $('recogDropHint').style.display = 'none';
    $('btnRunRecognize').disabled = false;
    $('decisionPanel').classList.add('hidden'); $('recogResultArea').classList.add('hidden'); $('debugPanel').classList.add('hidden');
    UI.resetPipeline();
  }

  /* 画像/PDF を共通の入口で受け取り、キャンバスにして渡す。
     画像 → そのままキャンバス化。PDF → 取り込みモーダル（ページ/DPI選択）経由。
     これにより基準画像・アンカー・OCR入力のどこでも画像/PDFを同様に扱える。 */
  async function acceptFile(file, useCanvas, opts) {
    if (!file) return;
    if (PdfImport.isPdf(file)) { PdfImport.open(file, { onCanvas: useCanvas, ...(opts || {}) }); return; }
    if (file.type && file.type.startsWith('image/')) {
      try {
        const img = await dataURLtoImg(await fileToDataURL(file));
        useCanvas(canvasFromImg(img));
      } catch (_) { UI.toast('画像の読み込みに失敗しました', 'error'); }
      return;
    }
    UI.toast('画像 または PDF を読み込んでください', 'warning', 4000);
  }

  async function runRecognize() {
    if (!S.cvReady) return UI.toast('OpenCV.js 読み込み中です', 'warning');
    if (!S.recogCanvas) return UI.toast('画像を読み込んでください', 'warning');
    if (!S.forms.length) return UI.toast('先に帳票を登録してください', 'warning');

    $('btnRunRecognize').disabled = true;
    UI.setPipeline('match', []);
    await new Promise(r => setTimeout(r, 30));
    try {
      const { decision, scores } = await Recognizer.classify(S.recogCanvas, S.forms, classifyOpts());
      S.lastClassify = { decision, scores };
      UI.setPipeline('decide', ['match']);
      UI.renderDecision(decision, S.forms, {});
      /* 設定パネルを表示し、候補帳票の設定を反映（数値調整・再実行の起点） */
      const candId = (decision.best && decision.best.formId) || (decision.ranking[0] && decision.ranking[0].formId);
      if (candId) { const f = S.forms.find(x => x.id === candId); if (f) loadFormIntoDebug(f); }
      $('debugPanel').classList.remove('hidden');
      /* 採用なら自動で OCR まで進める（要確認/不一致は手動確認） */
      if (decision.decision === 'accepted' && decision.best) {
        await applyForm(decision.best.formId);
      } else {
        UI.setPipeline(null, ['match', 'decide']);
        UI.toast(decision.decision === 'review' ? '要確認: 帳票を確認して「この帳票でOCR」を押してください'
                                                : '一致する帳票がありません。手動選択も可能です', 'warning', 4500);
      }
    } catch (e) {
      UI.toast('認識エラー: ' + e.message, 'error', 5000);
      UI.resetPipeline();
    } finally { $('btnRunRecognize').disabled = false; }
  }

  function bestAnchorFor(form, scores) {
    let best = { score: -1, angle: 0, loc: { x: 0, y: 0 }, anchorId: null };
    (form.anchors || []).forEach(a => { const r = scores.get(a.id); if (r && r.score > best.score) best = { score: r.score, angle: r.angle, loc: r.loc, anchorId: a.id }; });
    return best;
  }

  /* 帳票を適用 → 設定パネルの値で実行（調整済みの値は保持） */
  async function applyForm(formId) {
    if (!S.lastClassify) return UI.toast('先に「認識を実行」してください', 'warning');
    const form = S.forms.find(f => f.id === formId); if (!form) return;
    /* 別の帳票に切り替えたときのみ、その帳票の登録設定を読み込む */
    if (S.dbgLoadedFormId !== formId) loadFormIntoDebug(form);
    S.recogFormId = formId;
    S.recogMatchInfo = bestAnchorFor(form, S.lastClassify.scores);
    $('debugPanel').classList.remove('hidden');
    await doRecognitionRun(effectiveForm());
  }

  /* デバッグパネルの現在値で再実行 */
  async function rerun() {
    if (!S.recogFormId) return UI.toast('先に「認識を実行」して帳票を適用してください', 'warning');
    const eff = effectiveForm(); if (!eff) return;
    await doRecognitionRun(eff);
  }

  /* 罫線除去 + OCR の実行本体（effForm は設定上書き済みの帳票） */
  async function doRecognitionRun(form) {
    const mi = S.recogMatchInfo;
    $('recogResultArea').classList.remove('hidden');
    UI.showRecogProgress(true); UI.updateRecogProgress('初期化中…', 0);
    $('fieldResults').innerHTML = ''; $('saveStatus').textContent = '';
    $('btnRerun').disabled = true;
    try {
      const result = await Recognizer.runOcr(S.recogCanvas, form, mi, {}, {
        onStage: (name, pct) => {
          UI.updateRecogProgress(name, pct);
          const map = { '傾き補正': 'rotate', '原点の確定': 'rotate', '罫線除去': 'line' };
          if (name.startsWith('OCR')) UI.setPipeline('ocr', ['match', 'decide', 'rotate', 'line']);
          else if (map[name]) UI.setPipeline(map[name], ['match', 'decide']);
        },
        onOcr: (i, total, fname, status, pct) => UI.updateRecogProgress(`OCR ${i + 1}/${total}「${fname}」: ${status}`, 0.55 + 0.4 * ((i + (pct || 0)) / total)),
      });
      if (result.error) { UI.showRecogProgress(false); LineRemovalProcessor.cleanupMats(result.previewMats); return UI.toast('処理エラー: ' + result.error, 'error', 5000); }

      UI.setPipeline(null, ['match', 'decide', 'rotate', 'line', 'ocr']);
      UI.showRecogProgress(false);
      /* ズーム/パン用に結果を保持して描画 */
      S.recogResult = { resultCanvas: result.resultCanvas, transform: result.transform, regions: form.ocrRegions, angle: result.angle };
      S.rrZoom = 1;
      renderResultPreview();
      UI.renderFieldResults(result.fields);
      LineRemovalProcessor.cleanupMats(result.previewMats);

      const ok = result.fields.filter(f => !f.error).length;
      if (S.navReviewMode) {
        /* 一括結果のページ確認のための再実行: 保存もカルーセルもしない（表示のみ） */
      } else if ($('recogReviewMode').checked && result.fields.length) {
        openReview(form, result);   // 保存前に1件ずつ確認 → 確認後に保存
      } else {
        await saveResult(form, result);
        UI.toast(`OCR完了 — ${ok}/${result.fields.length} フィールド認識`, 'success');
      }
    } catch (e) { UI.showRecogProgress(false); UI.toast('OCRエラー: ' + e.message, 'error', 5000); }
    finally { $('btnRerun').disabled = false; }
  }

  /* ── 保存前レビュー（カルーセル）─────────────────────
     写真（切り出し）とOCR結果を1件ずつ見比べ、修正→完了でDB保存。
     Enter=次へ / Shift+Enter or「すべて完了」=途中でも全件保存。 */
  function openReview(form, result) {
    S.review = { form, result, idx: 0 };
    $('reviewBatchBar').classList.add('hidden');     // 単一ページ確認では一括用の進捗・ページ表示は出さない
    $('reviewPageCtx').classList.add('hidden');
    $('reviewModal').classList.remove('hidden');
    reviewRender();
    setTimeout(() => { $('reviewValue').focus(); $('reviewValue').select(); }, 60);
  }
  function reviewHide() { $('reviewModal').classList.add('hidden'); S.review = null; }
  function reviewSaveEdit() {
    if (!S.review) return;
    const f = S.review.result.fields[S.review.idx];
    if (f) f.text = $('reviewValue').value;
  }
  function reviewRender() {
    const rv = S.review; if (!rv) return;
    const fields = rv.result.fields, i = rv.idx, f = fields[i];
    $('reviewProgress').textContent = `(${i + 1} / ${fields.length})`;
    $('reviewFieldName').textContent = f.name || `OCR${i + 1}`;
    $('reviewCrop').src = f.cropDataURL || '';
    $('reviewValue').value = f.error ? '' : (f.text || '');
    $('reviewConf').innerHTML = f.error ? '<span class="conf-badge lo">読取エラー</span>'
      : `信頼度 <span class="conf-badge ${UI.confClass(f.confidence)}">${f.confidence}%</span>`;
    $('reviewSyms').innerHTML = UI.symbolChipsHTML(f.symbols);
    $('reviewPrev').disabled = i === 0;
    const last = i === fields.length - 1;
    /* 一括（OCR中確認）では「完了→次ページ」、単一では「完了（保存）」 */
    const lastLabel = rv.batch ? '<i class="fas fa-check"></i> このページを確定' : '<i class="fas fa-check"></i> 完了（保存）';
    $('reviewNext').innerHTML = last ? lastLabel : '次へ <i class="fas fa-arrow-right"></i>';
    $('reviewNext').className = 'btn ' + (last ? 'btn-success' : 'btn-primary');
    $('reviewCancel').textContent = rv.batch ? '中止（ここまで保存）' : 'キャンセル';
    $('reviewAll').innerHTML = rv.batch ? '<i class="fas fa-check-double"></i> このページを全確定' : '<i class="fas fa-check-double"></i> すべて完了';
  }
  function reviewGo(delta) {
    reviewSaveEdit();
    const rv = S.review; if (!rv) return;
    const n = rv.idx + delta;
    if (n < 0) return;
    if (n >= rv.result.fields.length) { reviewComplete(); return; }
    rv.idx = n; reviewRender();
    $('reviewValue').focus(); $('reviewValue').select();
  }
  async function reviewComplete() {
    reviewSaveEdit();
    const rv = S.review; if (!rv) return;
    /* 一括（OCR中確認）: このページを確定 → ループ側が保存して次ページへ
       （次ページが先読み済みなら待ちなしで切り替わる。未完了なら直後にループが「認識中」を出す） */
    if (rv.batch) { const done = rv.batch.resolve; S.review = null; done('done'); return; }
    const { form, result } = rv;
    reviewHide();
    UI.renderFieldResults(result.fields);   // 修正を画面に反映
    await saveResult(form, result);
    const ok = result.fields.filter(f => !f.error).length;
    UI.toast(`確認完了 — ${ok}/${result.fields.length} フィールドをDBへ保存しました`, 'success');
  }
  function reviewCancel() {
    const rv = S.review;
    /* 一括（OCR中確認）: 中止 → このページは保存せずループを終了（ここまでは保存済み） */
    if (rv && rv.batch) { const stop = rv.batch.resolve; S.review = null; stop('stop'); return; }
    reviewHide();
    UI.toast('確認をキャンセルしました（未保存）。結果は画面に表示中です', 'info', 4000);
  }

  /* デバッグパネル設定で上書きした帳票を返す */
  function effectiveForm() {
    const form = S.forms.find(f => f.id === S.recogFormId); if (!form) return null;
    /* デバッグ編集中の抽出パターン・文字制約を各領域へ反映 */
    const ocrRegions = (form.ocrRegions || []).map(r => ({
      ...r,
      pattern: (S.patternOverrides[r.id] ?? r.pattern) || '',
      charRule: (S.constraintOverrides[r.id] !== undefined ? S.constraintOverrides[r.id] : (r.charRule || r.constraint)) || null,
    }));
    return { ...form, ocrRegions, lineRemoval: collectDbgLineRemoval(), ocrSettings: collectDbgOcr() };
  }

  /* 帳票の設定をデバッグパネル全体（OCR/罫線/抽出パターン/文字制約）へ読み込む */
  function loadFormIntoDebug(form) {
    applyDbgToUI(form);
    S.patternOverrides = {};
    S.constraintOverrides = {};
    (form.ocrRegions || []).forEach(r => { S.patternOverrides[r.id] = r.pattern || ''; S.constraintOverrides[r.id] = (r.charRule || r.constraint) || null; });
    const sel = $('dbgPatRegion'); sel.innerHTML = '';
    (form.ocrRegions || []).forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.name; sel.appendChild(o); });
    loadDbgPatternForSelected();
    S.dbgLoadedFormId = form.id;
  }
  function loadDbgPatternForSelected() {
    const id = $('dbgPatRegion').value;
    $('dbgPattern').value = S.patternOverrides[id] || '';
    updateDbgConsSummary();
  }
  function updateDbgConsSummary() {
    const id = $('dbgPatRegion').value;
    const rule = S.constraintOverrides[id];
    const active = CharConstraint.isActive(rule);
    $('dbgConsSummary').textContent = active ? `${CharConstraint.lengthLabel(rule)}: ${CharConstraint.describe(rule)}` : '制約なし';
    $('dbgConsSummary').classList.toggle('is-set', active);
  }
  function openDbgConstraintEditor() {
    const id = $('dbgPatRegion').value; if (!id) return UI.toast('対象フィールドがありません', 'warning');
    const name = $('dbgPatRegion').selectedOptions[0]?.textContent || '';
    CharRuleEditor.open(name, S.constraintOverrides[id], async rule => {
      S.constraintOverrides[id] = rule;
      updateDbgConsSummary();
      /* 文字制約は構造的設定のため、編集と同時に帳票へ反映・永続化する
         （再実行で初期化されて「保存されない」ように見える問題を防ぐ）。
         デバッグパネルに読み込み中の帳票を対象にする。 */
      const form = S.forms.find(f => f.id === (S.dbgLoadedFormId || S.recogFormId));
      const reg = form && (form.ocrRegions || []).find(r => r.id === id);
      if (reg) {
        reg.charRule = rule; delete reg.constraint;
        try { await FormDB.putForm(form); UI.toast('文字制約を帳票に保存しました', 'success', 1800); }
        catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'error'); }
      }
    });
  }
  function syncDbgPattern() {
    const id = $('dbgPatRegion').value;
    if (id) S.patternOverrides[id] = $('dbgPattern').value.trim();
  }
  function collectDbgOcr() {
    return { psm: parseInt($('dbgPsm').value, 10), lang: $('dbgLang').value, whitelist: $('dbgWhitelist').value, normalize: $('dbgNormalize').checked, normalizeKanji: $('dbgNormalizeKanji').checked };
  }

  /* デバッグパネル: 値の収集 / UI 反映 / 二値化行トグル */
  function collectDbgLineRemoval() {
    const v = id => $(id).value, vi = id => parseInt($(id).value, 10), vc = id => $(id).checked;
    return {
      binaryMethod: v('dbgBinaryMethod'), manualThresh: vi('dbgManualThresh'),
      adaptiveBlock: vi('dbgAdaptiveBlock'), adaptiveC: vi('dbgAdaptiveC'),
      enableHoriz: vc('dbgEnableHoriz'), horizLen: vi('dbgHorizLen'), horizThick: vi('dbgHorizThick'), horizDilate: vi('dbgHorizDilate'),
      enableVert: vc('dbgEnableVert'), vertLen: vi('dbgVertLen'), vertThick: vi('dbgVertThick'), vertDilate: vi('dbgVertDilate'),
      maskDilate: vi('dbgMaskDilate'), outputBase: v('dbgOutputBase'),
    };
  }
  function applyDbgToUI(form) {
    const p = form.lineRemoval || LineRemovalProcessor.defaultParams();
    const set = (id, val) => { const e = $(id); if (e) e[e.type === 'checkbox' ? 'checked' : 'value'] = val; };
    const txt = (id, val) => { const e = $(id); if (e) e.textContent = val; };
    set('dbgLang', form.ocrSettings?.lang || 'eng'); set('dbgPsm', String(form.ocrSettings?.psm ?? 3));
    set('dbgWhitelist', form.ocrSettings?.whitelist || ''); set('dbgNormalize', form.ocrSettings?.normalize !== false);
    set('dbgNormalizeKanji', !!form.ocrSettings?.normalizeKanji);
    set('dbgBinaryMethod', p.binaryMethod);
    set('dbgManualThresh', p.manualThresh); txt('dbgValThresh', p.manualThresh);
    set('dbgAdaptiveBlock', p.adaptiveBlock); txt('dbgValBlock', p.adaptiveBlock);
    set('dbgAdaptiveC', p.adaptiveC); txt('dbgValC', p.adaptiveC);
    set('dbgEnableHoriz', p.enableHoriz);
    set('dbgHorizLen', p.horizLen); txt('dbgValHLen', p.horizLen);
    set('dbgHorizThick', p.horizThick); txt('dbgValHThick', p.horizThick);
    set('dbgHorizDilate', p.horizDilate); txt('dbgValHDil', p.horizDilate);
    set('dbgEnableVert', p.enableVert);
    set('dbgVertLen', p.vertLen); txt('dbgValVLen', p.vertLen);
    set('dbgVertThick', p.vertThick); txt('dbgValVThick', p.vertThick);
    set('dbgVertDilate', p.vertDilate); txt('dbgValVDil', p.vertDilate);
    set('dbgMaskDilate', p.maskDilate); txt('dbgValMaskDil', p.maskDilate);
    set('dbgOutputBase', p.outputBase || 'original');
    updateDbgBinaryRows();
  }
  function updateDbgBinaryRows() {
    const m = $('dbgBinaryMethod').value;
    $('dbgRowThresh').classList.toggle('hidden', m !== 'manual');
    $('dbgRowBlock').classList.toggle('hidden', m !== 'adaptive');
    $('dbgRowC').classList.toggle('hidden', m !== 'adaptive');
  }
  async function saveSettingsToForm() {
    const form = S.forms.find(f => f.id === S.recogFormId); if (!form) return UI.toast('対象帳票がありません', 'warning');
    form.lineRemoval = collectDbgLineRemoval();
    form.ocrSettings = collectDbgOcr();
    form.ocrRegions = (form.ocrRegions || []).map(r => {
      const out = { ...r, pattern: (S.patternOverrides[r.id] ?? r.pattern) || '' };
      out.charRule = (S.constraintOverrides[r.id] !== undefined ? S.constraintOverrides[r.id] : (r.charRule || r.constraint)) || null;
      delete out.constraint;   // 旧形式は破棄
      return out;
    });
    try { await FormDB.putForm(form); await loadForms(); UI.toast(`「${form.name}」に設定を保存しました`, 'success'); }
    catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'error'); }
  }

  /* ── プリセット（OCR/罫線除去設定の保存・呼び出し） ── */
  async function loadPresets() {
    let presets = [];
    try { presets = await FormDB.getAllPresets(); } catch (_) {}
    S.presets = presets;
    const sel = $('presetSelect'); const cur = sel.value;
    sel.innerHTML = '<option value="">（プリセットを選択）</option>';
    presets.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }
  function currentDbgPreset() {
    /* 抽出パターン・文字制約はフィールド名で保持（別帳票へも適用できるよう移植性を確保） */
    const form = S.forms.find(f => f.id === S.recogFormId);
    const patterns = {}, constraints = {};
    if (form) (form.ocrRegions || []).forEach(r => {
      const p = (S.patternOverrides[r.id] ?? r.pattern) || ''; if (p) patterns[r.name] = p;
      const cn = (S.constraintOverrides[r.id] !== undefined ? S.constraintOverrides[r.id] : (r.charRule || r.constraint));
      if (CharConstraint.isActive(cn)) constraints[r.name] = CharConstraint.normalize(cn);
    });
    return { ocrSettings: collectDbgOcr(), lineRemoval: collectDbgLineRemoval(), patterns, constraints };
  }
  async function savePreset() {
    const name = prompt('プリセット名を入力', `設定 ${new Date().toLocaleString('ja-JP')}`);
    if (name === null) return;
    const preset = { id: uid(), name: (name || '無題').trim(), ...currentDbgPreset(), createdAt: Date.now() };
    try { await FormDB.putPreset(preset); await loadPresets(); $('presetSelect').value = preset.id; UI.toast(`プリセット「${preset.name}」を保存しました`, 'success'); }
    catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'error'); }
  }
  function applyPreset() {
    const id = $('presetSelect').value; if (!id) return UI.toast('プリセットを選択してください', 'warning');
    const p = (S.presets || []).find(x => x.id === id); if (!p) return;
    applyDbgToUI({ lineRemoval: p.lineRemoval, ocrSettings: p.ocrSettings });
    /* 抽出パターン・文字制約をフィールド名で現在帳票の領域へ反映 */
    if (p.patterns || p.constraints) {
      const form = S.forms.find(f => f.id === S.recogFormId);
      if (form) (form.ocrRegions || []).forEach(r => {
        if (p.patterns && p.patterns[r.name] !== undefined) S.patternOverrides[r.id] = p.patterns[r.name];
        if (p.constraints && p.constraints[r.name] !== undefined) S.constraintOverrides[r.id] = p.constraints[r.name];
      });
      loadDbgPatternForSelected();
    }
    UI.toast(`プリセット「${p.name}」を反映しました。「再実行」で試せます`, 'info', 3500);
  }
  async function deletePreset() {
    const id = $('presetSelect').value; if (!id) return UI.toast('プリセットを選択してください', 'warning');
    const p = (S.presets || []).find(x => x.id === id);
    if (!confirm(`プリセット「${p ? p.name : ''}」を削除しますか？`)) return;
    try { await FormDB.deletePreset(id); await loadPresets(); UI.toast('プリセットを削除しました', 'info'); }
    catch (e) { UI.toast('削除に失敗しました: ' + e.message, 'error'); }
  }

  /* ── PSM 全パターン比較 ─────────────────────────────── */
  function openPsmModal() {
    if (!S.recogMatchInfo || !S.recogFormId) return UI.toast('先に帳票を適用（OCR実行）してください', 'warning');
    const form = S.forms.find(f => f.id === S.recogFormId); if (!form) return;
    const sel = $('psmRegionSelect'); sel.innerHTML = '';
    (form.ocrRegions || []).forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.name; sel.appendChild(o); });
    $('psmResults').innerHTML = ''; $('psmCrop').classList.add('hidden');
    $('psmModal').classList.remove('hidden');
  }
  async function runPsmCompare() {
    if (!S.recogMatchInfo) return;
    const form = effectiveForm(); if (!form) return;
    const region = (form.ocrRegions || []).find(r => r.id === $('psmRegionSelect').value) || (form.ocrRegions || [])[0];
    if (!region) return UI.toast('OCR領域がありません', 'warning');
    $('btnPsmRun').disabled = true;
    $('psmProgress').classList.remove('hidden'); $('psmResults').innerHTML = '';
    const setProg = (msg, pct) => { $('psmProgressFill').style.width = `${Math.round(pct * 100)}%`; $('psmProgressMsg').textContent = msg; };
    setProg('罫線除去中…', 0.05);
    try {
      const prep = await Recognizer.prepare(S.recogCanvas, form, S.recogMatchInfo);
      if (prep.error) { $('psmProgress').classList.add('hidden'); $('btnPsmRun').disabled = false; return UI.toast('前処理エラー: ' + prep.error, 'error'); }
      const crop = LineRemovalProcessor.extractRect(prep.resultCanvas, Recognizer.mapRect(region, prep.transform));
      if (crop) { $('psmCropImg').src = crop.toDataURL('image/png'); $('psmCrop').classList.remove('hidden'); }
      const results = await Recognizer.comparePsm(prep.resultCanvas, prep.transform, region, PSM_LIST,
        { lang: form.ocrSettings.lang || 'eng', whitelist: form.ocrSettings.whitelist || '', normalize: form.ocrSettings.normalize !== false, kanji: !!form.ocrSettings.normalizeKanji },
        (i, total, psm) => setProg(`PSM ${psm} を認識中… (${i + 1}/${total})`, (i + 1) / total));
      LineRemovalProcessor.cleanupMats(prep.previewMats);
      $('psmProgress').classList.add('hidden');
      renderPsmResults(results);
    } catch (e) { $('psmProgress').classList.add('hidden'); UI.toast('PSM比較エラー: ' + e.message, 'error', 5000); }
    finally { $('btnPsmRun').disabled = false; }
  }
  function renderPsmResults(results) {
    const c = $('psmResults'); c.innerHTML = '';
    const maxConf = Math.max(0, ...results.map(r => r.confidence || 0));
    results.forEach(r => {
      const cls = r.confidence >= 85 ? 'hi' : r.confidence >= 60 ? 'mid' : 'lo';
      const isBest = r.confidence > 0 && r.confidence === maxConf;
      const row = document.createElement('div'); row.className = 'psm-row' + (isBest ? ' is-best' : '');
      const txt = r.error ? `[エラー: ${r.error}]` : (r.text || '（空）');
      row.innerHTML = `
        <span class="psm-tag">PSM ${r.psm}<small>${PSM_DESC[r.psm] || ''}</small></span>
        <span class="psm-text ${r.text ? '' : 'empty'}"></span>
        <span class="psm-conf ${cls}">${r.confidence}%</span>
        <button class="btn btn-ghost btn-sm" data-psm="${r.psm}">採用</button>`;
      row.querySelector('.psm-text').textContent = txt;
      row.querySelector('button').addEventListener('click', () => {
        $('dbgPsm').value = String(r.psm);
        $('psmModal').classList.add('hidden');
        UI.toast(`PSM ${r.psm} を採用しました。「再実行」で反映されます`, 'success', 3500);
      });
      c.appendChild(row);
    });
  }

  /* 罫線除去結果プレビューの描画（ズーム反映） */
  function renderResultPreview() {
    if (!S.recogResult) return;
    const { resultCanvas, transform, regions, angle } = S.recogResult;
    const scale = UI.renderRecogPreview(resultCanvas, transform, regions, angle, S.rrZoom);
    $('rrZoomLabel').textContent = Math.round(scale * 100) + '%';
  }

  /* 認識結果を履歴レコードへ整形（単一ページ・一括の共通処理）。
     DB出力用に page（ページ数）と ocrValues（OCR1, OCR2,… の番号付き値）も保持する。 */
  async function buildResultRecord(form, dec, result, srcCanvas, manual, page) {
    const avgConf = result.fields.length ? Math.round(result.fields.reduce((s, f) => s + (f.confidence || 0), 0) / result.fields.length) : 0;
    /* OCRエリア名 → 値（DB出力・照合用）。名前が無い場合のみ OCRn で補完 */
    const ocrValues = {};
    result.fields.forEach((f, i) => { ocrValues[f.name || ('OCR' + (i + 1))] = f.text || ''; });
    /* 各フィールドの切り出し画像を縮小JPEGで保持（照合での見比べ用）。OCR時に生成済みなので再計算は不要 */
    const fields = await Promise.all(result.fields.map(async f => ({
      name: f.name, text: f.text, confidence: f.confidence, error: f.error || null,
      crop: await shrinkDataURL(f.cropDataURL),
    })));
    return {
      id: uid(),
      formId: form.id, formName: form.name,
      page: page || 1,
      createdAt: Date.now(),
      sourceThumb: thumbURL(srcCanvas, 90),
      decision: manual ? 'review' : dec.decision,
      confidence: dec.confidence,
      angle: result.angle,
      overallFieldConfidence: avgConf,
      ocrValues,                                   // { OCR1:'…', OCR2:'…' }（DB出力用）
      voting: { margin: dec.margin, legacySignal: dec.legacySignal, ranking: (dec.ranking || []).map(r => ({ formName: r.formName, peak: r.peak, agg: r.agg, support: r.support })) },
      settings: { ocr: form.ocrSettings, lineRemoval: form.lineRemoval },
      fields,
    };
  }
  async function saveResult(form, result) {
    if (S.navReviewMode) return;                 // 一括結果の確認のための再実行は保存しない（重複防止）
    const dec = S.lastClassify.decision;
    const manual = !(dec.best && dec.best.formId === form.id);
    const record = await buildResultRecord(form, dec, result, S.recogCanvas, manual, S.recogPageNum || 1);
    try { await FormDB.putResult(record); $('saveStatus').innerHTML = `<i class="fas fa-circle-check"></i> IndexedDB に保存しました（平均信頼度 ${record.overallFieldConfidence}%）`; refreshHistory(); }
    catch (e) { $('saveStatus').textContent = '保存に失敗: ' + e.message; }
  }

  function copyAllFields() {
    const rows = document.querySelectorAll('#fieldResults .field-row');
    if (!rows.length) return UI.toast('コピーするデータがありません', 'warning');
    const lines = Array.from(rows).map(r => `${r.querySelector('.field-name').textContent}: ${r.querySelector('.field-text').value}`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => UI.toast('全フィールドをコピーしました', 'success')).catch(() => UI.toast('コピーに失敗しました', 'error'));
  }

  /* ════════════════════════════════════════════════════
     複数ページ一括OCR（PDFの全ページ）
     ════════════════════════════════════════════════════ */
  /* 1枚のキャンバスを判定→OCRする（保存はしない／UIは触らない）。
     forcedFormId 指定時はその帳票で必ずOCR。未指定（自動）でも、確信度が低く
     「要確認」でも best候補があれば停止せずOCRする（複数ページで止まらないように）。
     確認カルーセルで修正してから保存できるよう、保存用の材料を _save に持たせて返す。 */
  async function ocrPageForBatch(canvas, page, forcedFormId) {
    const thumb = thumbURL(canvas, 120);
    try {
      const { decision, scores } = await Recognizer.classify(canvas, S.forms, classifyOpts());
      const candId = decision.best && decision.best.formId;
      const useId = forcedFormId || candId;
      const form = useId ? S.forms.find(f => f.id === useId) : null;
      if (!form) return { page, decision: decision.decision, formName: '—', fields: [], thumb };
      /* 表示用の判定ラベル: 手動指定=指定どおり採用 / 自動=本来の判定を踏襲 */
      const verdict = forcedFormId ? 'accepted' : decision.decision;
      const res = await Recognizer.runOcr(canvas, form, bestAnchorFor(form, scores), {}, {});
      if (res.error) { LineRemovalProcessor.cleanupMats(res.previewMats); return { page, decision: 'error', formName: form.name, error: res.error, thumb }; }
      LineRemovalProcessor.cleanupMats(res.previewMats);
      const manual = forcedFormId ? true : !(candId === form.id);
      const avg = res.fields.length ? Math.round(res.fields.reduce((s, f) => s + (f.confidence || 0), 0) / res.fields.length) : 0;
      return {
        page, decision: verdict, formName: form.name, formId: form.id, forced: !!forcedFormId,
        avgConf: avg, fields: res.fields, thumb,
        _save: { form, dec: decision, res, canvas, manual, page },   // 確認後に putResult する材料
      };
    } catch (e) {
      return { page, decision: 'error', formName: '—', error: e.message || String(e), thumb };
    }
  }

  /* 一括結果1ページ分を履歴(IndexedDB)へ保存。確認カルーセルでの修正は
     res.fields[].text に反映済みなので、そのまま buildResultRecord が拾う。 */
  async function persistBatchRecord(r) {
    if (!r || !r._save) return;
    const s = r._save;
    try { await FormDB.putResult(await buildResultRecord(s.form, s.dec, s.res, s.canvas, s.manual, s.page)); } catch (_) {}
    r._save = null;   // ページ全体の canvas/結果への参照を解放（大量ページでもメモリ一定に保つ）
  }

  /* 指定範囲のページを順に一括OCR（pageSource = { pages:[n…], total, getPage(n), done() }）。
     大量ページでも 1枚ずつ描画→OCR→破棄するためメモリは一定。中止可能。 */
  async function runBatchPdf(src) {
    if (!S.cvReady) { src.done && src.done(); return UI.toast('OpenCV.js 読み込み中です', 'warning'); }
    if (!S.forms.length) { src.done && src.done(); return UI.toast('先に帳票を登録してください', 'warning'); }
    releasePageNav();                            // 前回の一括結果ナビゲーションを解放
    const pages = src.pages || [];
    const total = src.total || pages.length;
    const review = !!src.review;                 // OCR中に1ページずつカルーセルで確認するか
    S.batchCancel = false;
    const results = [];
    let cancelled = false;
    if (review) reviewBatchOpen(total); else UI.openBatchModal(total);

    /* 1ページ分のラスタライズ＋OCRを開始し、完了フラグ付きで返す（先読み用に await しない）。
       確認中に次ページを裏でOCRしておくことで、確定→次ページの待ち時間をなくす。 */
    const ocrAt = i => {
      if (i < 0 || i >= pages.length) return null;
      const p = pages[i];
      const forcedFormId = src.formFor ? src.formFor(p) : '';
      const entry = { page: p, ready: false };
      entry.promise = (async () => {
        let canvas;
        try { canvas = await src.getPage(p); }
        catch (_) { return { page: p, decision: 'error', formName: '—', error: 'ページ描画に失敗', thumb: '' }; }
        return await ocrPageForBatch(canvas, p, forcedFormId);
      })();
      entry.promise.then(() => { entry.ready = true; }, () => { entry.ready = true; });
      return entry;
    };

    let cur = ocrAt(0);                          // 先頭ページのOCRを先行開始
    try {
      for (let idx = 0; idx < pages.length; idx++) {
        if (!cur || S.batchCancel) { if (S.batchCancel) cancelled = true; break; }
        const p = pages[idx], pct = idx / Math.max(1, total);
        if (!cur.ready) {                        // 先読みが間に合っていない時だけ「認識中」を出す
          const msg = `ページ ${p}（${idx + 1}/${total}）を認識中…`;
          if (review) { reviewBatchBusy(true); reviewBatchProgress(msg, pct); }
          else UI.updateBatchProgress(msg, pct);
          await new Promise(r => setTimeout(r, 5));   // 進捗描画・中止受付の隙間
        }
        const r = await cur.promise;
        const nextEntry = ocrAt(idx + 1);        // ★先読み: 確認している間に次ページを裏でOCR
        /* review: OCR結果を1ページずつ写真と見比べ→修正→確認してから保存 */
        if (review && r._save && r.fields && r.fields.length) {
          const action = await reviewBatchPage(r, idx, total);
          if (action === 'stop') { cancelled = true; break; }   // 中止: このページは保存しない
        }
        await persistBatchRecord(r);
        results.push(r);
        cur = nextEntry;
      }
    } finally { /* 詳細ペインでのページ送り用に PDF を保持するため、ここでは破棄しない */ }
    if (review) reviewBatchClose();              // 確認カルーセルを閉じてからサマリを出す（重なり防止）
    S.batchResults = results;
    /* 処理済みページを詳細ペインで1枚ずつ確認できるよう、PDFソースを保持
       （次の一括/新規読み込み時に releasePageNav で破棄）。 */
    if (src.getPage && results.length) {
      S.pageNav = { pages: results.map(r => r.page), idx: 0, started: false, getPage: src.getPage, done: src.done, fileName: src.fileName };
      updatePageNavUI();                       // 詳細ペインにページ送りバーを表示（モーダルを閉じても使える）
    } else if (src.done) { try { src.done(); } catch (_) {} }
    if (review) UI.openBatchModal(total);        // 確認後にサマリ（CSV出力など）を表示
    UI.updateBatchProgress('完了', 1);
    UI.renderBatchResults(results, { hasNav: !!S.pageNav });
    refreshHistory();
    const ok = results.filter(r => r.decision === 'accepted').length;
    UI.toast(`一括OCR${cancelled ? '中止' : '完了'} — ${results.length}/${total}ページ処理・${ok}件採用、履歴に保存`, cancelled ? 'warning' : 'success', 4500);
  }

  /* ── OCR中カルーセル確認（一括OCRで review=ON）──────────
     reviewModal を確認のホストに流用。ページOCR中は進捗バー＋「認識中」を出し、
     OCR完了でそのページのフィールドをカルーセル表示→修正→確認（保存はループ側）。 */
  function reviewBatchOpen(total) {
    S.review = null;
    $('reviewModal').classList.remove('hidden');
    $('reviewBatchBar').classList.remove('hidden');
    $('reviewPageCtx').classList.add('hidden');
    reviewBatchProgress(`全 ${total} ページを認識します…`, 0);
    reviewBatchBusy(true);
  }
  function reviewBatchProgress(msg, pct) {
    $('reviewBatchFill').style.width = `${Math.round((pct || 0) * 100)}%`;
    $('reviewBatchMsg').textContent = msg || '処理中…';
  }
  /* 認識中はカードを伏せて操作を止める（次ページのOCR待ち表示） */
  function reviewBatchBusy(busy) {
    ['reviewValue', 'reviewPrev', 'reviewNext', 'reviewAll'].forEach(id => { const el = $(id); if (el) el.disabled = !!busy; });
    if (busy) {
      $('reviewFieldName').textContent = '認識中…';
      $('reviewCrop').src = '';
      $('reviewValue').value = '';
      $('reviewConf').innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> ページを認識しています…';
      $('reviewSyms').innerHTML = '';
      $('reviewProgress').textContent = '';
    }
  }
  function reviewBatchClose() {
    $('reviewBatchBar').classList.add('hidden');
    $('reviewPageCtx').classList.add('hidden');
    $('reviewModal').classList.add('hidden');
    S.review = null;
  }
  /* 1ページ分のカルーセルを開き、確認完了('done')／中止('stop')を待つ */
  function reviewBatchPage(r, idx, total) {
    return new Promise(resolve => {
      reviewBatchBusy(false);
      reviewBatchProgress(`ページ ${r.page}（${idx + 1}/${total}）を確認中…`, (idx + 0.5) / Math.max(1, total));
      $('reviewPageCtx').textContent = `ページ ${r.page}（${idx + 1}/${total}）`;
      $('reviewPageCtx').classList.remove('hidden');
      S.review = { form: r._save.form, result: r._save.res, idx: 0, batch: { resolve } };
      reviewRender();
      setTimeout(() => { $('reviewValue').focus(); $('reviewValue').select(); }, 60);
    });
  }

  /* ── 一括OCR結果のページ送り（詳細ペインで1枚ずつ拡大確認） ──
     保持した PDF から該当ページを都度ラスタライズし、単ページ認識の詳細ビュー
     （ズーム/OCR領域/フィールド/帳票の選び直し）に読み込む。常に1枚分のみ描画。 */
  function releasePageNav() {
    if (S.pageNav && S.pageNav.done) { try { S.pageNav.done(); } catch (_) {} }
    S.pageNav = null;
    const bar = $('rrPageNav'); if (bar) bar.classList.add('hidden');
  }
  function updatePageNavUI() {
    const nav = S.pageNav, bar = $('rrPageNav'); if (!bar) return;
    if (!nav || !nav.pages.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    if (nav.started) {
      $('rrPageLabel').textContent = `P${nav.pages[nav.idx]}（${nav.idx + 1} / ${nav.pages.length}）`;
      $('btnRrPrev').disabled = nav.idx <= 0;
      $('btnRrNext').disabled = nav.idx >= nav.pages.length - 1;
    } else {
      $('rrPageLabel').textContent = `全 ${nav.pages.length} ページ`;   // 未読み込み: 「次」で先頭から確認
      $('btnRrPrev').disabled = true;
      $('btnRrNext').disabled = false;
    }
  }
  /* 未読み込みなら先頭、読み込み済みなら現在位置からの相対移動 */
  function navStep(delta) {
    const nav = S.pageNav; if (!nav) return;
    navLoadPage(nav.started ? nav.idx + delta : 0);
  }
  async function navLoadPage(idx) {
    const nav = S.pageNav; if (!nav || S.navReviewMode) return;
    idx = Math.max(0, Math.min(nav.pages.length - 1, idx));
    nav.idx = idx; nav.started = true;
    const pageNum = nav.pages[idx];
    updatePageNavUI();
    $('btnRrPrev').disabled = $('btnRrNext').disabled = true;   // 読み込み中は連打を防止
    let canvas;
    try { canvas = await nav.getPage(pageNum); }
    catch (_) { updatePageNavUI(); return UI.toast('ページの描画に失敗しました', 'error'); }
    S.navReviewMode = true;                       // 確認目的の再実行は履歴へ保存しない（重複防止）
    try {
      loadRecogImage(canvas, true);
      S.recogPageNum = pageNum;
      await runRecognize();
      /* 一括時に使った帳票が分かるなら、その帳票での結果を再現する */
      const rec = (S.batchResults || []).find(r => r.page === pageNum);
      if (rec && rec.formId && S.recogFormId !== rec.formId) await applyForm(rec.formId);
    } finally {
      S.navReviewMode = false;
      updatePageNavUI();
    }
  }

  /* OCR結果を「ページ数, OCR1, OCR2, …」形式の CSV に整形（DB出力フォーマット）。
     rows: [{ page, formName, decision, fields:[{text}] }]。OCR列はページ最大数に合わせる。 */
  function resultsToCsv(rows) {
    /* 列は OCRエリア名（決定時に付けた名前）の和集合（出現順） */
    const names = [];
    rows.forEach(r => (r.fields || []).forEach(f => { if (f.name && !names.includes(f.name)) names.push(f.name); }));
    const esc = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v == null ? '' : v);
    const head = ['ページ数', ...names, '帳票', '判定'];
    const verdict = { accepted: '採用', review: '要確認', rejected: '不一致', error: 'エラー' };
    const lines = rows.map(r => {
      const map = {}; (r.fields || []).forEach(f => { map[f.name] = f.text || ''; });
      const cols = [r.page ?? '', ...names.map(n => map[n] ?? ''), r.formName || '', verdict[r.decision] || r.decision || ''];
      return cols.map(esc).join(',');
    });
    return [head.map(esc).join(','), ...lines].join('\n');
  }
  function copyCsvToClipboard(csv) {
    navigator.clipboard.writeText(csv).then(() => UI.toast('CSVをコピーしました', 'success')).catch(() => UI.toast('コピーに失敗しました', 'error'));
  }
  /* CSV をファイルとしてダウンロード（BOM付きで Excel の文字化け回避） */
  function downloadCsv(csv, name) {
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    UI.toast(`${name} を保存しました`, 'success');
  }
  function copyBatchCsv() {
    const results = S.batchResults || [];
    if (!results.length) return UI.toast('コピーするデータがありません', 'warning');
    copyCsvToClipboard(resultsToCsv(results));
  }
  function downloadBatchCsv() {
    const results = S.batchResults || [];
    if (!results.length) return UI.toast('出力するデータがありません', 'warning');
    downloadCsv(resultsToCsv(results), `ocr_batch_${Date.now()}.csv`);
  }
  /* 履歴（IndexedDB）の全件を CSV 出力 */
  async function exportHistoryCsv() {
    let rows = [];
    try { rows = await FormDB.getAllResults(100000); } catch (_) {}
    if (!rows.length) return UI.toast('履歴がありません', 'warning');
    downloadCsv(resultsToCsv(rows), `ocr_history_${Date.now()}.csv`);
  }

  /* ── 履歴 ───────────────────────────────────────────── */
  async function refreshHistory() {
    let results = [];
    try { results = await FormDB.getAllResults(50); } catch (_) {}
    UI.renderHistory(results, { onDelete: async id => { await FormDB.deleteResult(id); refreshHistory(); } });
  }
  async function clearHistory() {
    if (!confirm('認識履歴をすべて削除しますか？')) return;
    await FormDB.clearResults(); refreshHistory(); UI.toast('履歴を削除しました', 'info');
  }

  /* ════════════════════════════════════════════════════
     共通 UI 配線
     ════════════════════════════════════════════════════ */
  function setupDrop(zoneId, onFile, clickFileId) {
    const z = $(zoneId); if (!z) return;
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('drag-over'); });
    z.addEventListener('dragleave', () => z.classList.remove('drag-over'));
    z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) onFile(f); });
    if (clickFileId) z.addEventListener('click', () => $(clickFileId).click());
  }

  /* レイアウト設定(JSON)のドロップ取り込み。ファイルのドラッグ時のみ反応し、
     JSON以外がドロップされたら警告する。 */
  function setupJsonDrop(zoneId, onJsonFile) {
    const z = $(zoneId); if (!z) return;
    const isFileDrag = e => Array.from(e.dataTransfer?.types || []).includes('Files');
    z.addEventListener('dragover', e => { if (!isFileDrag(e)) return; e.preventDefault(); z.classList.add('json-drag'); });
    z.addEventListener('dragleave', e => { if (e.target === z) z.classList.remove('json-drag'); });
    z.addEventListener('drop', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); z.classList.remove('json-drag');
      const f = e.dataTransfer.files[0]; if (!f) return;
      if (f.type === 'application/json' || /\.json$/i.test(f.name)) onJsonFile(f);
      else UI.toast('レイアウト設定の JSON ファイルをドロップしてください', 'warning', 4000);
    });
  }

  function initAccordions() {
    document.querySelectorAll('.acc-hdr').forEach(hdr => {
      const body = $(hdr.dataset.acc);
      if (body && body.classList.contains('is-collapsed')) hdr.classList.add('is-collapsed');
      hdr.addEventListener('click', () => { const collapsed = body.classList.toggle('is-collapsed'); hdr.classList.toggle('is-collapsed', collapsed); });
    });
  }
  function initRegSliders() {
    [['regManualThresh', 'regValThresh'], ['regAdaptiveBlock', 'regValBlock'], ['regAdaptiveC', 'regValC'],
     ['regHorizLen', 'regValHLen'], ['regHorizThick', 'regValHThick'], ['regHorizDilate', 'regValHDil'],
     ['regVertLen', 'regValVLen'], ['regVertThick', 'regValVThick'], ['regVertDilate', 'regValVDil'],
     ['regMaskDilate', 'regValMaskDil']].forEach(([s, v]) => {
      const sl = $(s), vl = $(v); if (!sl || !vl) return;
      sl.addEventListener('input', () => { vl.textContent = sl.value; });
    });
  }
  /* デバッグパネルのスライダー値ラベル + 二値化トグル */
  function initDbgControls() {
    [['dbgManualThresh', 'dbgValThresh'], ['dbgAdaptiveBlock', 'dbgValBlock'], ['dbgAdaptiveC', 'dbgValC'],
     ['dbgHorizLen', 'dbgValHLen'], ['dbgHorizThick', 'dbgValHThick'], ['dbgHorizDilate', 'dbgValHDil'],
     ['dbgVertLen', 'dbgValVLen'], ['dbgVertThick', 'dbgValVThick'], ['dbgVertDilate', 'dbgValVDil'],
     ['dbgMaskDilate', 'dbgValMaskDil']].forEach(([s, v]) => {
      const sl = $(s), vl = $(v); if (!sl || !vl) return;
      sl.addEventListener('input', () => { vl.textContent = sl.value; });
    });
    $('dbgBinaryMethod').addEventListener('change', updateDbgBinaryRows);
    $('dbgWlQuick').addEventListener('click', e => { const btn = e.target.closest('button[data-wl]'); if (btn) $('dbgWhitelist').value = btn.dataset.wl; });
    /* フィールド抽出パターン編集 */
    $('dbgPatRegion').addEventListener('change', loadDbgPatternForSelected);
    $('dbgPattern').addEventListener('input', syncDbgPattern);
    $('dbgPatQuick').addEventListener('click', e => {
      const btn = e.target.closest('button[data-tok]'); if (!btn) return;
      const inp = $('dbgPattern');
      if (btn.dataset.tok === 'CLR') inp.value = ''; else inp.value += btn.dataset.tok;
      syncDbgPattern();
    });
    /* フィールド文字制約編集（ビジュアルエディタを開く） */
    $('dbgConsEdit').addEventListener('click', openDbgConstraintEditor);
    $('debugToggle').addEventListener('click', () => {
      const collapsed = $('debugBody').classList.toggle('is-collapsed');
      $('debugToggle').classList.toggle('is-collapsed', collapsed);
    });
    $('btnRerun').addEventListener('click', rerun);
    $('btnSaveSettingsToForm').addEventListener('click', saveSettingsToForm);
  }
  /* 罫線除去結果プレビューのドラッグ・パン */
  function initRrPan() {
    const wrap = $('rrCanvasWrap'); let ps = null;
    wrap.addEventListener('mousedown', e => { ps = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop }; wrap.classList.add('panning'); e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (!ps) return; wrap.scrollLeft = ps.sl - (e.clientX - ps.x); wrap.scrollTop = ps.st - (e.clientY - ps.y); });
    window.addEventListener('mouseup', () => { if (ps) { ps = null; wrap.classList.remove('panning'); } });
  }

  /* ── グローバル paste（モード/モーダルに応じて振り分け） ── */
  function handlePaste(e) {
    const items = e.clipboardData?.items; if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      fileToDataURL(item.getAsFile()).then(url => {
        if (S.mode === 'register' && !$('editorForm').classList.contains('hidden')) {
          if (!S.refImg) setReference(url); else { /* 既に基準画像あり: アンカー候補として自動配置 */ addAnchorFromImage(url); }
        } else if (S.mode === 'recognize') {
          dataURLtoImg(url).then(img => loadRecogImage(canvasFromImg(img)));
        }
      });
      return;
    }
  }

  /* ── 設定モーダル ───────────────────────────────────── */
  function applySettingsToUI() {
    const s = S.settings;
    const set = (id, v, lbl, d) => { $(id).value = v; if (lbl) $(lbl).textContent = Number(v).toFixed(d); };
    set('setAcceptConf', s.acceptConf, 'setValAcceptConf', 2);
    set('setNearExact', s.nearExact, 'setValNearExact', 2);
    set('setAcceptFloor', s.acceptFloor, 'setValAcceptFloor', 2);
    set('setMarginMin', s.marginMin, 'setValMarginMin', 2);
    set('setAngleRange', s.angleRange, 'setValAngle', 0);
    $('setScaleMode').value = s.scaleMode;
  }
  function openSettings() { applySettingsToUI(); $('settingsModal').classList.remove('hidden'); }
  function closeSettings() { $('settingsModal').classList.add('hidden'); }
  function saveSettings() {
    const num = id => parseFloat($(id).value);
    S.settings = {
      acceptConf: num('setAcceptConf'), nearExact: num('setNearExact'),
      acceptFloor: num('setAcceptFloor'), marginMin: num('setMarginMin'),
      angleRange: parseInt($('setAngleRange').value, 10), scaleMode: $('setScaleMode').value,
    };
    persistSettings();
    closeSettings();
    UI.toast('設定を保存しました', 'success');
  }
  function resetSettings() { S.settings = defaultSettings(); applySettingsToUI(); UI.toast('既定値に戻しました（保存で確定）', 'info'); }

  /* ── 帳票のインポート / エクスポート ────────────────── */
  function downloadJson(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportForms() {
    let forms = [];
    try { forms = await FormDB.getAllForms(); } catch (_) {}
    if (!forms.length) return UI.toast('エクスポートする帳票がありません', 'warning');
    downloadJson({ app: 'chouhyou-ocr', version: 1, exportedAt: new Date().toISOString(), matchSettings: S.settings, forms }, `forms_${Date.now()}.json`);
    UI.toast(`${forms.length} 件の帳票を書き出しました`, 'success');
  }
  async function importFormsFromFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const forms = Array.isArray(data) ? data : (data.forms || []);
      if (!forms.length) return UI.toast('帳票が見つかりません', 'warning');
      let n = 0;
      for (const f of forms) {
        if (!f || !f.referenceImage || !f.referenceImage.dataURL) continue;
        const copy = {
          ...f, id: uid(), isSample: false, createdAt: Date.now(), updatedAt: Date.now(),
          /* アンカー/領域の内部IDは振り直し（既存帳票とのID衝突を防ぐ） */
          anchors: (f.anchors || []).map(a => ({ ...a, id: uid() })),
          ocrRegions: (f.ocrRegions || []).map(r => ({ ...r, id: uid() })),
        };
        await FormDB.putForm(copy); n++;
      }
      if (!Array.isArray(data) && data.matchSettings && confirm('判定しきい値などの設定も取り込みますか？')) {
        S.settings = { ...defaultSettings(), ...data.matchSettings }; persistSettings();
      }
      await loadForms();
      UI.toast(`${n} 件の帳票を読み込みました`, 'success');
    } catch (e) { UI.toast('読み込みに失敗しました: ' + (e.message || e), 'error', 6000); }
  }

  /* ════════════════════════════════════════════════════
     照合（OCR結果 × 外部データ）
     ════════════════════════════════════════════════════ */
  const recEsc = v => String(v == null ? '' : v);
  const recHtml = s => recEsc(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /* 文字コードを意識してデコード（Excel等は Shift-JIS が多い→文字化け対策） */
  function recDecode(buf, mode) {
    const u8 = new Uint8Array(buf);
    const dec = enc => { try { return new TextDecoder(enc, { fatal: false }).decode(u8); } catch (_) { return ''; } };
    if (mode === 'utf-8') return dec('utf-8');
    if (mode === 'shift_jis') return dec('shift_jis') || dec('utf-8');
    const a = dec('utf-8'), b = dec('shift_jis');
    const bad = s => (s.match(/�/g) || []).length;     // 置換文字が少ない方を採用
    return bad(b) < bad(a) ? b : a;
  }
  function recSplitLine(line, delim) {
    if (delim === 'comma') {     // 引用符対応の簡易CSV
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur); return out.map(s => s.trim());
    }
    if (delim === 'space') return line.trim().split(/\s+/);
    const sep = delim === 'tab' ? '\t' : ';';
    return line.split(sep).map(s => s.trim());
  }
  /* 区切り文字の自動判定は1行目だけでなく複数行を見て多数決で決める。
     実ファイルはタイトル等で1行目に区切り文字が無いことがあり、1行目だけで判定すると
     ファイル全体が誤って1列扱いになってしまうため。 */
  function recDetectDelim(lines) {
    const sample = lines.slice(0, 30);
    const score = ch => sample.filter(l => l.includes(ch)).length;
    const candidates = [['tab', '\t'], ['comma', ','], ['semicolon', ';']];
    let best = null, bestScore = 0;
    candidates.forEach(([name, ch]) => { const s = score(ch); if (s > bestScore) { bestScore = s; best = name; } });
    return best || 'space';
  }
  function recSplitLines(text) {
    return text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length);
  }
  /* 行の配列を指定の区切り（'auto'可）で列分割する。同じ行数のまま区切りだけ変えられるため、
     「テーブルで確認・整形」内で区切りパターンを変えても行の削除/見出し選択(index基準)は保たれる。 */
  function recRowsFromLines(lines, delimSel) {
    const delim = delimSel === 'auto' ? recDetectDelim(lines) : delimSel;
    return { delim, rows: lines.map(l => recSplitLine(l, delim)) };
  }
  function recFill(id, opts) {
    const s = $(id); s.innerHTML = '';
    opts.forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); });
  }
  async function openReconcile() {
    let rows = [];
    try { rows = await FormDB.getAllResults(100000); } catch (_) {}
    const cols = [];
    rows.forEach(r => (r.fields || []).forEach(f => { if (f.name && !cols.includes(f.name)) cols.push(f.name); }));
    if (!rows.length) return UI.toast('照合する認識結果がありません（先にOCRを実行）', 'warning');
    S.rec = {
      ocr: rows.map(r => { const values = {}, crops = {}; (r.fields || []).forEach(f => { values[f.name] = f.text || ''; if (f.crop) crops[f.name] = f.crop; }); return { page: r.page || 1, formName: r.formName || '', values, crops }; }),
      ocrCols: cols, ext: null, result: null,
    };
    const ocrOpts = ['ページ', '帳票', ...cols];
    recFill('recOcrKey', ocrOpts);
    recFill('recOcrVal', ['(なし)', ...ocrOpts]);
    recFill('recExtKey', []); recFill('recExtVal', ['(なし)']);
    $('recPreview').innerHTML = ''; $('recResult').innerHTML = ''; $('recSummary').classList.add('hidden'); $('recExport').disabled = true;
    $('recPreviewInfo').textContent = ''; $('recPreviewExpand').disabled = true;
    $('reconcileModal').classList.remove('hidden');
  }
  function closeReconcile() { $('reconcileModal').classList.add('hidden'); }
  const REC_PREVIEW_ROWS = 8;        // このモーダル内の簡易プレビューはここまで（全件は別モーダルで確認・整形）
  const REC_TABLE_ROW_CAP = 5000;    // 全件表示モーダルでも重くなりすぎないための上限
  const recRowBlank = r => r.every(c => !c || !c.trim());
  function recFindFirstNonBlank(rows, from) {
    for (let i = from; i < rows.length; i++) if (!recRowBlank(rows[i])) return i;
    return from;
  }
  function recParse() {
    if (!S.rec) return;
    const text = $('recPaste').value;
    if (!text.trim()) return UI.toast('比較データを貼り付けるかファイルを読み込んでください', 'warning');
    const lines = recSplitLines(text);
    if (!lines.length) return UI.toast('データを解析できませんでした', 'warning');
    const delimSel = $('recDelim').value;
    const { delim, rows } = recRowsFromLines(lines, delimSel);
    const hasHeader = $('recHasHeader').checked;
    /* 生の行(lines)を保持し、区切りパターンは「テーブルで確認・整形」内でいつでも変えて
       見比べられるようにする。見出し行/削除行もここでは確定せず、暫定で「先頭の空白でない
       行」を見出しにし、実ファイルにありがちな「見出しが4行目から」等は同モーダルで選び
       直せるようにする。 */
    S.rec.raw = { lines, delimSel, delim, rows, excluded: new Set(), headerIdx: hasHeader ? recFindFirstNonBlank(rows, 0) : -1 };
    applyRecShape();
    const n = S.rec.ext.rows.length;
    UI.toast(`比較データ ${n} 行 × ${S.rec.ext.header.length} 列を読み込みました`, 'success', 2500);
  }
  /* 削除された行が見出し行だった場合は選び直しを促す（headerIdxを未選択に戻す） */
  function recExcludeRow(idx) {
    const raw = S.rec.raw; if (!raw) return;
    raw.excluded.add(idx);
    if (raw.headerIdx === idx) raw.headerIdx = -1;
  }
  /* S.rec.raw（生の行・見出し行・削除行）から S.rec.ext（header, rows）を再構成し、
     照合の設定セレクトや簡易プレビューへ反映する。「テーブルで確認・整形」の適用時と
     初回パース時の両方から呼ばれる。 */
  function applyRecShape() {
    const raw = S.rec.raw; if (!raw) return;
    const { rows, excluded, headerIdx } = raw;
    let header;
    if (headerIdx >= 0) {
      header = rows[headerIdx].map((h, i) => (h && h.trim()) ? h : `列${i + 1}`);
    } else {
      /* 見出し行が無い場合、列数は先頭行ではなく残っている行の最大セル数から決める
         （特定の行だけ列が少ないために他行の末尾が切れるのを防ぐ） */
      const maxCols = rows.reduce((m, r, i) => (excluded.has(i) ? m : Math.max(m, r.length)), 0);
      header = Array.from({ length: maxCols }, (_, i) => `列${i + 1}`);
    }
    const data = [];
    rows.forEach((r, i) => {
      if (i === headerIdx) return;                       // 見出し行自体はデータに含めない
      if (headerIdx >= 0 && i < headerIdx) return;        // 見出しより上は無視
      if (excluded.has(i)) return;                        // 個別削除・空白行削除
      data.push(r);
    });
    S.rec.ext = { header, rows: data };
    recFill('recExtKey', header);
    recFill('recExtVal', ['(なし)', ...header]);
    renderRecPreview(header, data);
    $('recPreviewInfo').textContent = `${data.length} 行 × ${header.length} 列を読み込みました`;
    $('recPreviewExpand').disabled = false;
  }
  function renderRecPreview(header, data) {
    const head = '<tr>' + header.map(h => `<th>${recHtml(h)}</th>`).join('') + '</tr>';
    const body = data.slice(0, REC_PREVIEW_ROWS).map(r => '<tr>' + header.map((_, i) => `<td>${recHtml(r[i] ?? '')}</td>`).join('') + '</tr>').join('');
    $('recPreview').innerHTML = `<div class="rec-tbl-wrap"><table class="rec-tbl">${head}${body}</table></div>`
      + (data.length > REC_PREVIEW_ROWS ? `<div class="rec-more">… 他 ${data.length - REC_PREVIEW_ROWS} 行（「テーブルで確認・整形」で全件を表示できます）</div>` : '');
  }
  /* 比較データの全件を別モーダルの大きな表で確認・整形する。
     行頭のラジオボタンで見出し行を選び直せる（データがどの行から始まるか目視で決める）。
     ✕で個別削除、「空白の行を削除」で全セル空白の行を一括削除できる。「適用」を押すまで
     S.rec.ext（実際に照合で使うデータ）は変わらない。 */
  function openRecTableModal() {
    if (!S.rec || !S.rec.raw) return;
    renderRecTableModalBody();
    $('recTableModal').classList.remove('hidden');
  }
  function renderRecTableModalBody() {
    const raw = S.rec.raw; if (!raw) return;
    const { rows, excluded, headerIdx } = raw;
    $('recTableDelim').value = raw.delimSel;
    /* 列数は「見出し行」に選んだ行のセル数で決める（適用時と同じ基準）。見出し未選択なら
       除外していない行の最大セル数。それを超える分は「余分」として別枠で見える化する
       （見出し行より列が多い行があり、適用すると末尾が捨てられることに気づけるように）。 */
    const headerCols = headerIdx >= 0
      ? rows[headerIdx].length
      : rows.reduce((m, r, i) => (excluded.has(i) ? m : Math.max(m, r.length)), 0);
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    $('recTableCount').textContent = `(${rows.length} 行 × ${headerCols} 列${maxCols > headerCols ? `＋余分 最大${maxCols - headerCols}列` : ''})`;
    const mainHead = Array.from({ length: headerCols }, (_, i) => `<th>列${i + 1}</th>`).join('');
    const extraHead = Array.from({ length: Math.max(0, maxCols - headerCols) }, (_, i) => `<th class="rec-th-extra">余分${i + 1}</th>`).join('');
    const head = `<tr><th class="rec-tbl-rownum">#</th><th class="rec-tbl-hdrcol">見出し行</th><th class="rec-tbl-delcol"></th>${mainHead}${extraHead}</tr>`;
    const shown = rows.slice(0, REC_TABLE_ROW_CAP);
    const body = shown.map((r, i) => {
      const cls = [
        i === headerIdx ? 'rec-row-header' : '',
        headerIdx >= 0 && i < headerIdx ? 'rec-row-above' : '',
        recRowBlank(r) ? 'rec-row-blank' : '',
        excluded.has(i) ? 'rec-row-excluded' : '',
      ].filter(Boolean).join(' ');
      const mainCells = Array.from({ length: headerCols }, (_, ci) => `<td>${recHtml(r[ci] ?? '')}</td>`).join('');
      const extraCells = Array.from({ length: Math.max(0, maxCols - headerCols) }, (_, k) => `<td class="rec-td-extra">${recHtml(r[headerCols + k] ?? '')}</td>`).join('');
      return `<tr class="${cls}" data-idx="${i}">`
        + `<td class="rec-tbl-rownum">${i + 1}</td>`
        + `<td class="rec-tbl-hdrcol"><input type="radio" name="recHeaderRadio" data-idx="${i}"${i === headerIdx ? ' checked' : ''} title="この行を見出しにする"></td>`
        + `<td class="rec-tbl-delcol"><button type="button" class="rec-row-del" data-idx="${i}" title="この行を削除"><i class="fas fa-xmark"></i></button></td>`
        + mainCells + extraCells + '</tr>';
    }).join('');
    $('recTableFull').innerHTML = `<table class="rec-tbl rec-edit-tbl">${head}${body}</table>`
      + (rows.length > REC_TABLE_ROW_CAP ? `<div class="rec-more">… 表示・編集は先頭 ${REC_TABLE_ROW_CAP} 行のみ（全 ${rows.length} 行）</div>` : '');
  }
  /* テーブル内で区切りパターンを変更 → 同じ行数のまま列だけ切り直して再描画（見出し選択・
     削除はindex基準なので保たれる）。見出し行を変えた時に列数が追従しないという声から、
     どちらもここで即座に反映されるようにした。 */
  function recTableDelimChange() {
    const raw = S.rec && S.rec.raw; if (!raw) return;
    const delimSel = $('recTableDelim').value;
    const { delim, rows } = recRowsFromLines(raw.lines, delimSel);
    raw.delimSel = delimSel; raw.delim = delim; raw.rows = rows;
    renderRecTableModalBody();
  }
  function recTableRowRadioChange(e) {
    const radio = e.target.closest('input[name="recHeaderRadio"]'); if (!radio) return;
    S.rec.raw.headerIdx = parseInt(radio.dataset.idx, 10);
    renderRecTableModalBody();
  }
  function recTableRowDelClick(e) {
    const btn = e.target.closest('.rec-row-del'); if (!btn) return;
    recExcludeRow(parseInt(btn.dataset.idx, 10));
    renderRecTableModalBody();
  }
  function recRemoveBlankRows() {
    const raw = S.rec && S.rec.raw; if (!raw) return;
    let n = 0;
    raw.rows.forEach((r, i) => { if (recRowBlank(r) && !raw.excluded.has(i)) { recExcludeRow(i); n++; } });
    renderRecTableModalBody();
    UI.toast(n ? `空白の行を ${n} 件削除しました` : '空白の行はありませんでした', n ? 'success' : 'info', 2500);
  }
  function recResetRowExclusions() {
    const raw = S.rec && S.rec.raw; if (!raw) return;
    raw.excluded.clear();   // 削除の取り消しのみ。見出し行の選択はそのまま（未選択なら手動で選び直す）
    renderRecTableModalBody();
  }
  function recTableApply() {
    applyRecShape();
    closeRecTableModal();
    UI.toast(`${S.rec.ext.rows.length} 行 × ${S.rec.ext.header.length} 列を適用しました`, 'success', 2500);
  }
  function closeRecTableModal() { $('recTableModal').classList.add('hidden'); }
  function recReadFile(file) {
    const r = new FileReader();
    r.onload = () => { $('recPaste').value = recDecode(r.result, $('recEnc').value); recParse(); };
    r.onerror = () => UI.toast('ファイルの読み込みに失敗しました', 'error');
    r.readAsArrayBuffer(file);
  }
  function recRun() {
    if (!S.rec || !S.rec.ext) return UI.toast('先に比較データを読み込んでください', 'warning');
    const ocrKey = $('recOcrKey').value;
    const extKeyIdx = S.rec.ext.header.indexOf($('recExtKey').value);
    const ocrValCol = $('recOcrVal').value, extValName = $('recExtVal').value;
    const extValIdx = S.rec.ext.header.indexOf(extValName);
    const numeric = $('recNumeric').checked;
    const compareVals = ocrValCol !== '(なし)' && extValName !== '(なし)' && extValIdx >= 0;
    const norm = s => recEsc(s).trim().replace(/\s+/g, '');
    const numNorm = s => { const n = parseFloat(recEsc(s).replace(/[,\s¥￥$]/g, '')); return isFinite(n) ? n : null; };
    const getOcr = (r, col) => col === 'ページ' ? r.page : col === '帳票' ? r.formName : (r.values[col] ?? '');
    /* 行ごとの見比べ画像: 値比較時はOCR値フィールド、それ以外はキーのフィールドの切り出しを使う */
    const getCrop = (r, col) => (col && col !== 'ページ' && col !== '帳票' && r.crops) ? (r.crops[col] || '') : '';
    const extMap = new Map();
    S.rec.ext.rows.forEach(row => { const k = norm(row[extKeyIdx]); if (k && !extMap.has(k)) extMap.set(k, row); });
    let nMatch = 0, nNo = 0, nMiss = 0;
    const out = S.rec.ocr.map(r => {
      const keyVal = getOcr(r, ocrKey);
      const ext = extMap.get(norm(keyVal));
      let verdict, ocrShown = '', extShown = '';
      if (!ext) { verdict = '該当なし'; nMiss++; }
      else if (compareVals) {
        ocrShown = getOcr(r, ocrValCol); extShown = ext[extValIdx] ?? '';
        const eq = numeric ? (() => { const a = numNorm(ocrShown), b = numNorm(extShown); return a != null && b != null && a === b; })()
                           : norm(ocrShown) === norm(extShown);
        verdict = eq ? '〇' : '×'; eq ? nMatch++ : nNo++;
      } else { verdict = '〇'; extShown = ext.join(' '); nMatch++; }
      const crop = getCrop(r, (compareVals && ext) ? ocrValCol : ocrKey);
      return { page: r.page, key: keyVal, ocr: ocrShown, ext: extShown, verdict, compareVals, crop };
    });
    S.rec.result = out;
    renderRecResult(out, { nMatch, nNo, nMiss, compareVals });
    $('recExport').disabled = false;
  }
  function renderRecResult(out, st) {
    const sum = $('recSummary'); sum.classList.remove('hidden');
    sum.innerHTML = st.compareVals
      ? `${out.length}件 ・ <span class="bs-ok">一致 ${st.nMatch}</span> / <span class="bs-rj">不一致 ${st.nNo}</span> / <span class="bs-er">該当なし ${st.nMiss}</span>`
      : `${out.length}件 ・ <span class="bs-ok">キー一致 ${st.nMatch}</span> / <span class="bs-er">該当なし ${st.nMiss}</span>`;
    const hasCrop = out.some(r => r.crop);   // 旧データ（切り出し未保存）では画像列を出さない
    const head = `<tr><th>ページ</th><th>キー</th>${st.compareVals ? '<th>OCR値</th><th>外部値</th>' : '<th>外部データ</th>'}${hasCrop ? '<th>切り出し画像</th>' : ''}<th>判定</th></tr>`;
    const cls = v => v === '〇' ? 'rv-ok' : v === '×' ? 'rv-no' : 'rv-miss';
    const body = out.map(r => `<tr><td>${recHtml(r.page)}</td><td>${recHtml(r.key)}</td>`
      + (st.compareVals ? `<td>${recHtml(r.ocr)}</td><td>${recHtml(r.ext)}</td>` : `<td>${recHtml(r.ext)}</td>`)
      + (hasCrop ? `<td class="rec-crop-cell">${r.crop ? `<img class="rec-crop" src="${r.crop}" alt="切り出し" loading="lazy">` : ''}</td>` : '')
      + `<td class="${cls(r.verdict)}">${r.verdict}</td></tr>`).join('');
    $('recResult').innerHTML = `<div class="rec-tbl-wrap rec-result-wrap"><table class="rec-tbl rec-result-tbl">${head}${body}</table></div>`;
  }
  function recExport() {
    const out = S.rec && S.rec.result; if (!out || !out.length) return;
    const cmp = out[0].compareVals;
    const esc = v => /[",\n]/.test(v) ? `"${recEsc(v).replace(/"/g, '""')}"` : recEsc(v);
    const head = ['ページ', 'キー', ...(cmp ? ['OCR値', '外部値'] : ['外部データ']), '判定'];
    const lines = out.map(r => [r.page, r.key, ...(cmp ? [r.ocr, r.ext] : [r.ext]), r.verdict].map(esc).join(','));
    downloadCsv([head.map(esc).join(','), ...lines].join('\n'), `reconcile_${Date.now()}.csv`);
  }

  /* ── Init ───────────────────────────────────────────── */
  function init() {
    initAccordions(); initRegSliders(); initRegCanvasEvents(); initDbgControls(); initRrPan();
    CharRuleEditor.init();
    PdfImport.init();

    /* モード切替 */
    $('modeRegister').addEventListener('click', () => setMode('register'));
    $('modeRecognize').addEventListener('click', () => setMode('recognize'));

    /* ライブラリ */
    $('btnNewForm').addEventListener('click', newForm);
    $('btnNewForm2').addEventListener('click', newForm);
    $('btnLoadSampleForms').addEventListener('click', loadSampleForms);
    $('btnClearForms').addEventListener('click', async () => { if (!confirm('登録帳票をすべて削除しますか？')) return; await FormDB.clearForms(); await loadForms(); cancelEdit(); UI.toast('全帳票を削除しました', 'info'); });

    /* エディタ: 名前/基準画像/設定（画像・PDF 共通の入口を使用） */
    $('formNameInput').addEventListener('input', refreshSteps);
    const useAsReference = c => setReference(c.toDataURL('image/png'));
    const useAsAnchor    = c => addAnchorFromImage(c.toDataURL('image/png'));
    setupDrop('refDropZone', f => acceptFile(f, useAsReference), 'refFileInput');
    $('refFileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) acceptFile(f, useAsReference); e.target.value = ''; });
    $('btnRefSample').addEventListener('click', openSampleFormModal);
    setupDrop('anchorDropZone', f => acceptFile(f, useAsAnchor), 'anchorFileInput');
    $('anchorFileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) acceptFile(f, useAsAnchor); e.target.value = ''; });
    $('regBinaryMethod').addEventListener('change', updateBinaryRows);

    /* 描画 */
    document.querySelectorAll('#drawModeSwitch .dm-btn').forEach(b => b.addEventListener('click', () => setDrawMode(b.dataset.dm)));
    $('rectNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitPending(); } });
    $('btnAddRect').addEventListener('click', commitPending);
    $('btnZoomIn').addEventListener('click', () => { S.zoom = Math.min(8, S.zoom * 1.3); redrawRegCanvas(); $('zoomLabel').textContent = Math.round(activeScale() * 100) + '%'; });
    $('btnZoomOut').addEventListener('click', () => { S.zoom = Math.max(0.2, S.zoom / 1.3); redrawRegCanvas(); $('zoomLabel').textContent = Math.round(activeScale() * 100) + '%'; });
    $('btnZoomFit').addEventListener('click', () => { S.zoom = 1; redrawRegCanvas(); $('zoomLabel').textContent = Math.round(activeScale() * 100) + '%'; });

    /* 保存 / キャンセル */
    $('btnSaveForm').addEventListener('click', saveForm);
    $('btnCancelEdit').addEventListener('click', cancelEdit);

    /* OCR工程（画像・PDF 共通の入口。PDFは複数ページの一括OCRも可。
       一括では「ページ範囲ごとに使う帳票」を割り当てられる） */
    const recogOpts = { onBatch: runBatchPdf, allowBatch: true, getForms: () => S.forms.map(f => ({ id: f.id, name: f.name })), getReviewDefault: () => !!($('recogReviewMode') && $('recogReviewMode').checked) };
    setupDrop('recogDrop', f => acceptFile(f, loadRecogImage, recogOpts), 'recogFileInput');
    $('recogFileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) acceptFile(f, loadRecogImage, recogOpts); e.target.value = ''; });
    $('batchClose').addEventListener('click', () => UI.closeBatchModal());
    $('batchCloseBtn').addEventListener('click', () => UI.closeBatchModal());
    $('batchCsv').addEventListener('click', copyBatchCsv);
    $('batchCsvDl').addEventListener('click', downloadBatchCsv);
    $('batchCancel').addEventListener('click', () => { S.batchCancel = true; UI.updateBatchProgress('中止しています…', 1); });
    $('batchReview').addEventListener('click', () => { if (S.pageNav) { UI.closeBatchModal(); navLoadPage(S.pageNav.idx || 0); } });
    $('batchReconcile').addEventListener('click', () => { UI.closeBatchModal(); openReconcile(); });
    $('btnRecogSample').addEventListener('click', () => loadRecogImage(SampleForms.sampleInputCanvas(0, 1.5)));
    $('btnRunRecognize').addEventListener('click', runRecognize);
    $('btnApplyForm').addEventListener('click', () => applyForm($('dpFormSelect').value));
    $('btnCopyAll').addEventListener('click', copyAllFields);
    $('btnClearHistory').addEventListener('click', clearHistory);
    $('btnExportHistory').addEventListener('click', exportHistoryCsv);

    /* 照合（OCR結果 × 外部データ） */
    $('btnReconcile').addEventListener('click', openReconcile);
    $('reconcileClose').addEventListener('click', closeReconcile);
    $('reconcileCloseBtn').addEventListener('click', closeReconcile);
    $('reconcileModal').addEventListener('click', e => { if (e.target === $('reconcileModal')) closeReconcile(); });
    $('recParse').addEventListener('click', recParse);
    $('recRun').addEventListener('click', recRun);
    $('recExport').addEventListener('click', recExport);
    $('recFileBtn').addEventListener('click', () => $('recFileInput').click());
    $('recFileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) recReadFile(f); e.target.value = ''; });
    $('recPreviewExpand').addEventListener('click', openRecTableModal);
    $('recTableClose').addEventListener('click', closeRecTableModal);
    $('recTableCloseBtn').addEventListener('click', closeRecTableModal);
    $('recTableModal').addEventListener('click', e => { if (e.target === $('recTableModal')) closeRecTableModal(); });
    $('recTableApply').addEventListener('click', recTableApply);
    $('recRemoveBlankRows').addEventListener('click', recRemoveBlankRows);
    $('recResetRows').addEventListener('click', recResetRowExclusions);
    $('recTableFull').addEventListener('change', recTableRowRadioChange);
    $('recTableFull').addEventListener('click', recTableRowDelClick);
    $('recTableDelim').addEventListener('change', recTableDelimChange);
    /* テキストエリアへファイルをドロップ */
    const rp = $('recPaste');
    rp.addEventListener('dragover', e => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); rp.classList.add('drag-over'); } });
    rp.addEventListener('dragleave', () => rp.classList.remove('drag-over'));
    rp.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) { e.preventDefault(); rp.classList.remove('drag-over'); recReadFile(f); } });

    /* 罫線除去結果プレビューのズーム */
    $('btnRrZoomIn').addEventListener('click', () => { S.rrZoom = Math.min(8, S.rrZoom * 1.3); renderResultPreview(); });
    $('btnRrZoomOut').addEventListener('click', () => { S.rrZoom = Math.max(0.2, S.rrZoom / 1.3); renderResultPreview(); });
    $('btnRrZoomFit').addEventListener('click', () => { S.rrZoom = 1; renderResultPreview(); });

    /* 一括OCR結果のページ送り（詳細ペインで1枚ずつ確認） */
    $('btnRrPrev').addEventListener('click', () => navStep(-1));
    $('btnRrNext').addEventListener('click', () => navStep(1));
    $('btnRrNavClose').addEventListener('click', () => { releasePageNav(); UI.toast('ページ送りを終了しました', 'info', 2000); });

    /* プリセット */
    $('btnApplyPreset').addEventListener('click', applyPreset);
    $('btnSavePreset').addEventListener('click', savePreset);
    $('btnDeletePreset').addEventListener('click', deletePreset);
    /* 帳票切替で設定パネルにその帳票の登録値を読み込む */
    $('dpFormSelect').addEventListener('change', () => { const f = S.forms.find(x => x.id === $('dpFormSelect').value); if (f) loadFormIntoDebug(f); });
    /* PSM 全パターン比較 */
    $('btnPsmCompare').addEventListener('click', openPsmModal);
    $('btnPsmRun').addEventListener('click', runPsmCompare);
    $('closePsmModal').addEventListener('click', () => $('psmModal').classList.add('hidden'));
    $('psmModal').addEventListener('click', e => { if (e.target === $('psmModal')) $('psmModal').classList.add('hidden'); });

    /* サンプル/ヘルプモーダル */
    $('closeSampleFormModal').addEventListener('click', () => $('sampleFormModal').classList.add('hidden'));
    $('sampleFormModal').addEventListener('click', e => { if (e.target === $('sampleFormModal')) $('sampleFormModal').classList.add('hidden'); });
    $('btnHelp').addEventListener('click', () => $('helpModal').classList.remove('hidden'));
    $('closeHelpModal').addEventListener('click', () => $('helpModal').classList.add('hidden'));
    $('helpModal').addEventListener('click', e => { if (e.target === $('helpModal')) $('helpModal').classList.add('hidden'); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      /* 一括の確認カルーセル中は中止として扱う（ただ閉じるとOCRループが止まったままになる） */
      if (S.review && S.review.batch) { reviewCancel(); return; }
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    });

    /* はじめての方向けガイド（初回のみ表示・閉じたら記憶） */
    try { if (!localStorage.getItem('ocrtool_onboard_dismissed')) $('onboardBar').classList.remove('hidden'); } catch (_) {}
    $('onboardClose').addEventListener('click', () => { $('onboardBar').classList.add('hidden'); try { localStorage.setItem('ocrtool_onboard_dismissed', '1'); } catch (_) {} });
    $('onboardHelp').addEventListener('click', () => $('helpModal').classList.remove('hidden'));

    /* 設定モーダル */
    $('btnSettings').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', closeSettings);
    $('settingsSave').addEventListener('click', saveSettings);
    $('settingsReset').addEventListener('click', resetSettings);
    $('settingsModal').addEventListener('click', e => { if (e.target === $('settingsModal')) closeSettings(); });

    /* 保存前レビュー（カルーセル） */
    $('reviewPrev').addEventListener('click', () => reviewGo(-1));
    $('reviewNext').addEventListener('click', () => reviewGo(1));
    $('reviewAll').addEventListener('click', reviewComplete);
    $('reviewCancel').addEventListener('click', reviewCancel);
    $('reviewClose').addEventListener('click', reviewCancel);
    $('reviewValue').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) reviewComplete(); else reviewGo(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); reviewGo(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); reviewGo(1); }
    });
    [['setAcceptConf', 'setValAcceptConf', 2], ['setNearExact', 'setValNearExact', 2], ['setAcceptFloor', 'setValAcceptFloor', 2], ['setMarginMin', 'setValMarginMin', 2], ['setAngleRange', 'setValAngle', 0]]
      .forEach(([sl, lb, d]) => $(sl).addEventListener('input', () => { $(lb).textContent = Number($(sl).value).toFixed(d); }));

    /* 帳票インポート/エクスポート（ボタン＋ライブラリへJSONドロップ） */
    $('btnExportForms').addEventListener('click', exportForms);
    $('btnImportForms').addEventListener('click', () => $('importFormsInput').click());
    $('importFormsInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFormsFromFile(f); e.target.value = ''; });
    setupJsonDrop('libraryPanel', importFormsFromFile);

    document.addEventListener('paste', handlePaste);

    /* 初期データ + IndexedDB 可用性チェック（file:// の Safari 等で無効な場合に通知） */
    setMode('register');
    if (!window.indexedDB) {
      UI.toast('このブラウザでは IndexedDB が無効のため帳票・履歴を保存できません（Chrome/Edge/Firefox 推奨）', 'warning', 8000);
    } else {
      FormDB.open().catch(() => UI.toast('IndexedDB を初期化できませんでした。Chrome/Edge で開くと保存できます', 'warning', 8000));
    }
    loadSettings();
    loadForms();
    refreshHistory();
    loadPresets();
  }

  document.addEventListener('DOMContentLoaded', init);

})();
