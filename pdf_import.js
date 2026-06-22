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
  const DEFAULT_DPI = 150;

  let doc = null, numPages = 0, curPage = 1, dpi = DEFAULT_DPI, fileName = '', onCanvasCb = null, onBatchCb = null, allowBatch = false, busy = false, workerSet = false;

  /* 指定ページを現在のDPIでキャンバスへラスタライズ */
  async function renderPageToCanvas(pdfDoc, n, useDpi) {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: useDpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // 透過PDF対策
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }

  function isPdf(file) {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
  }
  function clampDpi(d) { return Math.max(72, Math.min(400, d || DEFAULT_DPI)); }

  function ensureLib() {
    if (!window.pdfjsLib) throw new Error('PDFライブラリを読み込めませんでした（ネット接続を確認してください）');
    if (!workerSet) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC; workerSet = true; }
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
    if (doc) { try { doc.destroy(); } catch (_) {} doc = null; }   // 直前のPDF（ESCで閉じた等）を解放
    try {
      ensureLib();
      const buf = await fileToArrayBuffer(file);
      doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      numPages = doc.numPages; curPage = 1; fileName = file.name || 'PDF';
      dpi = clampDpi(parseInt(localStorage.getItem(LS_KEY), 10) || DEFAULT_DPI);
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
    $('pdfPageLabel').textContent = `${curPage} / ${numPages}`;
    $('pdfPrev').disabled = curPage <= 1;
    $('pdfNext').disabled = curPage >= numPages;
    $('pdfBatchBtn').style.display = (allowBatch && onBatchCb && numPages > 1) ? '' : 'none';
    document.querySelectorAll('#pdfDpiBtns [data-dpi]').forEach(b => b.classList.toggle('is-active', parseInt(b.dataset.dpi, 10) === dpi));
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

  /* 全ページ一括: doc を保持したままモーダルを閉じ、ページ供給元を渡す */
  function loadBatch() {
    if (!doc || busy || !onBatchCb) return;
    localStorage.setItem(LS_KEY, String(dpi));
    const d = doc, np = numPages, dp = dpi, cb = onBatchCb;
    doc = null;                                 // close()/次のopen()で破棄させない（pageSourceが保持）
    onCanvasCb = null; onBatchCb = null;
    $('pdfModal').classList.add('hidden');
    cb({
      numPages: np, dpi: dp, fileName,
      getPage: n => renderPageToCanvas(d, n, dp),
      done: () => { try { d.destroy(); } catch (_) {} },
    });
  }

  /* ── 初期化（モーダル配線） ─────────────────────────── */
  function init() {
    if (!$('pdfModal')) return;
    $('pdfClose').addEventListener('click', close);
    $('pdfCancel').addEventListener('click', close);
    $('pdfModal').addEventListener('click', e => { if (e.target === $('pdfModal')) close(); });
    $('pdfDpiBtns').addEventListener('click', e => {
      const b = e.target.closest('button[data-dpi]'); if (!b) return;
      dpi = clampDpi(parseInt(b.dataset.dpi, 10)); renderControls(); renderPreview();
    });
    $('pdfPrev').addEventListener('click', () => { if (curPage > 1) { curPage--; renderControls(); renderPreview(); } });
    $('pdfNext').addEventListener('click', () => { if (curPage < numPages) { curPage++; renderControls(); renderPreview(); } });
    $('pdfLoadBtn').addEventListener('click', loadChosen);
    $('pdfBatchBtn').addEventListener('click', loadBatch);
  }

  return { isPdf, open, init };

})();
