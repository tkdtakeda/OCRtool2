/* ════════════════════════════════════════════════════════
   app.js  アプリケーションコントローラー
   Responsibility: モジュール間の調整・イベントハンドリング・状態管理
   ════════════════════════════════════════════════════════ */
'use strict';

(function () {

  /* ── Application State ──────────────────────────────── */
  let cvReady    = false;
  let currentImg = null;   /* 入力元 HTMLCanvasElement */
  let prevMats   = [];     /* 前回描画した cv.Mat[] （解放用） */
  let isSample   = false;  /* 現在の画像がサンプルかどうか */
  let ocrRunning = false;  /* OCR 処理中フラグ */
  let debouncedRun;        /* init() 内で初期化 */

  /* ── Utility ────────────────────────────────────────── */
  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /* ── OpenCV lifecycle ───────────────────────────────── */
  document.addEventListener('cv-ready', () => {
    cvReady = true;
    document.getElementById('loadingOverlay').classList.add('hidden');
    UIController.showToast('OpenCV.js の準備が完了しました', 'success');
    /* 先に画像が読み込まれていた場合は即処理 */
    if (currentImg) runProcessing();
  });

  document.addEventListener('cv-error', () => {
    const msg = document.getElementById('loadingMsg');
    if (msg) msg.textContent = '読み込み失敗。インターネット接続を確認してください。';
    UIController.showToast('OpenCV.js の読み込みに失敗しました', 'error', 6000);
  });

  /* ── Parameter collection ───────────────────────────── */
  function getParams() {
    const v  = id => document.getElementById(id);
    const vi = id => parseInt(v(id).value, 10);
    return {
      binaryMethod:  v('binaryMethod').value,
      manualThresh:  vi('manualThresh'),
      adaptiveBlock: vi('adaptiveBlock'),
      adaptiveC:     vi('adaptiveC'),
      enableHoriz:   v('enableHoriz').checked,
      horizLen:      vi('horizLen'),
      horizThick:    vi('horizThick'),
      horizDilate:   vi('horizDilate'),
      enableVert:    v('enableVert').checked,
      vertLen:       vi('vertLen'),
      vertThick:     vi('vertThick'),
      vertDilate:    vi('vertDilate'),
      maskDilate:    vi('maskDilate'),
      outputBase:    v('outputBase').value,
    };
  }

  /* ── Processing pipeline trigger ───────────────────── */
  function runProcessing() {
    if (!cvReady || !currentImg) return;

    LineRemovalProcessor.cleanupMats(prevMats);
    const result = LineRemovalProcessor.process(currentImg, getParams());

    if (result.error) {
      UIController.showToast(`処理エラー: ${result.error}`, 'error');
      prevMats = [];
      return;
    }

    prevMats = result.mats;
    UIController.updateCanvases(prevMats, LineRemovalProcessor);
    document.getElementById('btnDownload').disabled = false;
    setOcrButtons(false); /* 罫線除去完了 → OCR ボタン有効化 */
  }

  /* ── Image loading helper ───────────────────────────── */
  /**
   * 任意の img/video/canvas 要素を新しい HTMLCanvasElement に描画して返す
   * @param {HTMLImageElement|HTMLCanvasElement} src
   * @returns {HTMLCanvasElement}
   */
  function drawToCanvas(src) {
    const c   = document.createElement('canvas');
    c.width   = src.naturalWidth  || src.width;
    c.height  = src.naturalHeight || src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  /**
   * 画像を現在の入力として設定し、処理を開始する
   * @param {HTMLCanvasElement} canvas
   * @param {boolean}           asSample  サンプル由来かどうか
   */
  function setImage(canvas, asSample) {
    currentImg = canvas;
    isSample   = !!asSample;
    UIController.showImageArea(true);
    runProcessing();
  }

  /* ── Paste handling ─────────────────────────────────── */
  /**
   * document の paste イベントから画像を取得する（Ctrl+V）
   * @param {ClipboardEvent} e
   */
  function handlePasteEvent(e) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        const url  = URL.createObjectURL(blob);
        const img  = new Image();
        img.onload = () => {
          setImage(drawToCanvas(img));
          URL.revokeObjectURL(url);
          UIController.showToast('画像を貼り付けました', 'success');
        };
        img.src = url;
        return;
      }
    }
    UIController.showToast('クリップボードに画像がありません', 'warning');
  }

  /**
   * 「貼付け」ボタン押下時: Clipboard API 経由で画像を取得する
   */
  async function handlePasteButton() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const url  = URL.createObjectURL(blob);
          const img  = new Image();
          img.onload = () => {
            setImage(drawToCanvas(img));
            URL.revokeObjectURL(url);
            UIController.showToast('画像を貼り付けました', 'success');
          };
          img.src = url;
          return;
        }
      }
      UIController.showToast('クリップボードに画像がありません', 'warning');
    } catch (_) {
      UIController.showToast('Ctrl+V で直接貼り付けてください', 'info');
    }
  }

  /* ── Download ───────────────────────────────────────── */
  /**
   * canvas3 の内容を PNG でダウンロードする
   */
  function doDownload() {
    const canvas = document.getElementById('canvas3');
    if (!canvas || canvas.width === 0) {
      UIController.showToast('保存できる画像がありません', 'warning');
      return;
    }
    const a      = document.createElement('a');
    a.download   = `line_removed_${Date.now()}.png`;
    a.href       = canvas.toDataURL('image/png');
    a.click();
    UIController.showToast('罫線除去画像を保存しました', 'success');
  }

  /* ── Reset parameters ───────────────────────────────── */
  function resetParams() {
    const def = LineRemovalProcessor.defaultParams();
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      el[el.type === 'checkbox' ? 'checked' : 'value'] = val;
    };
    const setTxt = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('binaryMethod',  def.binaryMethod);
    set('manualThresh',  def.manualThresh);  setTxt('valManualThresh',  def.manualThresh);
    set('adaptiveBlock', def.adaptiveBlock); setTxt('valAdaptiveBlock', def.adaptiveBlock);
    set('adaptiveC',     def.adaptiveC);     setTxt('valAdaptiveC',     def.adaptiveC);
    set('enableHoriz',   def.enableHoriz);
    set('horizLen',      def.horizLen);      setTxt('valHorizLen',      def.horizLen);
    set('horizThick',    def.horizThick);    setTxt('valHorizThick',    def.horizThick);
    set('horizDilate',   def.horizDilate);   setTxt('valHorizDilate',   def.horizDilate);
    set('enableVert',    def.enableVert);
    set('vertLen',       def.vertLen);       setTxt('valVertLen',       def.vertLen);
    set('vertThick',     def.vertThick);     setTxt('valVertThick',     def.vertThick);
    set('vertDilate',    def.vertDilate);    setTxt('valVertDilate',    def.vertDilate);
    set('maskDilate',    def.maskDilate);    setTxt('valMaskDilate',    def.maskDilate);
    set('outputBase',    def.outputBase);

    /* 二値化方式トグルを再評価 */
    document.getElementById('binaryMethod').dispatchEvent(new Event('change'));

    UIController.showToast('パラメータをリセットしました', 'info');
    if (currentImg) debouncedRun();
  }

  /* ── Sample management ──────────────────────────────── */
  function initSamples() {
    if (typeof SampleGenerator === 'undefined') return; /* サンプル生成スクリプト未配置でも動作させる */
    const samples = SampleGenerator.generate();
    const grid    = document.getElementById('sampleGrid');
    if (!grid) return;

    samples.forEach(s => {
      const card  = document.createElement('div');
      card.className = 'sample-card';

      /* サムネイル用キャンバス */
      const thumb = document.createElement('canvas');
      thumb.width  = s.canvas.width;
      thumb.height = s.canvas.height;
      thumb.style.maxWidth = '100%';
      thumb.getContext('2d').drawImage(s.canvas, 0, 0);

      const label = document.createElement('span');
      label.className   = 'sample-name';
      label.textContent = s.name;

      card.append(thumb, label);
      card.addEventListener('click', () => {
        setImage(s.canvas, true);
        UIController.closeModal('sampleModal');
        UIController.showToast(`「${s.name}」を読み込みました`, 'success');
      });

      grid.appendChild(card);
    });
  }

  function clearSamples() {
    if (!isSample) {
      UIController.showToast('サンプル画像は読み込まれていません', 'info');
      return;
    }
    LineRemovalProcessor.cleanupMats(prevMats);
    prevMats   = [];
    currentImg = null;
    isSample   = false;
    UIController.showImageArea(false);
    UIController.showOcrPanel(false);
    document.getElementById('btnDownload').disabled = true;
    setOcrButtons(true); /* OCR ボタン無効化 */
    UIController.showToast('サンプルデータをクリアしました', 'info');
  }

  /* ── OCR button state helper ────────────────────────── */
  /**
   * OCR 実行ボタンの enabled/disabled を一括設定する
   * @param {boolean} disabled  true=無効, false=有効
   */
  function setOcrButtons(disabled) {
    const btn = document.getElementById('btnOcrHdr');
    if (btn) btn.disabled = disabled;
  }

  /* ── OCR execution ──────────────────────────────────── */
  /**
   * OCR を実行して結果パネルに表示する
   */
  async function handleOcr() {
    if (ocrRunning) return;

    /* 認識ソースを判定 */
    const srcEl  = document.getElementById('ocrSource');
    const source = srcEl ? srcEl.value : 'result';
    const canvas = document.getElementById(source === 'result' ? 'canvas3' : 'canvas0');

    if (!canvas || canvas.width === 0) {
      UIController.showToast('OCR対象の画像がありません', 'warning');
      return;
    }

    const psmEl = document.getElementById('ocrPsm');
    const psm   = psmEl ? parseInt(psmEl.value, 10) : 3;

    /* 実行開始 */
    ocrRunning = true;
    setOcrButtons(true);
    UIController.showOcrPanel(true);
    UIController.showOcrProgress(true);
    UIController.updateOcrProgress('初期化中…', 0);

    const result = await OcrProcessor.recognize(canvas, psm, p => {
      UIController.updateOcrProgress(p.status, p.progress);
    });

    /* 実行終了 */
    ocrRunning = false;
    setOcrButtons(false);
    UIController.showOcrProgress(false);

    if (result.error) {
      UIController.showToast(`OCRエラー: ${result.error}`, 'error', 5000);
      return;
    }

    UIController.renderOcrResult(result.words, result.fullText);
    UIController.showToast(`OCR完了 — ${result.words.length} 単語を認識しました`, 'success');
  }

  /* ── OCR copy ───────────────────────────────────────── */
  /**
   * OCR 認識テキストをクリップボードにコピーする
   */
  function handleCopyOcr() {
    const text = document.getElementById('ocrFullText')?.value;
    if (!text || !text.trim()) {
      UIController.showToast('コピーするテキストがありません', 'warning');
      return;
    }
    navigator.clipboard.writeText(text)
      .then(() => {
        UIController.showToast('テキストをコピーしました', 'success');
      })
      .catch(() => {
        UIController.showToast('コピーに失敗しました。テキストを手動で選択してください', 'error');
      });
  }

  /* ── Initialization ─────────────────────────────────── */
  function init() {
    debouncedRun = debounce(runProcessing, 180);

    UIController.initAccordions();
    UIController.initSliders();
    UIController.initBinaryMethodToggle();
    UIController.initModals();
    initSamples();

    /* --- Paste --- */
    document.addEventListener('paste', handlePasteEvent);
    document.getElementById('btnPaste')
      ?.addEventListener('click', handlePasteButton);

    /* --- Toolbar actions --- */
    document.getElementById('btnDownload')
      ?.addEventListener('click', doDownload);
    document.getElementById('btnDlInline')
      ?.addEventListener('click', doDownload);
    document.getElementById('btnReset')
      ?.addEventListener('click', resetParams);

    /* --- Sample --- */
    document.getElementById('btnSampleLoad')
      ?.addEventListener('click', () => UIController.openModal('sampleModal'));
    document.getElementById('btnSampleClear')
      ?.addEventListener('click', clearSamples);
    document.getElementById('closeSampleModal')
      ?.addEventListener('click', () => UIController.closeModal('sampleModal'));

    /* --- Help --- */
    document.getElementById('btnHelp')
      ?.addEventListener('click', () => UIController.openModal('helpModal'));
    document.getElementById('closeHelpModal')
      ?.addEventListener('click', () => UIController.closeModal('helpModal'));

    /* --- OCR --- */
    document.getElementById('btnOcrHdr')
      ?.addEventListener('click', handleOcr);
    document.getElementById('btnCopyOcr')
      ?.addEventListener('click', handleCopyOcr);
    document.getElementById('btnCloseOcr')
      ?.addEventListener('click', () => UIController.showOcrPanel(false));

    /* --- Parameter changes → debounced reprocessing --- */
    const panel = document.getElementById('paramPanel');
    panel?.addEventListener('input',  debouncedRun);
    panel?.addEventListener('change', debouncedRun);
  }

  document.addEventListener('DOMContentLoaded', init);

})();
