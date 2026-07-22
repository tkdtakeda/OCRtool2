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
    repositioning: null,   // 登録済みアンカー/OCR領域の範囲を描き直し中: { kind:'anchor'|'region', id }
    /* 認識 */
    recogCanvas: null, lastClassify: null,
    recogFormId: null, recogMatchInfo: null, recogResult: null, rrZoom: 1,
    dbgLoadedFormId: null, patternOverrides: {}, constraintOverrides: {},
    batchResults: null, batchCancel: false, batchResume: null, review: null, rec: null,
    batchReviewActive: false, reviewTrustRest: false, reviewGoToReconcileAfterBatch: false,
    recogPageNum: 1, pageNav: null, navReviewMode: false,
    /* 位置ズレ警告: 帳票id→そのセッションで既に目立つ警告を出したか／件数 */
    posWarnShown: new Set(), posWarnCounts: {},
  };

  /* PSM 比較用パターン */
  const PSM_LIST = [3, 4, 6, 7, 8, 10, 11, 13];
  const PSM_DESC = { 3: '自動', 4: '縦列(複数行)', 6: '単一ブロック', 7: '単一行', 8: '単一単語', 10: '単一文字', 11: '疎なテキスト', 13: '生の1行' };

  const uid = () => Math.random().toString(36).slice(2, 11);
  const dataURLtoImg = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('load fail')); i.src = url; });
  const fileToDataURL = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = () => rej(new Error('read fail')); r.readAsDataURL(file); });

  /* willReadFrequently: これらのcanvasはOpenCV(cv.imread)やtoDataURLで直後に
     画素を読み出すため、既定のGPUバッキングだと読み出しのたびにGPU→CPU転送が
     発生して遅い（DevToolsの「Multiple readback operations…」警告の原因）。
     生成時点でこのオプションを付けておくと、以後そのcanvasへの参照はずっと
     ソフトウェアバッキングのまま速く読み出せる。 */
  function canvasFromImg(img) { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0); return c; }
  function thumbURL(canvas, w = 90) { const s = Math.min(1, w / canvas.width); const c = document.createElement('canvas'); c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s); c.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0, c.width, c.height); return c.toDataURL('image/png'); }
  /* 俯瞰サムネイル: 罫線除去済み全体（無ければ元画像）に、変換を掛けたOCR領域の枠を
     重ねて縮小PNGにする。「読み取り位置が全体のどこか」を一覧で一目で確認するため。
     枠が空白や画像外に落ちていれば、帳票の誤判定・位置ずれがその場で分かる。 */
  function overlayThumbURL(baseCanvas, transform, regions, w = 120) {
    const s = Math.min(1, w / baseCanvas.width);
    const c = document.createElement('canvas');
    c.width = Math.round(baseCanvas.width * s);
    c.height = Math.round(baseCanvas.height * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(baseCanvas, 0, 0, c.width, c.height);
    const tf = transform || { sx: 1, sy: 1, tx: 0, ty: 0 };
    (regions || []).forEach(r => {
      const rx = (tf.sx * r.x + tf.tx) * s, ry = (tf.sy * r.y + tf.ty) * s;
      const rw = Math.max(2, tf.sx * r.w * s), rh = Math.max(2, tf.sy * r.h * s);
      ctx.fillStyle = 'rgba(229,62,62,.16)'; ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = '#E53E3E'; ctx.lineWidth = 1.2; ctx.strokeRect(rx, ry, rw, rh);
    });
    return c.toDataURL('image/png');
  }
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
        c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
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
    S.repositioning = null;
    $('formNameInput').value = '';
    $('refPreview').style.display = 'none'; $('refDropHint').style.display = 'flex';
    $('rectNameInput').value = '';
    applyLineRemovalToUI(LineRemovalProcessor.defaultParams());
    $('regPsm').value = '7'; $('regLang').value = 'eng'; $('regWhitelist').value = ''; $('regNormalize').checked = true; $('regNormalizeKanji').checked = false;
    setDrawMode('anchor');
    updateRepositionBanner();
    $('regCanvas').style.display = 'none'; $('regCanvasPlaceholder').style.display = 'flex';
    $('editorEmpty').classList.add('hidden'); $('editorForm').classList.remove('hidden');
    UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor);
    UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName);
    refreshSteps();
    setTimeout(() => $('formNameInput').focus(), 50);
  }

  async function editForm(id) {
    const f = S.forms.find(x => x.id === id); if (!f) return;
    S.editingId = f.id; S.isSampleForm = !!f.isSample;
    $('formNameInput').value = f.name || '';
    S.anchors = (f.anchors || []).map(a => ({ ...a }));
    S.regions = (f.ocrRegions || []).map(r => ({ ...r }));
    S.zoom = 1; S.pending = null; S.repositioning = null;
    S.refNatW = 0; S.refNatH = 0;   // 通常読み込みでは自動スケール調整を発動させない（setReference参照）
    applyLineRemovalToUI(f.lineRemoval || LineRemovalProcessor.defaultParams());
    $('regPsm').value = String(f.ocrSettings?.psm ?? 7); $('regLang').value = f.ocrSettings?.lang || 'eng';
    $('regWhitelist').value = f.ocrSettings?.whitelist || ''; $('regNormalize').checked = f.ocrSettings?.normalize !== false; $('regNormalizeKanji').checked = !!f.ocrSettings?.normalizeKanji;
    $('editorEmpty').classList.add('hidden'); $('editorForm').classList.remove('hidden');
    setDrawMode('anchor');
    updateRepositionBanner();
    UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor);
    UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName);
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
    const oldW = S.refNatW, oldH = S.refNatH;
    const hadRef = !!S.refImg;
    S.refImg = img; S.refNatW = img.naturalWidth; S.refNatH = img.naturalHeight; S.refDataURL = dataURL;
    $('refPreview').src = dataURL; $('refPreview').style.display = 'block'; $('refDropHint').style.display = 'none';
    $('regCanvasPlaceholder').style.display = 'none'; $('regCanvas').style.display = 'block';
    /* 編集中に基準画像を差し替えた場合（例: DPI不一致を直すため同じPDFを別解像度で
       読み込み直す）、既存のアンカー/OCR領域はそのままだと座標が合わなくなる。
       サイズ比から自動的に座標を追随させ、手で描き直す手間を無くす。
       アンカーは切り出し画像も新しい基準画像から再クロップする（テンプレート
       マッチングは実ピクセル内容で行うため、座標だけ動かしても不十分）。
       新規フォーム作成時やeditForm()での通常読み込みではrefNatWが0にリセット
       されているため、ここには来ない（無関係な拡縮を誤って適用しないため）。 */
    if (hadRef && oldW && oldH && (oldW !== S.refNatW || oldH !== S.refNatH) && (S.anchors.length || S.regions.length)) {
      const sx = S.refNatW / oldW, sy = S.refNatH / oldH;
      S.anchors.forEach(a => {
        const refX = Math.round((a.refX || 0) * sx), refY = Math.round((a.refY || 0) * sy);
        const w = Math.max(1, Math.round(a.w * sx)), h = Math.max(1, Math.round(a.h * sy));
        const crop = document.createElement('canvas'); crop.width = w; crop.height = h;
        crop.getContext('2d', { willReadFrequently: true }).drawImage(S.refImg, refX, refY, w, h, 0, 0, w, h);
        Object.assign(a, { refX, refY, w, h, dataURL: crop.toDataURL('image/png') });
      });
      S.regions.forEach(r => {
        r.x = Math.round(r.x * sx); r.y = Math.round(r.y * sy);
        r.w = Math.max(1, Math.round(r.w * sx)); r.h = Math.max(1, Math.round(r.h * sy));
      });
      UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor);
      UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName);
      UI.toast(`基準画像のサイズが変わったため、目印${S.anchors.length}件・OCR領域${S.regions.length}件の位置を自動調整しました（${Math.round(sx * 100)}%）`, 'info', 4500);
    }
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
    const p = S.pending;
    const repos = S.repositioning;
    if (repos && repos.kind === 'anchor') {
      /* 登録済みアンカーの範囲を描き直し：id・他の設定はそのまま、座標と切り出し画像だけ更新 */
      const a = S.anchors.find(x => x.id === repos.id);
      if (a) {
        const crop = document.createElement('canvas'); crop.width = p.w; crop.height = p.h;
        crop.getContext('2d', { willReadFrequently: true }).drawImage(S.refImg, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
        Object.assign(a, { name, dataURL: crop.toDataURL('image/png'), w: p.w, h: p.h, refX: p.x, refY: p.y });
      }
      UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor);
    } else if (repos && repos.kind === 'region') {
      const r = S.regions.find(x => x.id === repos.id);
      if (r) Object.assign(r, { name, x: p.x, y: p.y, w: p.w, h: p.h });
      UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName);
    } else if (S.drawMode === 'anchor') {
      /* 基準画像から切り出してアンカー画像を生成 */
      const crop = document.createElement('canvas'); crop.width = p.w; crop.height = p.h;
      crop.getContext('2d', { willReadFrequently: true }).drawImage(S.refImg, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
      S.anchors.push({ id: uid(), name, dataURL: crop.toDataURL('image/png'), w: p.w, h: p.h, refX: p.x, refY: p.y });
      UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor);
    } else {
      S.regions.push({ id: uid(), name, x: p.x, y: p.y, w: p.w, h: p.h });
      UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName);
    }
    S.repositioning = null; S.pending = null; $('rectNameInput').value = ''; $('btnAddRect').disabled = true;
    updateRepositionBanner();
    redrawRegCanvas(); refreshSteps();
    UI.toast(repos ? `「${name}」の範囲を更新しました` : `「${name}」を追加しました`, 'success', 1600);
  }
  function removeAnchor(id) { S.anchors = S.anchors.filter(a => a.id !== id); UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor); redrawRegCanvas(); refreshSteps(); }
  function removeRegion(id) { S.regions = S.regions.filter(r => r.id !== id); UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName); redrawRegCanvas(); refreshSteps(); }
  function setRegionPattern(id, val) { const r = S.regions.find(x => x.id === id); if (r) r.pattern = (val || '').trim(); }
  function setRegionGlobalName(id, val) { const r = S.regions.find(x => x.id === id); if (r) r.globalName = (val || '').trim(); }
  function renameAnchor(id, name) { const a = S.anchors.find(x => x.id === id); if (a) { a.name = name; redrawRegCanvas(); } }
  function renameRegion(id, name) { const r = S.regions.find(x => x.id === id); if (r) { r.name = name; redrawRegCanvas(); } }
  function openRegionConstraintEditor(id) {
    const r = S.regions.find(x => x.id === id); if (!r) return;
    CharRuleEditor.open(r.name, r.charRule || r.constraint, rule => {
      r.charRule = rule; delete r.constraint;   // 旧形式(文字列)は新形式へ移行
      UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName);
    });
  }
  /* ── 登録済みアンカー/OCR領域の位置を描き直す ─────────
     「範囲を描き直す」ボタン押下→次の1回のドラッグを、新規追加ではなく
     対象の座標更新として扱う。名前欄は現在の名前を保持（そのままドラッグすれば
     名前は変わらず、書き換えれば改名も同時にできる）。 */
  function startReposition(kind, id) {
    const list = kind === 'anchor' ? S.anchors : S.regions;
    const item = list.find(x => x.id === id); if (!item) return;
    S.repositioning = { kind, id };
    setDrawMode(kind === 'anchor' ? 'anchor' : 'ocr');
    $('rectNameInput').value = item.name;
    updateRepositionBanner();
    UI.toast(`「${item.name}」の新しい範囲を画像上でドラッグしてください`, 'info', 3500);
  }
  function startRepositionAnchor(id) { startReposition('anchor', id); }
  function startRepositionRegion(id) { startReposition('region', id); }
  function cancelReposition() {
    if (!S.repositioning) return;
    S.repositioning = null; S.pending = null; $('rectNameInput').value = ''; $('btnAddRect').disabled = true;
    updateRepositionBanner(); redrawRegCanvas();
  }
  function updateRepositionBanner() {
    const b = $('repositionBanner'); if (!b) return;
    const active = !!S.repositioning;
    b.classList.toggle('hidden', !active);
    if (active) $('repositionBannerText').textContent = `「${$('rectNameInput').value}」の位置を再設定中：画像上でドラッグしてください`;
  }

  /* ── 別画像から識別アンカーを自動配置 ───────────────── */
  async function addAnchorFromImage(dataURL) {
    if (!S.refImg) { UI.toast('先に基準画像を読み込んでください', 'warning'); return; }
    if (!S.cvReady) { UI.toast('OpenCV.js 読み込み中です', 'warning'); return; }
    try {
      const img = await dataURLtoImg(dataURL);
      const refCanvas = canvasFromImg(S.refImg);
      const map = await MatcherEngine.matchAll(refCanvas, [{ id: '_a', imageElement: img }], { angleRange: 0, angleStep: 1 });
      const r = map.get('_a') || { score: 0, loc: { x: 0, y: 0 } };
      if (r.score < 0.5) { UI.toast(`基準画像内に見つかりませんでした（スコア ${r.score.toFixed(2)}）`, 'warning', 4000); return; }
      const name = prompt('識別アンカー名を入力', `アンカー${S.anchors.length + 1}`);
      if (name === null) return;
      S.anchors.push({ id: uid(), name: (name || 'アンカー').trim(), dataURL, w: img.naturalWidth, h: img.naturalHeight, refX: r.loc.x, refY: r.loc.y });
      UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor); redrawRegCanvas(); refreshSteps();
      UI.toast(`自動配置しました（スコア ${r.score.toFixed(2)}, 位置 ${r.loc.x},${r.loc.y}）`, 'success', 3500);
    } catch (e) { UI.toast('処理に失敗しました: ' + e.message, 'error'); }
  }

  /* ── 目印（アンカー）の識別性チェック（他の帳票との類似度） ──
     matchTemplateは正規化相関でピクセル模様を比較するだけで文字を読んでいるわけではない
     ため、見た目には別物でも「似た構造」（罫線グリッド・生成された枠・同じくらいの
     太さ/量の文字が同じような位置にあるタイトル等）は高スコアで一致し得る。
     「厳選したつもり」を実測で検証できるよう、各目印を他の全帳票の基準画像に対して
     実際に照合し、しきい値以上で一致する帳票があれば警告する。 */
  const ANCHOR_COLLISION_WARN = 0.45;   // voting.jsのacceptFloorと揃える（採用判定に効き得る水準）
  async function checkAnchorSimilarity() {
    if (!S.anchors.length) return UI.toast('目印を1つ以上登録してから実行してください', 'warning');
    const others = S.forms.filter(f => f.id !== S.editingId && f.referenceImage && f.referenceImage.dataURL);
    if (!others.length) return UI.toast('比較できる他の帳票がありません（先に複数の帳票を登録してください）', 'info');
    UI.toast('他の帳票との類似度を確認中…', 'info', 2500);
    const templates = S.anchors.map(a => ({ id: a.id, imageElement: null, dataURL: a.dataURL }));
    for (const t of templates) t.imageElement = await dataURLtoImg(t.dataURL);
    /* classify() の帳票判定と同じ探索条件（角度±2°・倍率0.85〜1.15）で照合し、
       実運用で本当に競合し得るスコアかを見る。 */
    const collisions = new Map();   // anchorId -> [{ formName, score }]
    for (const f of others) {
      let img;
      try { img = await dataURLtoImg(f.referenceImage.dataURL); } catch (_) { continue; }
      const scores = await MatcherEngine.matchAll(img, templates, { angleRange: 2, angleStep: 1, scaleFactors: [0.85, 1.0, 1.15] });
      templates.forEach(t => {
        const r = scores.get(t.id);
        if (r && r.score >= ANCHOR_COLLISION_WARN) {
          if (!collisions.has(t.id)) collisions.set(t.id, []);
          collisions.get(t.id).push({ formName: f.name, score: r.score });
        }
      });
    }
    collisions.forEach(list => list.sort((a, b) => b.score - a.score));
    UI.renderAnchorCollisions(collisions);
    const nWarn = collisions.size;
    UI.toast(nWarn
      ? `${nWarn} 件の目印で他の帳票との高い類似度を検出しました（一覧に表示）`
      : '他の帳票との高い類似度は検出されませんでした', nWarn ? 'warning' : 'success', 4500);
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
        S.refNatW = 0; S.refNatH = 0;   // 通常読み込みでは自動スケール調整を発動させない（setReference参照）
        $('formNameInput').value = f.name;
        applyLineRemovalToUI(f.lineRemoval); $('regPsm').value = String(f.ocrSettings.psm);
        UI.renderAnchorList(S.anchors, removeAnchor, renameAnchor, startRepositionAnchor); UI.renderRegionList(S.regions, removeRegion, setRegionPattern, openRegionConstraintEditor, renameRegion, startRepositionRegion, setRegionGlobalName);
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

  /* ── 位置ズレ（スケール不一致）の注意喚起 ─────────────
     基準画像と実際にOCRする画像とで拡大率が大きく違うと（例: 登録時とは
     別のDPIでPDFを読み込んだ）、原点の再ローカライズが対応できる範囲
     （およそ0.8〜1.22倍）を超え、OCR領域の位置が気づかれないままずれる。
     認知心理学的な設計:
       ・色+アイコンの二重符号化で「よくある成功/情報トースト」と区別する
       ・具体的な数値と直接の対処法を示し、思い出す負荷を減らす(再認>再生)
       ・同じ帳票で連発すると慣れて見なくなる(アラーム疲れ)ため、目立つ
         通知はセッション中その帳票につき最初の1回のみ。以降は件数だけ
         静かに積算し、バッチ完了時にまとめて知らせる。 */
  function checkPositionWarning(form, matchQuality) {
    if (!form || !matchQuality || !(matchQuality.scaleEdge || matchQuality.weakMatch)) return;
    S.posWarnCounts[form.id] = (S.posWarnCounts[form.id] || 0) + 1;
    if (S.posWarnShown.has(form.id)) return;
    S.posWarnShown.add(form.id);
    const pct = Math.round((matchQuality.bestScale || 1) * 100);
    const detail = matchQuality.weakMatch
      ? '目印（アンカー）がうまく見つかりませんでした。'
      : `検出された倍率が調整可能な範囲の端（${pct}%）に達しており、実際の倍率はそれ以上に違う可能性があります。`;
    UI.toast(
      `⚠ 「${form.name}」: OCRの位置がずれているかもしれません。${detail} 基準画像を今回と同じ解像度(DPI)で登録し直すと改善します。`,
      'warning', 15000
    );
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
      checkPositionWarning(form, result.matchQuality);

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
    /* 画像のすぐ下にも読み取り結果を出し、入力欄まで視線を動かさず見比べられるようにする */
    const rt = $('reviewReadoutText');
    rt.textContent = f.error ? '読取エラー' : (f.text || '(空欄)');
    rt.classList.toggle('is-empty', !!f.error || !f.text);
    $('reviewReadoutConf').textContent = f.error ? '' : `${f.confidence}%`;
    $('reviewReadoutConf').className = 'conf-badge' + (f.error ? '' : ` ${UI.confClass(f.confidence)}`);
    /* 文字制約に一致しない（補正でも直せなかった）場合の注意表示。
       信頼度は高いまま出ることがある（誤読自体は明瞭に写っているケース）ため、
       信頼度バッジとは別に必ず出す。 */
    const consWarn = !f.error && f.constraint && f.constraintValid === false && f.text;
    $('reviewConstraintWarn').classList.toggle('hidden', !consWarn);
    if (consWarn) $('reviewConstraintWarn').title = `文字制約「${f.constraint}」に一致しません（該当する誤読補正が無いため、読み取った文字のまま表示）`;
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
    /* 照合結果からの「詳細」で開いた調査モード: 新規保存はせず、修正だけ既存記録へ反映 */
    if (rv.investigate) { reviewFinishInvestigate(); return; }
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
    /* 調査モード: 修正を破棄して照合結果へ戻るだけ */
    if (rv && rv.investigate) { reviewHide(); return; }
    reviewHide();
    UI.toast('確認をキャンセルしました（未保存）。結果は画面に表示中です', 'info', 4000);
  }

  /* ── 照合結果の行 → その記録の詳細（切り出し画像・確信度）を直接開く（調査モード）──
     保存済み記録(raw)からレビュー用の result を組み立てて開く。新規保存はせず、値を
     直した場合のみ既存記録へ反映し、照合結果も再計算する。 */
  function openRecordDetail(ocrIdx) {
    const entry = S.rec && S.rec.ocr && S.rec.ocr[ocrIdx];
    if (!entry || !entry.raw) return UI.toast('この行の元記録が見つかりません', 'warning');
    const raw = entry.raw;
    /* 保存時は cropDataURL を crop（縮小JPEG）として保持しているため、レビュー用に読み替える。
       symbols/OCRへ渡した画像は保存対象外なので詳細では出ない（切り出し画像＋確信度は出る）。 */
    const fields = (raw.fields || []).map(f => ({
      name: f.name, globalName: f.globalName || f.name, text: f.text,
      confidence: f.confidence, error: f.error || null,
      constraint: f.constraint || '', constraintValid: f.constraintValid !== false,
      cropDataURL: f.crop || '', symbols: f.symbols || [],
    }));
    if (!fields.length) return UI.toast('この記録には項目がありません', 'warning');
    S.review = { form: { id: raw.formId, name: raw.formName }, result: { fields, angle: raw.angle }, idx: 0, investigate: { ocrIdx, raw } };
    $('reviewBatchBar').classList.add('hidden');
    const ctx = $('reviewPageCtx'); ctx.classList.remove('hidden');
    ctx.textContent = `P${raw.page || 1}${raw.formName ? ' ・ ' + raw.formName : ''}`;
    $('reviewModal').classList.remove('hidden');
    reviewRender();
    setTimeout(() => { $('reviewValue').focus(); $('reviewValue').select(); }, 60);
  }
  /* 調査モードの終了: レビューで直した値を既存記録・照合結果へ反映してから閉じる */
  function reviewFinishInvestigate() {
    const rv = S.review, inv = rv && rv.investigate; if (!inv) return;
    const entry = S.rec && S.rec.ocr && S.rec.ocr[inv.ocrIdx];
    reviewHide();
    if (!entry) return;
    let changed = false;
    rv.result.fields.forEach(f => {
      const key = f.globalName || f.name;
      if ((entry.values[key] ?? '') === f.text) return;
      entry.values[key] = f.text;
      recPersistOcrValueFix(inv.ocrIdx, key, f.text);   // 既存OCR記録(raw)＋DBへ反映
      changed = true;
    });
    if (changed && S.rec.runParams && S.rec.result) {
      S.rec.result[inv.ocrIdx] = recComputeRow(entry, inv.ocrIdx, S.rec.runParams);
      renderRecResult(S.rec.result, recSummarize(S.rec.result));
      UI.toast('詳細で修正した値を照合結果へ反映しました', 'success', 2200);
    }
  }
  /* Shift+Enter: 表示中のページ（あれば）を確定し、以降の残りページはOCR結果をそのまま
     信頼して自動確定し続け、バッチ完了後に照合画面へ自動で進む。
     認識中（busy）で reviewValue が disabled の間は自身の keydown が拾えないため、
     document 側のグローバルハンドラからも同じ関数を呼べるようにしてある。 */
  function reviewTrustRestAndReconcile() {
    if (!S.batchReviewActive || S.reviewTrustRest) return;
    S.reviewTrustRest = true;
    S.reviewGoToReconcileAfterBatch = true;
    UI.toast('残りはOCR結果を信頼して自動確定します。完了後に照合へ進みます', 'info', 3500);
    const rv = S.review;
    if (rv && rv.batch) {
      reviewSaveEdit();
      const done = rv.batch.resolve;
      S.review = null;
      done('done');
    }
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

  /* ── プリセット（OCR/罫線除去設定の保存・呼び出し） ──
     照合設定のプリセット（kind:'reconcile'）とストアを共有するため除外して読み込む。
     kind未設定の既存プリセット（旧データ）はOCR側として扱う。 */
  async function loadPresets() {
    let presets = [];
    try { presets = await FormDB.getAllPresets(); } catch (_) {}
    presets = presets.filter(p => p.kind !== 'reconcile');
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
    const preset = { id: uid(), name: (name || '無題').trim(), kind: 'ocr', ...currentDbgPreset(), createdAt: Date.now() };
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
      name: f.name, globalName: f.globalName || f.name, text: f.text, confidence: f.confidence, error: f.error || null,
      constraint: f.constraint || '', constraintValid: f.constraintValid !== false,
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
    const t0 = performance.now();
    try {
      const { decision, scores } = await Recognizer.classify(canvas, S.forms, classifyOpts());
      const t1 = performance.now();
      const candId = decision.best && decision.best.formId;
      const useId = forcedFormId || candId;
      const form = useId ? S.forms.find(f => f.id === useId) : null;
      if (!form) { console.log(`[perf] p${page} classify=${(t1 - t0).toFixed(0)}ms（帳票不一致）`); return { page, decision: decision.decision, formName: '—', fields: [], thumb }; }
      /* 表示用の判定ラベル: 手動指定=指定どおり採用 / 自動=本来の判定を踏襲 */
      const verdict = forcedFormId ? 'accepted' : decision.decision;
      const res = await Recognizer.runOcr(canvas, form, bestAnchorFor(form, scores), {}, {});
      const t2 = performance.now();
      console.log(`[perf] p${page} classify=${(t1 - t0).toFixed(0)}ms runOcr=${(t2 - t1).toFixed(0)}ms total=${(t2 - t0).toFixed(0)}ms fields=${res.fields.length}`);
      if (res.error) { LineRemovalProcessor.cleanupMats(res.previewMats); return { page, decision: 'error', formName: form.name, error: res.error, thumb }; }
      checkPositionWarning(form, res.matchQuality);
      /* 一覧サムネイルは「罫線除去済み全体＋OCR領域枠」の俯瞰にする（cleanupMats後も
         resultCanvasは有効）。枠がどこに落ちたかが一目で分かり、位置ずれ/誤判定に気づける。 */
      const overThumb = res.resultCanvas ? overlayThumbURL(res.resultCanvas, res.transform, form.ocrRegions, 120) : thumb;
      LineRemovalProcessor.cleanupMats(res.previewMats);
      const manual = forcedFormId ? true : !(candId === form.id);
      const avg = res.fields.length ? Math.round(res.fields.reduce((s, f) => s + (f.confidence || 0), 0) / res.fields.length) : 0;
      return {
        page, decision: verdict, formName: form.name, formId: form.id, forced: !!forcedFormId,
        avgConf: avg, fields: res.fields, thumb: overThumb,
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

  /* 経過時間を「30秒」「2分」のような読みやすい形式にする */
  function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60), rs = s % 60;
    return `${m}分${rs ? rs + '秒' : ''}`;
  }

  /* 指定範囲のページを順に一括OCR（pageSource = { pages:[n…], total, getPage(n), done() }）。
     大量ページでも 1枚ずつ描画→OCR→破棄するためメモリは一定。中止可能。 */
  async function runBatchPdf(src, opts) {
    if (!S.cvReady) { src.done && src.done(); return UI.toast('OpenCV.js 読み込み中です', 'warning'); }
    if (!S.forms.length) { src.done && src.done(); return UI.toast('先に帳票を登録してください', 'warning'); }
    const posWarnBefore = { ...S.posWarnCounts };   // このバッチ中に増えた件数だけをサマリで報告するため
    const resuming = !!(opts && opts.resuming);
    const priorResults = resuming ? (S.batchResults || []) : [];
    if (!resuming) { releasePageNav(); S.batchResume = null; }   // 新規アップロード時は前回の「続きから」を無効化（PDFハンドルが破棄されるため）
    const pages = src.pages || [];
    const total = src.total || pages.length;
    const review = !!src.review;                 // OCR中に1ページずつカルーセルで確認するか
    S.batchCancel = false;
    S.batchReviewActive = review;
    S.reviewTrustRest = false;                   // Shift+Enterで「残りは信頼して照合へ」が押されたか
    S.reviewGoToReconcileAfterBatch = false;
    const results = [];
    let cancelled = false;
    if (review) reviewBatchOpen(total); else UI.openBatchModal(total, resuming);

    /* 1ページ分のラスタライズ＋OCRを開始し、完了フラグ付きで返す（先読み用に await しない）。
       確認中に次ページを裏でOCRしておくことで、確定→次ページの待ち時間をなくす。 */
    const ocrAt = i => {
      if (i < 0 || i >= pages.length) return null;
      const p = pages[i];
      const forcedFormId = src.formFor ? src.formFor(p) : '';
      const entry = { page: p, ready: false };
      entry.promise = (async () => {
        const t0 = performance.now();
        let canvas;
        try { canvas = await src.getPage(p); }
        catch (_) { return { page: p, decision: 'error', formName: '—', error: 'ページ描画に失敗', thumb: '' }; }
        const t1 = performance.now();
        const r = await ocrPageForBatch(canvas, p, forcedFormId);
        /* どこで時間が掛かっているか比較できるよう、ページごとの内訳をコンソールに出す
           （ラスタライズ=PDF描画、以降はocrPageForBatch内で計測してconsole出力済み）。
           hidden=true が長い区間はタブがバックグラウンドだった可能性が高い。 */
        console.log(`[perf] p${p} rasterize=${(t1 - t0).toFixed(0)}ms hidden=${document.hidden}`);
        return r;
      })();
      entry.promise.then(() => { entry.ready = true; }, () => { entry.ready = true; });
      return entry;
    };

    const batchStartTime = Date.now();
    /* idx件処理済み時点での「残り推定時間」の文字列（実測が無い最初の1件目は算出不可） */
    const etaText = idx => idx < 1 ? '' : `（残り約${formatDuration((Date.now() - batchStartTime) / idx * (total - idx))}）`;
    /* タブを離れて放置した場合にChromeのバックグラウンドタイマー間引きが起きていないか
       ログで裏付けられるよう、一括処理中だけ可視状態の変化を記録する。 */
    const onVisChange = () => console.log(`[perf] visibilitychange hidden=${document.hidden} at ${Date.now() - batchStartTime}ms`);
    document.addEventListener('visibilitychange', onVisChange);

    let cur = ocrAt(0);                          // 先頭ページのOCRを先行開始
    try {
      for (let idx = 0; idx < pages.length; idx++) {
        if (!cur || S.batchCancel) { if (S.batchCancel) cancelled = true; break; }
        const p = pages[idx], pct = idx / Math.max(1, total);
        if (!cur.ready) {                        // 先読みが間に合っていない時だけ「認識中」を出す
          const msg = `ページ ${p}（${idx + 1}/${total}）を認識中…${etaText(idx)}`;
          if (review) { reviewBatchBusy(true); reviewBatchProgress(msg, pct); }
          else UI.updateBatchProgress(msg, pct);
          /* 進捗描画・中止受付の隙間は、直後の await cur.promise（未解決＝必ず一度サスペンドする）
             が既に与えてくれるため、ここで独自に setTimeout は挟まない。
             タブがバックグラウンドで非表示になるとChromeのタイマー間引き（Intensive
             Throttling）でsetTimeoutが最大1分/回まで遅延することがあり、一括処理を
             放置した際に毎ページこの遅延を踏んで極端に遅くなる原因になり得るため。 */
        }
        const r = await cur.promise;
        const nextEntry = ocrAt(idx + 1);        // ★先読み: 確認している間に次ページを裏でOCR
        /* review: OCR結果を1ページずつ写真と見比べ→修正→確認してから保存。
           「残りは信頼して照合へ」(Shift+Enter)が押された後は、このスキップ判定により
           以降のページはOCR結果をそのまま採用し、確認カルーセルは出さない。 */
        if (review && !S.reviewTrustRest && r._save && r.fields && r.fields.length) {
          const action = await reviewBatchPage(r, idx, total);
          if (action === 'stop') { cancelled = true; break; }   // 中止: このページは保存しない
        }
        await persistBatchRecord(r);
        results.push(r);
        cur = nextEntry;
      }
    } finally {
      document.removeEventListener('visibilitychange', onVisChange);
      /* 詳細ペインでのページ送り用に PDF を保持するため、ここでは破棄しない */
    }
    if (review) reviewBatchClose();              // 確認カルーセルを閉じてからサマリを出す（重なり防止）
    S.batchReviewActive = false;
    const combined = priorResults.concat(results);   // 「続きから実行」の場合は前回分と合算
    S.batchResults = combined;
    /* 中止していて未処理ページが残っていれば、同じPDFハンドルのまま「続きから実行」
       できるよう保持する（再アップロード不要）。formFor/review/dpi は元のまま引き継ぐ。 */
    const remainingPages = cancelled ? pages.slice(results.length) : [];
    S.batchResume = remainingPages.length
      ? { pages: remainingPages, total: remainingPages.length, getPage: src.getPage, done: src.done, formFor: src.formFor, review: src.review, fileName: src.fileName }
      : null;
    /* 処理済みページを詳細ペインで1枚ずつ確認できるよう、PDFソースを保持
       （次の一括/新規読み込み時に releasePageNav で破棄）。「続きから」用に残す場合も破棄しない。 */
    if (src.getPage && combined.length) {
      S.pageNav = { pages: combined.map(r => r.page), idx: 0, started: false, getPage: src.getPage, done: src.done, fileName: src.fileName };
      updatePageNavUI();                       // 詳細ペインにページ送りバーを表示（モーダルを閉じても使える）
    }
    if (!S.pageNav && !S.batchResume && src.done) { try { src.done(); } catch (_) {} }
    if (review) UI.openBatchModal(total, resuming);   // 確認後にサマリ（CSV出力など）を表示
    UI.updateBatchProgress('完了', 1);
    UI.renderBatchResults(combined, { hasNav: !!S.pageNav, canResume: !!S.batchResume, resumeCount: remainingPages.length });
    refreshHistory();
    const ok = combined.filter(r => r.decision === 'accepted').length;
    const doneCount = combined.length, wholeTotal = priorResults.length + total;
    UI.toast(`一括OCR${cancelled ? '中止' : '完了'} — ${doneCount}/${wholeTotal}ページ処理・${ok}件採用、履歴に保存`, cancelled ? 'warning' : 'success', 4500);
    /* 位置ズレ警告は帳票ごとに初回のみ目立つ通知にしているため、バッチ完了時に
       このバッチ内で増えた件数をまとめて知らせる（アラーム疲れの回避と、
       規模の把握を両立させる）。 */
    const posWarnLines = Object.keys(S.posWarnCounts)
      .map(fid => ({ form: S.forms.find(f => f.id === fid), delta: S.posWarnCounts[fid] - (posWarnBefore[fid] || 0) }))
      .filter(e => e.form && e.delta > 0);
    if (posWarnLines.length) {
      const text = posWarnLines.map(e => `「${e.form.name}」${e.delta}件`).join('、');
      UI.toast(`⚠ 位置ズレの可能性があるページ: ${text}。基準画像の解像度を確認してください`, 'warning', 12000);
    }
    /* Shift+Enterで「残りは信頼して照合へ」が押されていたら、サマリを出さずそのまま照合へ */
    if (S.reviewGoToReconcileAfterBatch) {
      S.reviewGoToReconcileAfterBatch = false;
      UI.closeBatchModal();
      openReconcile();
    }
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
      $('reviewReadoutText').textContent = ''; $('reviewReadoutText').classList.remove('is-empty');
      $('reviewReadoutConf').textContent = ''; $('reviewReadoutConf').className = 'conf-badge';
      $('reviewConstraintWarn').classList.add('hidden');
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

  /* ── 全データのバックアップ（他のPC/ブラウザへ環境ごと移行）────
     帳票のみを対象にした exportForms/importFormsFromFile（同僚との個別共有向け・
     IDは再採番して安全にマージ）とは別に、このツールで設定・保存できるものを
     全て1つのJSONへ書き出す。目的は「他のPCで同じ状態を再現する」ことなので、
     IDは再採番せずそのまま復元する（results.formId 等の参照関係を保つため。
     put(upsert)なので同一IDの再読み込みは上書きになり、再インポートしても
     重複は増えない）。 */
  const PDF_DPI_KEY = 'ocrtool_pdf_dpi';
  async function exportAllData() {
    let forms = [], presets = [], results = [], reconciles = [];
    try { forms = await FormDB.getAllForms(); } catch (_) {}
    try { presets = await FormDB.getAllPresets(); } catch (_) {}
    try { results = await FormDB.getAllResults(0); } catch (_) {}       // limit=0 → 上限なし全件
    try { reconciles = await FormDB.getAllReconciles(0); } catch (_) {} // limit=0 → 上限なし全件
    let pdfDpi = null;
    try { const v = localStorage.getItem(PDF_DPI_KEY); pdfDpi = v ? parseInt(v, 10) : null; } catch (_) {}
    const data = {
      app: 'chouhyou-ocr', kind: 'full-backup', version: 1, exportedAt: new Date().toISOString(),
      matchSettings: S.settings,
      forms, presets, results, reconciles,
      pdfDpi,
      reconcileLastSettings: S.recLastSettings || null,
    };
    downloadJson(data, `ocrtool_backup_${Date.now()}.json`);
    UI.toast(`バックアップを書き出しました（帳票${forms.length}・プリセット${presets.length}・OCR履歴${results.length}・照合履歴${reconciles.length}件）`, 'success', 4500);
  }
  async function importAllDataFromFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { return UI.toast('JSONを解析できませんでした: ' + (e.message || e), 'error', 6000); }
    if (!data || data.kind !== 'full-backup') {
      return UI.toast('全データのバックアップ形式ではありません（帳票のみのJSONは帳票ライブラリの「読込」から取り込めます）', 'warning', 6500);
    }
    const c = { forms: (data.forms || []).length, presets: (data.presets || []).length, results: (data.results || []).length, reconciles: (data.reconciles || []).length };
    if (!confirm(`バックアップを読み込みます（帳票${c.forms}・プリセット${c.presets}・OCR履歴${c.results}・照合履歴${c.reconciles}件、設定類も含む）。\n同じIDのデータは上書きされます。よろしいですか？`)) return;
    try {
      for (const f of (data.forms || []))       if (f && f.id) await FormDB.putForm(f);
      for (const p of (data.presets || []))     if (p && p.id) await FormDB.putPreset(p);
      for (const r of (data.results || []))     if (r && r.id) await FormDB.putResult(r);
      for (const r of (data.reconciles || []))  if (r && r.id) await FormDB.putReconcile(r);
      if (data.matchSettings) { S.settings = { ...defaultSettings(), ...data.matchSettings }; persistSettings(); applySettingsToUI(); }
      if (data.pdfDpi) { try { localStorage.setItem(PDF_DPI_KEY, String(data.pdfDpi)); } catch (_) {} }
      if (data.reconcileLastSettings) {
        try { localStorage.setItem(REC_LAST_KEY, JSON.stringify(data.reconcileLastSettings)); } catch (_) {}
        S.recLastSettings = data.reconcileLastSettings;
      }
      await Promise.all([loadForms(), loadPresets(), loadRecPresets(), refreshHistory()]);
      UI.toast('バックアップを読み込みました。他のPCと同じ状態を再現しました', 'success', 4000);
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
  /* 区切り文字の自動判定は1行目だけでなく複数行を見て多数決で決める。
     実ファイルはタイトル等で1行目に区切り文字が無いことがあり、1行目だけで判定すると
     ファイル全体が誤って1列扱いになってしまうため。判定用のサンプリングは簡易な行分割で
     十分（多少ずれても多数決の結果への影響は軽微）。 */
  function recDetectDelim(text) {
    const sample = text.split('\n').filter(l => l.trim().length).slice(0, 30);
    const score = ch => sample.filter(l => l.includes(ch)).length;
    const candidates = [['tab', '\t'], ['comma', ','], ['semicolon', ';']];
    let best = null, bestScore = 0;
    candidates.forEach(([name, ch]) => { const s = score(ch); if (s > bestScore) { bestScore = s; best = name; } });
    return best || 'space';
  }
  /* テキスト全体を1回で走査し、行→セルへ分解する（引用符はRFC4180に近い扱い）。
     「まず改行で行に割ってから列分割する」実装だと、Excel等でセル内に改行を含む値が
     "…\n…" のように引用符で囲まれている場合、その改行で本来1行のレコードが2行に分裂し、
     閉じ損ねた引用符が次の行のカンマ等まで1セルに巻き込んでしまう
     （見出しが1列に潰れて見える不具合の原因だった）。改行の意味（行区切りか、引用符内の
     値の一部か）は列区切り文字が分かっていないと判断できないため、行分割と列分割を同時に
     1パスで行う。引用符はフィールドの先頭にある時だけ「引用開始」として扱う（フィールド
     途中の"はただの文字）。'space' は簡易のため引用符を考慮しない従来通りの動作。 */
  function recParseRows(text, delimSel) {
    const norm = text.replace(/\r\n?/g, '\n');
    const delim = delimSel === 'auto' ? recDetectDelim(norm) : delimSel;
    if (delim === 'space') {
      const rows = norm.split('\n').map(l => l.trim()).filter(l => l.length).map(l => l.split(/\s+/));
      return { delim, rows };
    }
    const sep = delim === 'tab' ? '\t' : delim === 'semicolon' ? ';' : ',';
    const rows = [];
    let row = [], cur = '', q = false, sawContent = false;
    const endRow = () => {
      row.push(cur.trim());
      if (sawContent) rows.push(row);           // 完全に空白だけの行は破棄（区切り文字があれば「空白の行」として残す）
      row = []; cur = ''; sawContent = false;
    };
    for (let i = 0; i < norm.length; i++) {
      const c = norm[i];
      if (q) {
        sawContent = true;
        if (c === '"') { if (norm[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"' && cur === '') {
        q = true; sawContent = true;
      } else if (c === sep) {
        sawContent = true;
        row.push(cur.trim()); cur = '';
      } else if (c === '\n') {
        endRow();
      } else {
        if (!/\s/.test(c)) sawContent = true;
        cur += c;
      }
    }
    endRow();   // 末尾に改行が無い最終行を確定
    return { delim, rows };
  }
  const _recSearchSelectSync = {};   // selId -> 表示テキストをselectの現在値に合わせて再同期する関数
  function recFill(id, opts) {
    const s = $(id); s.innerHTML = '';
    opts.forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); });
    if (_recSearchSelectSync[id]) _recSearchSelectSync[id]();   // 選択肢が変わったら検索コンボボックスの表示も合わせる
  }
  /* 指定値が今の選択肢に存在すればselectへ反映する（無ければ何もせず既定のままにする）。
     前回設定の復元・プリセット適用の両方から使う。 */
  function recSetSelectValue(id, value) {
    if (value === undefined || value === null) return false;
    const sel = $(id); if (!sel) return false;
    if (!Array.from(sel.options).some(o => o.value === value)) return false;
    sel.value = value;
    if (_recSearchSelectSync[id]) _recSearchSelectSync[id]();
    return true;
  }
  /* 既存の<select>に「入力して候補を絞り込み選択」できるコンボボックスUIを重ねる。
     値の出所は元のselectのまま（既存のrecFill/.value読み取り/changeイベントは一切変えずに使える）。
     選択肢が多い/名前を覚えていない場合でも、タイプして絞り込めるようにする。 */
  function makeSearchableSelect(selId) {
    const sel = $(selId); if (!sel || sel.dataset.searchable) return;
    sel.dataset.searchable = '1';
    const wrap = document.createElement('div'); wrap.className = 'rec-search-select';
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'pselect rec-search-input'; input.autocomplete = 'off'; input.spellcheck = false;
    const list = document.createElement('div'); list.className = 'rec-search-list hidden';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(input); wrap.appendChild(list); wrap.appendChild(sel);
    sel.classList.add('rec-native-select-hidden');   // 見た目は隠すが値の出所として残す

    const optsOf = () => Array.from(sel.options).map(o => o.value);
    function renderList(filter) {
      const f = (filter || '').trim().toLowerCase();
      const items = optsOf().filter(o => !f || o.toLowerCase().includes(f));
      list.innerHTML = items.length
        ? items.map(o => `<div class="rec-search-item${o === sel.value ? ' is-selected' : ''}" data-v="${recHtml(o)}">${recHtml(o) || '(空欄)'}</div>`).join('')
        : '<div class="rec-search-empty">該当なし</div>';
      list.classList.remove('hidden');
    }
    function pick(v) {
      sel.value = v; input.value = v;
      list.classList.add('hidden');
      sel.dispatchEvent(new Event('change', { bubbles: true }));   // 既存のchangeリスナーを発火させる
    }
    function resync() { input.value = sel.value; }
    input.addEventListener('focus', () => renderList(''));
    input.addEventListener('input', () => renderList(input.value));
    list.addEventListener('mousedown', e => {   // blurより先にmousedownで拾う
      const item = e.target.closest('.rec-search-item'); if (!item) return;
      e.preventDefault(); pick(item.dataset.v);
    });
    input.addEventListener('blur', () => { setTimeout(() => { list.classList.add('hidden'); resync(); }, 120); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { list.classList.add('hidden'); input.blur(); }
      else if (e.key === 'Enter') { e.preventDefault(); const first = list.querySelector('.rec-search-item'); if (first) pick(first.dataset.v); }
    });
    resync();
    _recSearchSelectSync[selId] = resync;
  }
  /* 履歴が複数帳票にまたがっていると、OCR側の項目名が帳票をまたいで和集合になり
     （例: 帳票Aの2項目＋帳票Bの2項目＝4項目）「2つのはずが4つ出る」ように見える。
     対象の帳票を1つに絞り込めるようにし、既定は最新の結果が属する帳票にする。 */
  function recFormList(rows) {
    const seen = new Map();
    rows.forEach(r => { const id = r.formId || ''; if (!seen.has(id)) seen.set(id, { id, name: r.formName || '(不明な帳票)', count: 0 }); seen.get(id).count++; });
    return [...seen.values()];
  }
  function recRebuildOcrSide(formId) {
    const rows = formId ? S.rec.allRows.filter(r => (r.formId || '') === formId) : S.rec.allRows;
    const cols = [];
    /* 複数帳票をまたいだ照合キーの統一のため、帳票固有の項目名(name)ではなく
       帳票編集で設定できる共通名(globalName)を列のキーにする
       （共通名未設定ならnameをそのまま使うので、単一帳票では従来どおりの挙動）。 */
    const keyOf = f => f.globalName || f.name;
    rows.forEach(r => (r.fields || []).forEach(f => { const key = keyOf(f); if (key && !cols.includes(key)) cols.push(key); }));
    S.rec.formId = formId;
    S.rec.ocr = rows.map(r => {
      const values = {}, crops = {};
      (r.fields || []).forEach(f => { const key = keyOf(f); if (!key) return; values[key] = f.text || ''; if (f.crop) crops[key] = f.crop; });
      return { page: r.page || 1, formName: r.formName || '', values, crops, raw: r };
    });
    S.rec.ocrCols = cols;
    const ocrOpts = ['ページ', '帳票', ...cols];
    recFill('recOcrKey', ocrOpts);
    recFill('recOcrVal', ['(なし)', ...ocrOpts]);
    /* 前回使ったキー設定を、同じ名前の項目が今回もあれば自動で復元する */
    if (S.recLastSettings) {
      recSetSelectValue('recOcrKey', S.recLastSettings.ocrKey);
      recSetSelectValue('recOcrVal', S.recLastSettings.ocrVal);
    }
    $('recResult').innerHTML = ''; $('recSummary').classList.add('hidden'); $('recExport').disabled = true;
    updateRecOcrSamples();
  }
  /* OCR側フィールドが実際に何を指すか分かるよう、選んだ項目のサンプル切り出し画像を出す
     （履歴の中で最初に見つかった、その項目名を持つ切り出し画像を代表として使う）。 */
  function recOcrSampleCrop(name) {
    if (!S.rec || !S.rec.ocr || !name || name === 'ページ' || name === '帳票' || name === '(なし)') return '';
    const rec = S.rec.ocr.find(r => r.crops && r.crops[name]);
    return rec ? rec.crops[name] : '';
  }
  function updateRecOcrSamples() {
    [['recOcrKey', 'recOcrKeySample'], ['recOcrVal', 'recOcrValSample']].forEach(([selId, boxId]) => {
      const box = $(boxId); if (!box) return;
      const crop = recOcrSampleCrop($(selId).value);
      box.innerHTML = crop ? `<img src="${crop}" alt="サンプル" class="rec-ocr-sample-img">` : '<span class="rec-ocr-sample-empty">(この項目のサンプル画像はありません)</span>';
    });
  }
  async function openReconcile() {
    let rows = [];
    try { rows = await FormDB.getAllResults(100000); } catch (_) {}
    if (!rows.length) return UI.toast('照合する認識結果がありません（先にOCRを実行）', 'warning');
    const forms = recFormList(rows);
    S.rec = { allRows: rows, ext: null, result: null };
    const row = $('recFormRow'), sel = $('recFormFilter');
    if (forms.length > 1) {
      row.classList.remove('hidden');
      sel.innerHTML = '';
      forms.forEach(f => { const o = document.createElement('option'); o.value = f.id; o.textContent = `${f.name}（${f.count}件）`; sel.appendChild(o); });
      const allOpt = document.createElement('option'); allOpt.value = ''; allOpt.textContent = `すべての帳票（${rows.length}件・共通名(任意)を設定した項目はまとめて照合できます）`;
      sel.appendChild(allOpt);
      sel.value = forms[0].id;   // 既定は最新の結果が属する帳票（rowsは新しい順）
    } else {
      row.classList.add('hidden');
    }
    recRebuildOcrSide(forms.length > 1 ? forms[0].id : '');
    recFill('recExtKey', []); recFill('recExtVal', ['(なし)']);
    if (S.recLastSettings) {
      $('recNumeric').checked = !!S.recLastSettings.numeric;
      $('recAutoBlank').checked = !!S.recLastSettings.autoRemoveBlankRows;
    }
    $('recPreview').innerHTML = ''; $('recResult').innerHTML = ''; $('recSummary').classList.add('hidden'); $('recExport').disabled = true;
    $('recPreviewInfo').textContent = ''; $('recPreviewExpand').disabled = true;
    S.recResultFilter = 'all'; S.recRender = null;
    $('reconcileResultModal').classList.add('hidden');
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
    const delimSel = $('recDelim').value;
    const { delim, rows } = recParseRows(text, delimSel);
    if (!rows.length) return UI.toast('データを解析できませんでした', 'warning');
    const hasHeader = $('recHasHeader').checked;
    /* 生のテキストを保持し、区切りパターンは「テーブルで確認・整形」内でいつでも変えて
       見比べられるようにする。
       見出し行の位置は、前回「テーブルで確認・整形」の適用時に記憶した行番号があれば
       それを復元する（同じ形式のファイルなら「見出しが4行目から」等を毎回選び直さずに
       済む）。今回のデータの方が行数が少ない等で範囲外なら無視し、従来通り「先頭の
       空白でない行」を暫定の見出しにする（「テーブルで確認・整形」でいつでも選び直せる）。 */
    const remembered = S.recLastSettings;
    const rememberedHeaderIdx = (remembered && Number.isInteger(remembered.headerRowIndex) && remembered.headerRowIndex < rows.length)
      ? remembered.headerRowIndex : null;
    const headerIdx = rememberedHeaderIdx != null ? rememberedHeaderIdx : (hasHeader ? recFindFirstNonBlank(rows, 0) : -1);
    S.rec.raw = { text, delimSel, delim, rows, excluded: new Set(), headerIdx };
    /* 空白行の自動除外も同様に前回の指定を復元する（見出し行自体は対象外）。 */
    if (remembered && remembered.autoRemoveBlankRows) {
      rows.forEach((r, i) => { if (i !== headerIdx && recRowBlank(r)) S.rec.raw.excluded.add(i); });
    }
    applyRecShape();
    const n = S.rec.ext.rows.length;
    const restoredNote = rememberedHeaderIdx != null ? '（前回の見出し行・空白行の設定を復元）' : '';
    UI.toast(`比較データ ${n} 行 × ${S.rec.ext.header.length} 列を読み込みました${restoredNote}`, 'success', 2500);
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
    /* 前回使ったキー設定を、同じ名前の列が今回の比較データにもあれば自動で復元する */
    if (S.recLastSettings) {
      recSetSelectValue('recExtKey', S.recLastSettings.extKey);
      recSetSelectValue('recExtVal', S.recLastSettings.extVal);
    }
    renderRecPreview(header, data);
    $('recPreviewInfo').textContent = `${data.length} 行 × ${header.length} 列を読み込みました`;
    $('recPreviewExpand').disabled = false;
  }
  /* 外部側キー/値は、設定カードのドロップダウンだけでなく、この列見出しの
     🔑/＝ボタンをクリックしても選べるようにする（テーブルを見ながら直感的に選べるように）。 */
  function renderRecPreview(header, data) {
    const keyName = $('recExtKey').value, valName = $('recExtVal').value;
    const head = '<tr>' + header.map(h => {
      const hh = recHtml(h);
      const cls = [h === keyName ? 'rec-th-iskey' : '', h === valName ? 'rec-th-isval' : ''].filter(Boolean).join(' ');
      return `<th class="${cls}"><span class="rec-th-name">${hh}</span>`
        + `<button type="button" class="rec-th-pick rec-th-pick--key" data-col="${hh}" title="外部側キーに設定"><i class="fas fa-key"></i></button>`
        + `<button type="button" class="rec-th-pick rec-th-pick--val" data-col="${hh}" title="外部側値に設定"><i class="fas fa-equals"></i></button>`
        + '</th>';
    }).join('') + '</tr>';
    const body = data.slice(0, REC_PREVIEW_ROWS).map(r => '<tr>' + header.map((_, i) => `<td>${recHtml(r[i] ?? '')}</td>`).join('') + '</tr>').join('');
    $('recPreview').innerHTML = `<div class="rec-tbl-wrap"><table class="rec-tbl">${head}${body}</table></div>`
      + (data.length > REC_PREVIEW_ROWS ? `<div class="rec-more">… 他 ${data.length - REC_PREVIEW_ROWS} 行（「テーブルで確認・整形」で全件を表示できます／列見出しの🔑＝でキー・値を選べます）</div>` : '');
  }
  function recPreviewPickClick(e) {
    const btn = e.target.closest('.rec-th-pick'); if (!btn || !S.rec || !S.rec.ext) return;
    const col = btn.dataset.col;
    const targetId = btn.classList.contains('rec-th-pick--key') ? 'recExtKey' : 'recExtVal';
    $(targetId).value = col;
    if (_recSearchSelectSync[targetId]) _recSearchSelectSync[targetId]();   // 検索コンボボックスの表示テキストも合わせる
    renderRecPreview(S.rec.ext.header, S.rec.ext.rows);   // 選択状態(ハイライト)を反映
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
    const { delim, rows } = recParseRows(raw.text, delimSel);
    /* 引用符付きセル内の改行の扱いにより、ごく稀に区切りを変えると行数自体が変わることが
       ある。その場合は行削除/見出し選択のindexが無意味になるためリセットする。 */
    if (rows.length !== raw.rows.length) { raw.excluded = new Set(); raw.headerIdx = -1; }
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
    /* 見出し行の位置・空白行の自動除外を、この場で（照合の実行を待たず）記憶する。
       次に比較データを読み込んだ時、recParse がこれを見て自動で復元する。 */
    persistRecLastSettings({ ...(S.recLastSettings || {}), ...currentRecSettings() });
    closeRecTableModal();
    UI.toast(`${S.rec.ext.rows.length} 行 × ${S.rec.ext.header.length} 列を適用しました（見出し行・空白行の設定は次回も自動で復元されます）`, 'success', 3000);
  }
  function closeRecTableModal() { $('recTableModal').classList.add('hidden'); }
  function recReadFile(file) {
    const r = new FileReader();
    r.onload = () => { $('recPaste').value = recDecode(r.result, $('recEnc').value); recParse(); };
    r.onerror = () => UI.toast('ファイルの読み込みに失敗しました', 'error');
    r.readAsArrayBuffer(file);
  }
  const recNorm = s => recEsc(s).trim().replace(/\s+/g, '');
  const recNumNorm = s => { const n = parseFloat(recEsc(s).replace(/[,\s¥￥$]/g, '')); return isFinite(n) ? n : null; };
  const recGetOcr = (r, col) => col === 'ページ' ? r.page : col === '帳票' ? r.formName : (r.values[col] ?? '');
  /* OCR結果1件分の判定を計算する（recRunでの一括計算・照合結果テーブルでの
     インライン修正後の再計算の両方から使う）。 */
  function recComputeRow(r, ocrIdx, params) {
    const { ocrKey, extMap, ocrValCol, extValIdx, numeric } = params;
    const compareVals = ocrValCol !== '(なし)' && extValIdx >= 0;
    const keyVal = recGetOcr(r, ocrKey);
    const ext = extMap.get(recNorm(keyVal));
    let verdict, extShown = '';
    if (!ext) verdict = '該当なし';
    else if (compareVals) {
      const ocrShown = recGetOcr(r, ocrValCol); extShown = ext[extValIdx] ?? '';
      const eq = numeric ? (() => { const a = recNumNorm(ocrShown), b = recNumNorm(extShown); return a != null && b != null && a === b; })()
                         : recNorm(ocrShown) === recNorm(extShown);
      verdict = eq ? '〇' : '×';
    } else { verdict = '〇'; extShown = ext.join(' '); }
    /* この記録が持つOCR項目すべての値+切り出し画像を並べる（キー/比較値だけでなく
       その帳票のOCR項目全部を出し、見比べやすくする）。 */
    const ocrFields = S.rec.ocrCols.map(name => ({ name, value: r.values[name] ?? '', crop: (r.crops && r.crops[name]) || '' }));
    return { ocrIdx, page: r.page, ocrFields, ext: extShown, verdict, compareVals, ocrKeyName: ocrKey, ocrValName: compareVals ? ocrValCol : '' };
  }
  function recSummarize(out) {
    return {
      nMatch: out.filter(r => r.verdict === '〇').length,
      nNo: out.filter(r => r.verdict === '×').length,
      nMiss: out.filter(r => r.verdict === '該当なし').length,
      compareVals: out.length ? out[0].compareVals : false,
    };
  }
  /* 照合の設定（②のキー/値の対応づけ）を今のUIから読み出す。プリセット保存・
     前回設定の記憶・照合結果の履歴保存の3箇所で共通に使う。 */
  function currentRecSettings() {
    return {
      ocrKey: $('recOcrKey').value, extKey: $('recExtKey').value,
      ocrVal: $('recOcrVal').value, extVal: $('recExtVal').value,
      numeric: $('recNumeric').checked,
      /* 見出し行の位置・空白行の自動除外も、キー/値の対応づけと同じ「前回設定を
         次回も自動で復元する」対象にする（毎回「テーブルで確認・整形」で選び
         直す手間を省く）。headerRowIndexはS.rec.raw確定後のみ意味を持つ。 */
      headerRowIndex: (S.rec && S.rec.raw && S.rec.raw.headerIdx >= 0) ? S.rec.raw.headerIdx : null,
      autoRemoveBlankRows: !!($('recAutoBlank') && $('recAutoBlank').checked),
    };
  }
  function recRun() {
    if (!S.rec || !S.rec.ext) return UI.toast('先に比較データを読み込んでください', 'warning');
    const ocrKey = $('recOcrKey').value;
    const extKeyIdx = S.rec.ext.header.indexOf($('recExtKey').value);
    const ocrValCol = $('recOcrVal').value, extValName = $('recExtVal').value;
    const extValIdx = S.rec.ext.header.indexOf(extValName);
    const numeric = $('recNumeric').checked;
    const extMap = new Map();
    S.rec.ext.rows.forEach(row => { const k = recNorm(row[extKeyIdx]); if (k && !extMap.has(k)) extMap.set(k, row); });
    S.rec.runParams = { ocrKey, extMap, ocrValCol, extValIdx, numeric };
    const out = S.rec.ocr.map((r, i) => recComputeRow(r, i, S.rec.runParams));
    S.rec.result = out;
    const st = recSummarize(out);
    renderRecResult(out, st);
    $('recExport').disabled = false;
    recAutoSaveResult(out, st);   // 後から参照できるよう履歴に保存（バックグラウンド）
    persistRecLastSettings(currentRecSettings());   // 次回このキー設定を自動で復元する
  }
  /* 照合結果を後から参照できるよう保存する。切り出し画像も含めて自己完結させる
     （元のOCR履歴が後で編集/削除されても、保存時点の見た目のまま確認できるように）。 */
  async function recAutoSaveResult(out, st) {
    if (!out.length) return;
    const forms = S.rec.allRows ? recFormList(S.rec.allRows) : [];
    /* S.rec.formId が空なのは「すべての帳票」を選んだ場合と、帳票が1つしか無く
       フィルタ自体を出していない場合の両方があるので、後者は実際の帳票名を使う。 */
    const formEntry = forms.find(f => f.id === (S.rec.formId || '')) || (forms.length === 1 ? forms[0] : null);
    const rec = {
      id: uid(), createdAt: Date.now(),
      formId: S.rec.formId || (forms.length === 1 ? forms[0].id : ''), formName: formEntry ? formEntry.name : 'すべての帳票',
      settings: currentRecSettings(),
      summary: { total: out.length, nMatch: st.nMatch, nNo: st.nNo, nMiss: st.nMiss, compareVals: st.compareVals },
      rows: out.map(r => ({ page: r.page, ocrFields: r.ocrFields, ext: r.ext, verdict: r.verdict, compareVals: r.compareVals, ocrKeyName: r.ocrKeyName, ocrValName: r.ocrValName })),
    };
    try { await FormDB.putReconcile(rec); } catch (_) {}
  }
  /* ── 照合設定の記憶（localStorage）＋プリセット（IndexedDB） ──
     「毎回キーを選び直すのが面倒」に対応: 実行するたびに設定を記憶し、次回モーダルを
     開いた時・比較データを読み込んだ時に同名の項目があれば自動で復元する。よく使う
     組み合わせは名前を付けてプリセット保存もできる（OCR/罫線除去のプリセットと同じ
     presets ストアを共有し、kind:'reconcile' で区別）。 */
  const REC_LAST_KEY = 'ocrtool_reconcile_last';
  function loadRecLastSettings() {
    try { S.recLastSettings = JSON.parse(localStorage.getItem(REC_LAST_KEY) || 'null') || null; }
    catch (_) { S.recLastSettings = null; }
  }
  function persistRecLastSettings(s) {
    S.recLastSettings = s;
    try { localStorage.setItem(REC_LAST_KEY, JSON.stringify(s)); } catch (_) {}
  }
  async function loadRecPresets() {
    let all = [];
    try { all = await FormDB.getAllPresets(); } catch (_) {}
    S.recPresets = all.filter(p => p.kind === 'reconcile');
    const sel = $('recPresetSelect'); const cur = sel.value;
    sel.innerHTML = '<option value="">（プリセットを選択）</option>';
    S.recPresets.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }
  async function saveRecPreset() {
    const name = prompt('プリセット名を入力', `照合設定 ${new Date().toLocaleString('ja-JP')}`);
    if (name === null) return;
    const preset = { id: uid(), name: (name || '無題').trim(), kind: 'reconcile', settings: currentRecSettings(), createdAt: Date.now() };
    try { await FormDB.putPreset(preset); await loadRecPresets(); $('recPresetSelect').value = preset.id; UI.toast(`プリセット「${preset.name}」を保存しました`, 'success'); }
    catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'error'); }
  }
  function applyRecPreset() {
    const id = $('recPresetSelect').value; if (!id) return UI.toast('プリセットを選択してください', 'warning');
    const p = (S.recPresets || []).find(x => x.id === id); if (!p) return;
    const s = p.settings || {};
    recSetSelectValue('recOcrKey', s.ocrKey); recSetSelectValue('recOcrVal', s.ocrVal);
    recSetSelectValue('recExtKey', s.extKey); recSetSelectValue('recExtVal', s.extVal);
    $('recNumeric').checked = !!s.numeric;
    $('recAutoBlank').checked = !!s.autoRemoveBlankRows;
    updateRecOcrSamples();
    if (S.rec && S.rec.ext) renderRecPreview(S.rec.ext.header, S.rec.ext.rows);
    persistRecLastSettings(s);
    UI.toast(`プリセット「${p.name}」を反映しました`, 'info', 3000);
  }
  async function deleteRecPreset() {
    const id = $('recPresetSelect').value; if (!id) return UI.toast('プリセットを選択してください', 'warning');
    const p = (S.recPresets || []).find(x => x.id === id);
    if (!confirm(`プリセット「${p ? p.name : ''}」を削除しますか？`)) return;
    try { await FormDB.deletePreset(id); await loadRecPresets(); UI.toast('プリセットを削除しました', 'info'); }
    catch (e) { UI.toast('削除に失敗しました: ' + e.message, 'error'); }
  }
  /* 照合結果テーブルでOCR値を修正 → その行の判定を再計算し、元のOCR履歴レコードにも
     反映して保存する（後で見返した時・再照合した時も直った値になるように）。 */
  function recPersistOcrValueFix(ocrIdx, name, newVal) {
    const entry = S.rec.ocr[ocrIdx]; if (!entry || !entry.raw) return;
    const raw = entry.raw;
    /* nameは共通名(globalName)の場合があるため、globalName優先→帳票固有名の順で対象欄を探す */
    const f = (raw.fields || []).find(x => (x.globalName || x.name) === name);
    if (f) {
      f.text = newVal;
      if (raw.ocrValues) raw.ocrValues[f.name] = newVal;
    }
    FormDB.putResult(raw).then(refreshHistory).catch(() => {});
  }
  function recResultValueChange(e) {
    const inp = e.target.closest('.rec-ocr-edit'); if (!inp) return;
    const rowIdx = parseInt(inp.dataset.row, 10), name = inp.dataset.field;
    const entry = S.rec.ocr[rowIdx]; if (!entry) return;
    const newVal = inp.value;
    if ((entry.values[name] ?? '') === newVal) return;   // 変化なしなら何もしない
    entry.values[name] = newVal;
    recPersistOcrValueFix(rowIdx, name, newVal);
    if (!S.rec.runParams) return;
    S.rec.result[rowIdx] = recComputeRow(entry, rowIdx, S.rec.runParams);
    renderRecResult(S.rec.result, recSummarize(S.rec.result));
    UI.toast('OCR値を修正し、判定を再計算しました', 'success', 2000);
  }
  /* 照合結果テーブル: OCR項目ごとに「値・切り出し画像」を交互に並べ、その帳票の
     OCR項目すべてを見比べられるようにする。該当なし/不一致は行全体を色付けして目立たせる。
     readOnly指定時（保存済みの照合結果を後から見る場合）はOCR値を編集不可にする
     （行番号(ocrIdx)が今のS.rec.ocrと対応しないデータのため、誤って別データを書き換えないように）。 */
  function renderRecResult(out, st, opts) {
    const readOnly = !!(opts && opts.readOnly);
    /* フィルタ切替（すべて / ×・該当なしのみ）で再描画できるよう、描画コンテキストを保持 */
    S.recRender = { out, st, readOnly };
    const filter = S.recResultFilter || 'all';
    const isIssue = r => r.verdict === '×' || r.verdict === '該当なし';
    const shown = filter === 'issues' ? out.filter(isIssue) : out;

    const sum = $('recSummary'); sum.classList.remove('hidden');
    const base = st.compareVals
      ? `${out.length}件 ・ <span class="bs-ok">一致 ${st.nMatch}</span> / <span class="bs-rj">不一致 ${st.nNo}</span> / <span class="bs-er">該当なし ${st.nMiss}</span>`
      : `${out.length}件 ・ <span class="bs-ok">キー一致 ${st.nMatch}</span> / <span class="bs-er">該当なし ${st.nMiss}</span>`;
    sum.innerHTML = filter === 'issues' ? `${base} ・ <span class="rec-filter-note">×・該当なしのみ ${shown.length}件を表示</span>` : base;

    /* フィルタボタンの選択状態を同期 */
    const fa = $('recFilterAll'), fi = $('recFilterIssues');
    if (fa && fi) {
      fa.classList.toggle('btn-primary', filter === 'all'); fa.classList.toggle('btn-outline', filter !== 'all');
      fi.classList.toggle('btn-primary', filter === 'issues'); fi.classList.toggle('btn-outline', filter !== 'issues');
    }

    /* 見出し・列構成は全件基準で決める（絞り込んでも列がぶれないように） */
    const names = (out[0] && out[0].ocrFields.map(f => f.name)) || [];
    const hasAnyCrop = out.some(r => r.ocrFields.some(f => f.crop));   // 旧データ（切り出し未保存）では画像列を出さない
    const first = out[0] || {};
    const tagFor = name => name === first.ocrKeyName ? '<span class="rec-th-tag rec-th-tag--key">キー</span>'
      : (first.compareVals && name === first.ocrValName) ? '<span class="rec-th-tag rec-th-tag--val">比較</span>' : '';
    const fieldHead = names.map(name => `<th>OCR値: ${recHtml(name)} ${tagFor(name)}</th>` + (hasAnyCrop ? '<th>切り出し画像</th>' : '')).join('');
    /* 行クリックで詳細へ飛べる列（読み取り専用スナップショットは現行データと対応しないため出さない） */
    const detailHead = readOnly ? '' : '<th></th>';
    const head = `<tr><th>ページ</th>${fieldHead}${st.compareVals ? '<th>外部値</th>' : '<th>外部データ</th>'}<th>判定</th>${detailHead}</tr>`;
    const cls = v => v === '〇' ? 'rv-ok' : v === '×' ? 'rv-no' : 'rv-miss';
    const rowCls = v => v === '該当なし' ? 'rec-row-miss' : v === '×' ? 'rec-row-bad' : '';
    const body = shown.map(r => {
      /* OCR値は照合時にその場で修正できる（誤読の手直し）。修正するとその行の判定を
         再計算し、元のOCR履歴レコードにも反映して保存する。 */
      const fieldCells = r.ocrFields.map(f => (readOnly
        ? `<td>${recHtml(f.value)}</td>`
        : `<td><input type="text" class="rec-ocr-edit" data-row="${r.ocrIdx}" data-field="${recHtml(f.name)}" value="${recHtml(f.value)}" title="クリックしてOCR値を修正"></td>`)
        + (hasAnyCrop ? `<td class="rec-crop-cell">${f.crop ? `<img class="rec-crop" src="${f.crop}" alt="切り出し" loading="lazy">` : ''}</td>` : '')).join('');
      const detailCell = readOnly ? '' : `<td class="rec-detail-cell"><button type="button" class="btn btn-ghost btn-sm rec-detail-btn" data-ocr-idx="${r.ocrIdx}" title="この記録の詳細（切り出し画像・確信度）を開く"><i class="fas fa-magnifying-glass-chart"></i> 詳細</button></td>`;
      return `<tr class="${rowCls(r.verdict)}"><td>${recHtml(r.page)}</td>${fieldCells}<td>${recHtml(r.ext)}</td><td class="${cls(r.verdict)}">${r.verdict}</td>${detailCell}</tr>`;
    }).join('');
    const empty = shown.length ? '' : '<div class="rec-empty">該当なし・不一致の行はありません 🎉</div>';
    $('recResult').innerHTML = `<div class="rec-tbl-wrap rec-result-wrap"><table class="rec-tbl rec-result-tbl">${head}${body}</table></div>${empty}`;
    /* 結果は専用モーダルで開く（設定モーダルの上に重ねて表示） */
    $('reconcileResultModal').classList.remove('hidden');
  }
  /* フィルタ切替（すべて / ×・該当なしのみ） */
  function recSetResultFilter(f) {
    S.recResultFilter = f;
    const ctx = S.recRender; if (!ctx) return;
    renderRecResult(ctx.out, ctx.st, { readOnly: ctx.readOnly });
  }
  function closeReconcileResult() { $('reconcileResultModal').classList.add('hidden'); }   // 結果のみ閉じ→設定へ戻る
  function closeReconcileAll() { $('reconcileResultModal').classList.add('hidden'); closeReconcile(); }   // 結果＋設定を閉じて照合を抜ける
  function recExport() {
    const out = S.rec && S.rec.result; if (!out || !out.length) return;
    const cmp = out[0].compareVals;
    const esc = v => /[",\n]/.test(v) ? `"${recEsc(v).replace(/"/g, '""')}"` : recEsc(v);
    const names = S.rec.ocrCols;
    const head = ['ページ', ...names.map(n => `OCR値:${n}`), ...(cmp ? ['外部値'] : ['外部データ']), '判定'];
    const lines = out.map(r => [r.page, ...r.ocrFields.map(f => f.value), r.ext, r.verdict].map(esc).join(','));
    downloadCsv([head.map(esc).join(','), ...lines].join('\n'), `reconcile_${Date.now()}.csv`);
  }

  /* ── 照合結果の履歴（後から参照） ─────────────────────── */
  async function openReconcileHist() {
    let rows = [];
    try { rows = await FormDB.getAllReconciles(50); } catch (_) {}
    renderRecHistList(rows);
    $('recHistModal').classList.remove('hidden');
  }
  function closeReconcileHist() { $('recHistModal').classList.add('hidden'); }
  function renderRecHistList(rows) {
    const box = $('recHistList');
    if (!rows.length) { box.innerHTML = '<p class="hint-text">保存された照合結果はまだありません。「照合を実行」すると自動的にここに保存されます。</p>'; return; }
    box.innerHTML = rows.map(rec => {
      const st = rec.summary || {};
      const statsHtml = st.compareVals
        ? `<span class="bs-ok">一致 ${st.nMatch}</span> / <span class="bs-rj">不一致 ${st.nNo}</span> / <span class="bs-er">該当なし ${st.nMiss}</span>`
        : `<span class="bs-ok">キー一致 ${st.nMatch}</span> / <span class="bs-er">該当なし ${st.nMiss}</span>`;
      return `<div class="rec-hist-item" data-id="${rec.id}">
        <div class="rec-hist-main">
          <span class="rec-hist-date">${new Date(rec.createdAt).toLocaleString('ja-JP')}</span>
          <span class="rec-hist-form">${recHtml(rec.formName || 'すべての帳票')}</span>
          <span class="rec-hist-stats">${st.total ?? (rec.rows || []).length}件 ・ ${statsHtml}</span>
        </div>
        <div class="rec-hist-acts">
          <button type="button" class="btn btn-outline btn-sm rec-hist-view" data-id="${rec.id}"><i class="fas fa-eye"></i> 表示</button>
          <button type="button" class="btn btn-ghost btn-sm rec-hist-del" data-id="${rec.id}"><i class="fas fa-trash-can"></i></button>
        </div>
      </div>`;
    }).join('');
  }
  async function recHistListClick(e) {
    const viewBtn = e.target.closest('.rec-hist-view');
    const delBtn = e.target.closest('.rec-hist-del');
    if (viewBtn) {
      const id = viewBtn.dataset.id;
      const rows = await FormDB.getAllReconciles(50);
      const rec = rows.find(r => r.id === id); if (!rec) return;
      closeReconcileHist();
      renderRecResult(rec.rows, { nMatch: rec.summary.nMatch, nNo: rec.summary.nNo, nMiss: rec.summary.nMiss, compareVals: rec.summary.compareVals }, { readOnly: true });
      $('recExport').disabled = true;   // 保存済みスナップショットは今の照合設定と対応しないためCSV出力対象外
      UI.toast(`保存済みの照合結果（${new Date(rec.createdAt).toLocaleString('ja-JP')}）を表示しています（読み取り専用）`, 'info', 4000);
    } else if (delBtn) {
      const id = delBtn.dataset.id;
      await FormDB.deleteReconcile(id);
      openReconcileHist();
    }
  }

  /* ── Init ───────────────────────────────────────────── */
  function init() {
    initAccordions(); initRegSliders(); initRegCanvasEvents(); initDbgControls(); initRrPan();
    CharRuleEditor.init();
    PdfImport.init();
    ['recOcrKey', 'recExtKey', 'recOcrVal', 'recExtVal'].forEach(makeSearchableSelect);

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
    $('btnCheckAnchorSimilarity').addEventListener('click', checkAnchorSimilarity);
    $('regBinaryMethod').addEventListener('change', updateBinaryRows);

    /* 描画 */
    document.querySelectorAll('#drawModeSwitch .dm-btn').forEach(b => b.addEventListener('click', () => {
      if (S.repositioning) cancelReposition();   // モードを手動で切り替えたら描き直し待ちは解除する
      setDrawMode(b.dataset.dm);
    }));
    $('rectNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitPending(); } });
    $('repositionCancelBtn').addEventListener('click', cancelReposition);
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
    $('batchResume').addEventListener('click', () => {
      const r = S.batchResume; if (!r) return;
      S.batchResume = null;
      /* 同じPDFハンドルを続けて使うので、詳細ペインのページ送り(pageNav)はdone()を
         呼ばず参照だけ外す（呼ぶとハンドルごと破棄されてしまう）。 */
      S.pageNav = null;
      const bar = $('rrPageNav'); if (bar) bar.classList.add('hidden');
      runBatchPdf(r, { resuming: true });
    });
    $('btnRecogSample').addEventListener('click', () => loadRecogImage(SampleForms.sampleInputCanvas(0, 1.5)));
    $('btnRunRecognize').addEventListener('click', runRecognize);
    $('btnApplyForm').addEventListener('click', () => applyForm($('dpFormSelect').value));
    $('btnCopyAll').addEventListener('click', copyAllFields);
    $('btnClearHistory').addEventListener('click', clearHistory);
    $('btnExportHistory').addEventListener('click', exportHistoryCsv);

    /* 照合（OCR結果 × 外部データ） */
    $('btnReconcile').addEventListener('click', openReconcile);
    $('recFormFilter').addEventListener('change', e => recRebuildOcrSide(e.target.value));
    $('recOcrKey').addEventListener('change', updateRecOcrSamples);
    $('recOcrVal').addEventListener('change', updateRecOcrSamples);
    $('btnRecApplyPreset').addEventListener('click', applyRecPreset);
    $('btnRecSavePreset').addEventListener('click', saveRecPreset);
    $('btnRecDeletePreset').addEventListener('click', deleteRecPreset);
    $('recResult').addEventListener('change', recResultValueChange);
    $('recResult').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('rec-ocr-edit')) e.target.blur(); });
    $('reconcileClose').addEventListener('click', closeReconcile);
    $('reconcileCloseBtn').addEventListener('click', closeReconcile);
    $('reconcileModal').addEventListener('click', e => { if (e.target === $('reconcileModal')) closeReconcile(); });
    $('recParse').addEventListener('click', recParse);
    $('recRun').addEventListener('click', recRun);
    $('recExport').addEventListener('click', recExport);
    /* 照合結果モーダル: 絞り込み・詳細ジャンプ・開閉 */
    $('recFilterAll').addEventListener('click', () => recSetResultFilter('all'));
    $('recFilterIssues').addEventListener('click', () => recSetResultFilter('issues'));
    $('recResult').addEventListener('click', e => { const b = e.target.closest('.rec-detail-btn'); if (b) openRecordDetail(parseInt(b.dataset.ocrIdx, 10)); });
    $('recResultClose').addEventListener('click', closeReconcileResult);   // ×＝結果を閉じて設定へ戻る
    $('recResultCloseBtn').addEventListener('click', closeReconcileAll);    // 閉じる＝照合を抜ける
    $('recResultBack').addEventListener('click', closeReconcileResult);     // 設定に戻る
    $('reconcileResultModal').addEventListener('click', e => { if (e.target === $('reconcileResultModal')) closeReconcileResult(); });
    $('recHistBtn').addEventListener('click', openReconcileHist);
    $('recHistClose').addEventListener('click', closeReconcileHist);
    $('recHistCloseBtn').addEventListener('click', closeReconcileHist);
    $('recHistModal').addEventListener('click', e => { if (e.target === $('recHistModal')) closeReconcileHist(); });
    $('recHistList').addEventListener('click', recHistListClick);
    $('recFileBtn').addEventListener('click', () => $('recFileInput').click());
    $('recFileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) recReadFile(f); e.target.value = ''; });
    $('recPreviewExpand').addEventListener('click', openRecTableModal);
    $('recPreview').addEventListener('click', recPreviewPickClick);
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
    /* 貼り付けたら自動で読み込む（「読み込む」クリックを省く＝データを入れるだけで
       前回のキー設定の復元まで走る。ファイル選択/ドロップは既に自動読み込み済み）。
       pasteイベントは値が入る前に発火するため次tickで読む。実行(照合)は手動のまま。 */
    rp.addEventListener('paste', () => setTimeout(() => { if ($('recPaste').value.trim()) recParse(); }, 0));

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
      /* 認識中(busy)は reviewValue が disabled で自身の keydown を拾えないため、
         document側でも Shift+Enter の「残りは信頼して照合へ」を受け付ける。 */
      if (e.key === 'Enter' && e.shiftKey && S.batchReviewActive && !S.review) {
        e.preventDefault(); reviewTrustRestAndReconcile(); return;
      }
      if (e.key !== 'Escape') return;
      /* アンカー/OCR領域の位置描き直し待ち中はそれを優先してキャンセル */
      if (S.repositioning) { cancelReposition(); return; }
      /* 一括の確認カルーセル中は中止として扱う（ただ閉じるとOCRループが止まったままになる） */
      if (S.review && S.review.batch) { reviewCancel(); return; }
      /* PDF読み込みモーダルは×以外で閉じない（誤操作でのキャンセル・読み込み直しを防ぐ） */
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => { if (m.id !== 'pdfModal') m.classList.add('hidden'); });
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
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) { if (S.batchReviewActive) reviewTrustRestAndReconcile(); else reviewComplete(); }
        else reviewGo(1);
      }
      else if (e.key === 'ArrowUp') { e.preventDefault(); reviewGo(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); reviewGo(1); }
    });
    /* 画像直下の読み取り結果表示も、修正に合わせて追従させる */
    $('reviewValue').addEventListener('input', e => {
      const rt = $('reviewReadoutText');
      rt.textContent = e.target.value || '(空欄)';
      rt.classList.toggle('is-empty', !e.target.value);
      /* 手直しを始めた時点で警告の役目は済んでいるので隠す（直した後も
         古い警告が残って混乱するのを防ぐ。再照合はしない簡易対応） */
      $('reviewConstraintWarn').classList.add('hidden');
    });
    [['setAcceptConf', 'setValAcceptConf', 2], ['setNearExact', 'setValNearExact', 2], ['setAcceptFloor', 'setValAcceptFloor', 2], ['setMarginMin', 'setValMarginMin', 2], ['setAngleRange', 'setValAngle', 0]]
      .forEach(([sl, lb, d]) => $(sl).addEventListener('input', () => { $(lb).textContent = Number($(sl).value).toFixed(d); }));

    /* 帳票インポート/エクスポート（ボタン＋ライブラリへJSONドロップ） */
    $('btnExportForms').addEventListener('click', exportForms);
    $('btnImportForms').addEventListener('click', () => $('importFormsInput').click());
    $('importFormsInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFormsFromFile(f); e.target.value = ''; });
    setupJsonDrop('libraryPanel', importFormsFromFile);

    /* 全データのバックアップ（他のPCへの移行） */
    $('btnExportAll').addEventListener('click', exportAllData);
    $('btnImportAll').addEventListener('click', () => $('importAllInput').click());
    $('importAllInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) importAllDataFromFile(f); e.target.value = ''; });

    document.addEventListener('paste', handlePaste);

    /* 初期データ + IndexedDB 可用性チェック（file:// の Safari 等で無効な場合に通知）
       このツールの主目的はOCR実行（レイアウト登録は事前準備）なので、既定表示は②OCR実行。
       setMode('recognize') が履歴読み込み(refreshHistory)も兼ねる。 */
    setMode('recognize');
    if (!window.indexedDB) {
      UI.toast('このブラウザでは IndexedDB が無効のため帳票・履歴を保存できません（Chrome/Edge/Firefox 推奨）', 'warning', 8000);
    } else {
      FormDB.open().catch(() => UI.toast('IndexedDB を初期化できませんでした。Chrome/Edge で開くと保存できます', 'warning', 8000));
    }
    loadSettings();
    loadForms();
    loadPresets();
    loadRecPresets();
    loadRecLastSettings();
  }

  document.addEventListener('DOMContentLoaded', init);

})();
