/* ════════════════════════════════════════════════════════
   pdf_import.js  PDF 読み込み（pdf.js ラッパー＋取り込みモーダル）
   Responsibility: PDF を選択/ドロップした際に
     ・ページを選び ・解像度(DPI)を選び ・プレビューを見て
     1ページをキャンバスへラスタライズして返すだけ。
   認知負荷を下げる設計: DPIは数値＋平易な説明（速い/推奨/高精度）、
   出力サイズを即時表示、複数ページのみページ送りを出す、前回DPIを記憶。
   画像/PDF どちらも同じ「読み込み口」から扱えるよう open(file,onCanvas) を提供。
   ════════════════════════════════════════════════════════ */
'use strict';

const PdfImport = (() => {

  const $ = id => document.getElementById(id);
  const PDFJS_VER  = '3.11.174';
  const WORKER_SRC = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.js`;
  const LS_KEY = 'ocrtool_pdf_dpi';
  const DEFAULT_DPI = 200;

  let doc = null, numPages = 0, curPage = 1, dpi = DEFAULT_DPI, fileName = '', onCanvasCb = null, onBatchCb = null, allowBatch = false, busy = false;
  let getFormsFn = null;          // 帳票一覧の取得関数（一括の帳票割り当て用）
  let getReviewDefaultFn = null;  // 一括カルーセル確認の初期ON/OFFを供給（OCR画面のトグルに同期）
  let assigns = [];               // 一括OCRの割り当て [{ from, to, formId }]

  /* 指定ページを現在のDPIでキャンバスへラスタライズ */
  async function renderPageToCanvas(pdfDoc, n, useDpi) {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: useDpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    /* このキャンバスはこの後 OpenCV(cv.imread) に何度も渡され画素を読み出される。
       willReadFrequentlyを指定しないとGPUバッキングになり、読み出しのたびに
       GPU→CPU転送が発生して重くなる（DevToolsの警告の直接の原因）。 */
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // 透過PDF対策
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }

  function isPdf(file) {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
  }
  function clampDpi(d) { return Math.max(72, Math.min(400, d || DEFAULT_DPI)); }

  /* pdf.worker を Blob URL 化して1度だけ準備する。
     CDN URL をそのまま workerSrc に渡すと、Worker 内部が importScripts() で
     追加のクロスオリジン取得を行うため、file:// で開いた場合に Chrome がこれを
     ブロックすることがある（要確認: 「ローカルサーバーを立てずに開く」と失敗する件）。
     ここでは先にスクリプト本文を fetch し、同一オリジンの Blob URL として
     Worker に渡すことで、Worker 生成後のクロスオリジン取得を発生させない
     （Tesseract 側は同種の対策がライブラリ内蔵で既に効いている）。 */
  let workerSrcPromise = null;
  function ensureWorkerSrc() {
    if (!workerSrcPromise) {
      workerSrcPromise = fetch(WORKER_SRC)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(code => URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
        .catch(() => WORKER_SRC);   // 取得できない場合は直接URLにフォールバック（従来どおり）
    }
    return workerSrcPromise;
  }
  async function ensureLib() {
    if (!window.pdfjsLib) throw new Error('PDFライブラリを読み込めませんでした（ネット接続を確認してください）');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = await ensureWorkerSrc();
  }
  function fileToArrayBuffer(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('ファイルの読み込みに失敗しました'));
      r.readAsArrayBuffer(file);
    });
  }

  /* ── 公開: PDF を開いて取り込みモーダルを表示 ───────────
     opts = { onCanvas(canvas), onBatch(pageSource), allowBatch } */
  async function open(file, opts) {
    opts = opts || {};
    onCanvasCb = opts.onCanvas || null;
    onBatchCb  = opts.onBatch || null;
    allowBatch = !!opts.allowBatch;
    getFormsFn = opts.getForms || null;
    getReviewDefaultFn = opts.getReviewDefault || null;
    if (doc) { try { doc.destroy(); } catch (_) {} doc = null; }   // 直前のPDF（ESCで閉じた等）を解放
    try {
      await ensureLib();
      const buf = await fileToArrayBuffer(file);
      doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      numPages = doc.numPages; curPage = 1; fileName = file.name || 'PDF';
      dpi = clampDpi(parseInt(localStorage.getItem(LS_KEY), 10) || DEFAULT_DPI);
      assigns = [{ from: 1, to: numPages, formId: '' }];   // 既定=全ページ・自動判定
      const rv = $('pdfBatchReview'); if (rv) rv.checked = !!(getReviewDefaultFn && getReviewDefaultFn());
      $('pdfModal').classList.remove('hidden');
      renderControls();
      await renderPreview();
    } catch (e) {
      StudioUI.toast('PDFの読み込みに失敗しました: ' + (e.message || e), 'error', 5000);
      close();
    }
  }
  function close() {
    $('pdfModal').classList.add('hidden');
    if (doc) { try { doc.destroy(); } catch (_) {} }
    doc = null; onCanvasCb = null; onBatchCb = null;
  }

  function renderControls() {
    $('pdfFileName').textContent = fileName;
    $('pdfPageInfo').textContent = numPages > 1 ? `全 ${numPages} ページ` : '1 ページ';
    $('pdfPageNav').style.display = numPages > 1 ? '' : 'none';
    $('pdfPageInput').max = String(numPages);
    $('pdfPageInput').value = String(curPage);
    $('pdfPageTotal').textContent = `/ ${numPages}`;
    $('pdfPageSlider').max = String(numPages);
    $('pdfPageSlider').value = String(curPage);
    $('pdfPrev').disabled = curPage <= 1;
    $('pdfNext').disabled = curPage >= numPages;
    document.querySelectorAll('#pdfDpiBtns [data-dpi]').forEach(b => b.classList.toggle('is-active', parseInt(b.dataset.dpi, 10) === dpi));
    renderAssigns();
  }
  /* ページ番号を指定して移動（範囲外は1〜numPagesへ丸める）。番号入力・スライダー共通。 */
  function gotoPage(n) {
    const p = Math.max(1, Math.min(numPages, Math.round(n) || 1));
    if (p === curPage) { renderControls(); return; }   // 丸めで戻った場合も表示だけ揃える
    curPage = p; renderControls(); renderPreview();
  }

  /* 一括OCR: ページ範囲ごとに使う帳票を割り当てる（formId '' = 自動判定） */
  function batchAvailable() { return allowBatch && !!onBatchCb && numPages > 1; }
  function formOptionsHTML(selId) {
    const forms = (getFormsFn && getFormsFn()) || [];
    const opts = ['<option value="">自動判定</option>'];
    forms.forEach(f => opts.push(`<option value="${f.id}"${f.id === selId ? ' selected' : ''}>${(f.name || '').replace(/</g, '&lt;')}</option>`));
    return opts.join('');
  }
  /* 全ルールから処理対象ページ（重複排除・昇順）と page→formId を求める */
  function resolveBatch() {
    const pages = [];
    const formFor = {};
    assigns.forEach(a => {
      const from = Math.max(1, Math.min(numPages, a.from));
      const to = Math.max(1, Math.min(numPages, a.to));
      for (let n = Math.min(from, to); n <= Math.max(from, to); n++) {
        if (!(n in formFor)) pages.push(n);
        formFor[n] = a.formId || '';   // 後勝ち
      }
    });
    pages.sort((x, y) => x - y);
    return { pages, formFor };
  }
  function renderAssigns() {
    const show = batchAvailable();
    $('pdfBatchAssign').style.display = show ? '' : 'none';
    $('pdfBatchBtn').style.display = show ? '' : 'none';
    if (!show) return;
    const wrap = $('pdfAssignRows'); wrap.innerHTML = '';
    assigns.forEach((a, i) => {
      const row = document.createElement('div'); row.className = 'pdf-assign-row';
      row.innerHTML = `ページ <input type="number" class="pdf-range-input pa-from" min="1" max="${numPages}" value="${a.from}">`
        + ` – <input type="number" class="pdf-range-input pa-to" min="1" max="${numPages}" value="${a.to}">`
        + ` → <select class="pselect pa-form">${formOptionsHTML(a.formId)}</select>`
        + ` <button type="button" class="pa-del" title="この範囲を削除"${assigns.length <= 1 ? ' disabled' : ''}><i class="fas fa-xmark"></i></button>`;
      row.querySelector('.pa-from').addEventListener('change', e => { a.from = parseInt(e.target.value, 10) || 1; renderAssigns(); });
      row.querySelector('.pa-to').addEventListener('change', e => { a.to = parseInt(e.target.value, 10) || numPages; renderAssigns(); });
      row.querySelector('.pa-form').addEventListener('change', e => { a.formId = e.target.value; });
      row.querySelector('.pa-del').addEventListener('click', () => { assigns.splice(i, 1); renderAssigns(); });
      wrap.appendChild(row);
    });
    const { pages } = resolveBatch();
    $('pdfBatchBtn').innerHTML = `<i class="fas fa-layer-group"></i> 一括OCR（${pages.length}ページ）`;
    $('pdfBatchBtn').disabled = pages.length === 0;
  }
  function addAssign() {
    const last = assigns[assigns.length - 1];
    const from = last ? Math.min(numPages, last.to + 1) : 1;
    assigns.push({ from, to: numPages, formId: last ? last.formId : '' });
    renderAssigns();
  }

  async function renderPreview() {
    if (!doc) return;
    busy = true; $('pdfLoadBtn').disabled = true;
    try {
      const page = await doc.getPage(curPage);
      const base = page.getViewport({ scale: 1 });
      const previewScale = Math.min(2, 460 / base.width);
      const vp = page.getViewport({ scale: previewScale });
      const c = $('pdfPreviewCanvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const out = page.getViewport({ scale: dpi / 72 });   // 1pt=1/72inch → scale=dpi/72
      $('pdfOutInfo').textContent = `読み込みサイズ: ${Math.round(out.width)} × ${Math.round(out.height)} px（${dpi} DPI）`;
    } catch (e) {
      StudioUI.toast('プレビューに失敗しました: ' + (e.message || e), 'error');
    } finally {
      busy = false; $('pdfLoadBtn').disabled = false;
    }
  }

  async function loadChosen() {
    if (!doc || busy) return;
    busy = true;
    const btn = $('pdfLoadBtn'); const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 変換中…';
    try {
      const c = await renderPageToCanvas(doc, curPage, dpi);
      localStorage.setItem(LS_KEY, String(dpi));
      const cb = onCanvasCb;
      close();
      if (cb) cb(c);
    } catch (e) {
      StudioUI.toast('PDFの変換に失敗しました: ' + (e.message || e), 'error', 5000);
      busy = false; btn.disabled = false; btn.innerHTML = orig;
    }
  }

  /* 一括: 割り当てを解決し、doc を保持したままモーダルを閉じてページ供給元を渡す */
  function loadBatch() {
    if (!doc || busy || !onBatchCb) return;
    const { pages, formFor } = resolveBatch();
    if (!pages.length) return;
    localStorage.setItem(LS_KEY, String(dpi));
    const review = !!($('pdfBatchReview') && $('pdfBatchReview').checked);   // OCR中に1ページずつ確認するか
    const d = doc, dp = dpi, cb = onBatchCb, fn = fileName;
    doc = null;                                 // close()/次のopen()で破棄させない（pageSourceが保持）
    onCanvasCb = null; onBatchCb = null;
    $('pdfModal').classList.add('hidden');
    cb({
      pages, total: pages.length, dpi: dp, fileName: fn, review,
      formFor: n => formFor[n] || '',
      getPage: n => renderPageToCanvas(d, n, dp),
      done: () => { try { d.destroy(); } catch (_) {} },
    });
  }

  /* ── 初期化（モーダル配線） ─────────────────────────── */
  function init() {
    if (!$('pdfModal')) return;
    $('pdfClose').addEventListener('click', close);
    $('pdfCancel').addEventListener('click', close);
    /* 背景クリックでは閉じない（設定中に誤って外側をクリックしてキャンセルになり、
       読み込み直しになる手間を避けるため）。閉じるのは×またはキャンセルのみ。 */
    $('pdfDpiBtns').addEventListener('click', e => {
      const b = e.target.closest('button[data-dpi]'); if (!b) return;
      dpi = clampDpi(parseInt(b.dataset.dpi, 10)); renderControls(); renderPreview();
    });
    $('pdfPrev').addEventListener('click', () => gotoPage(curPage - 1));
    $('pdfNext').addEventListener('click', () => gotoPage(curPage + 1));
    /* ページ番号を直接入力してジャンプ（何百ページもある資料で◀▶の連打を避ける） */
    $('pdfPageInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    $('pdfPageInput').addEventListener('change', e => gotoPage(parseInt(e.target.value, 10)));
    /* スライダーはドラッグ中(input)は表示だけ追従させ、離した瞬間(change)にだけ
       実際にページを描画する。毎フレーム重いPDFレンダリングを走らせると、
       非同期処理の完了順が入れ替わって違うページが表示されたままになる
       競合状態を招くため。 */
    $('pdfPageSlider').addEventListener('input', e => { $('pdfPageInput').value = e.target.value; });
    $('pdfPageSlider').addEventListener('change', e => gotoPage(parseInt(e.target.value, 10)));
    $('pdfLoadBtn').addEventListener('click', loadChosen);
    $('pdfBatchBtn').addEventListener('click', loadBatch);
    $('pdfAssignAdd').addEventListener('click', addAssign);
  }

  return { isPdf, open, init };

})();
