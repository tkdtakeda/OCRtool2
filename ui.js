/* ════════════════════════════════════════════════════════
   ui.js  UI コントローラー
   Responsibility: DOM 操作・UI 状態管理のみ。処理ロジックは持たない
   ════════════════════════════════════════════════════════ */
'use strict';

const UIController = (() => {

  /* ── Accordion ──────────────────────────────────────── */
  /**
   * .pgroup-hdr の各ボタンにアコーディオン動作を付与する
   */
  function initAccordions() {
    document.querySelectorAll('.pgroup-hdr').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const body = document.getElementById(hdr.dataset.target);
        if (!body) return;
        const opening = !hdr.classList.contains('is-open');
        hdr.classList.toggle('is-open', opening);
        body.classList.toggle('is-collapsed', !opening);
      });
    });
  }

  /* ── Slider value sync ──────────────────────────────── */
  /* スライダー ID → 表示値 ID のマップ */
  const SLIDER_MAP = [
    ['manualThresh',   'valManualThresh'],
    ['adaptiveBlock',  'valAdaptiveBlock'],
    ['adaptiveC',      'valAdaptiveC'],
    ['horizLen',       'valHorizLen'],
    ['horizThick',     'valHorizThick'],
    ['horizDilate',    'valHorizDilate'],
    ['vertLen',        'valVertLen'],
    ['vertThick',      'valVertThick'],
    ['vertDilate',     'valVertDilate'],
    ['maskDilate',     'valMaskDilate'],
  ];

  /**
   * スライダーの input イベントで .pval を更新し、フラッシュアニメーションを付与する
   */
  function initSliders() {
    SLIDER_MAP.forEach(([sliderId, valId]) => {
      const slider = document.getElementById(sliderId);
      const valEl  = document.getElementById(valId);
      if (!slider || !valEl) return;
      slider.addEventListener('input', () => {
        valEl.textContent = slider.value;
        valEl.classList.add('is-flash');
        setTimeout(() => valEl.classList.remove('is-flash'), 220);
      });
    });
  }

  /* ── Binary method conditional rows ────────────────── */
  const BINARY_ROWS = {
    manual:   ['rowManualThresh'],
    adaptive: ['rowAdaptiveBlock', 'rowAdaptiveC'],
  };
  const ALL_CONDITIONAL_IDS = Object.values(BINARY_ROWS).flat();

  /**
   * 二値化方式の変更に応じて関連パラメータ行を表示/非表示にする
   */
  function initBinaryMethodToggle() {
    const sel = document.getElementById('binaryMethod');
    if (!sel) return;

    const update = () => {
      /* まず全部隠す */
      ALL_CONDITIONAL_IDS.forEach(id =>
        document.getElementById(id)?.classList.add('hidden')
      );
      /* 選択中の方式に対応する行だけ表示 */
      (BINARY_ROWS[sel.value] || []).forEach(id =>
        document.getElementById(id)?.classList.remove('hidden')
      );
    };

    sel.addEventListener('change', update);
    update(); /* 初期化 */
  }

  /* ── Image area visibility ──────────────────────────── */
  /**
   * ドロップゾーンと処理ステップグリッドの表示を切り替える
   * @param {boolean} showGrid  true=グリッド表示, false=ドロップゾーン表示
   */
  function showImageArea(showGrid) {
    document.getElementById('dropZone').classList.toggle('hidden', showGrid);
    document.getElementById('stepsGrid').classList.toggle('hidden', !showGrid);
  }

  /* ── Canvas update ──────────────────────────────────── */
  /**
   * 処理結果 Mat 配列をキャンバスに描画し、寸法ラベルを更新する
   * @param {cv.Mat[]} mats
   * @param {{ renderToCanvas: Function }} processor
   */
  function updateCanvases(mats, processor) {
    mats.forEach((mat, i) => {
      const canvas = document.getElementById(`canvas${i}`);
      const dimEl  = document.getElementById(`dim${i}`);
      if (!canvas || !mat) return;
      processor.renderToCanvas(mat, canvas);
      if (dimEl) {
        dimEl.textContent = `${mat.cols} × ${mat.rows}`;
      }
    });
  }

  /* ── Toast notification ─────────────────────────────── */
  const TOAST_ICONS = {
    success: 'fa-circle-check',
    error:   'fa-circle-xmark',
    warning: 'fa-triangle-exclamation',
    info:    'fa-circle-info',
  };

  /**
   * 画面右下にトースト通知を表示する
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'} type
   * @param {number} duration  表示時間 ms
   */
  function showToast(message, type = 'info', duration = 2800) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
    toast.innerHTML = `<i class="fas ${icon}"></i><span>${message}</span>`;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));

    const remove = () => {
      toast.classList.remove('is-visible');
      setTimeout(() => { try { container.removeChild(toast); } catch (_) {} }, 280);
    };
    setTimeout(remove, duration);
  }

  /* ── Modal management ───────────────────────────────── */
  /**
   * モーダルオーバーレイ共通の閉じ動作（背景クリック・Esc キー）を初期化する
   */
  function initModals() {
    /* オーバーレイ背景クリックで閉じる */
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.classList.add('hidden');
      });
    });
    /* Esc キーで全モーダルを閉じる */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not(.hidden)')
          .forEach(m => m.classList.add('hidden'));
      }
    });
  }

  /**
   * 指定 ID のモーダルを開く
   * @param {string} id
   */
  function openModal(id) {
    document.getElementById(id)?.classList.remove('hidden');
  }

  /**
   * 指定 ID のモーダルを閉じる
   * @param {string} id
   */
  function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
  }

  /* ── OCR Panel visibility ───────────────────────────── */
  /**
   * OCR 結果パネルの表示/非表示を切り替える
   * @param {boolean} show
   */
  function showOcrPanel(show) {
    document.getElementById('ocrPanel')?.classList.toggle('hidden', !show);
  }

  /**
   * OCR 処理中プログレス表示と結果表示を切り替える
   * @param {boolean} showProgress  true=プログレス表示, false=結果表示
   */
  function showOcrProgress(showProgress) {
    document.getElementById('ocrProgress')?.classList.toggle('hidden', !showProgress);
    document.getElementById('ocrResult')?.classList.toggle('hidden', showProgress);
  }

  /**
   * OCR プログレスバーとステータスメッセージを更新する
   * @param {string} status    ステータスメッセージ
   * @param {number} progress  0.0 〜 1.0
   */
  function updateOcrProgress(status, progress) {
    const fill = document.getElementById('ocrProgressFill');
    const msg  = document.getElementById('ocrProgressMsg');
    if (fill) fill.style.width = `${Math.round((progress || 0) * 100)}%`;
    if (msg)  msg.textContent  = status || '処理中…';
  }

  /* ── OCR Result rendering ───────────────────────────── */
  /**
   * 特殊文字をエスケープして DOM インジェクションを防ぐ
   * @param {string} s
   * @returns {string}
   */
  function escHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * OCR 認識結果（全テキスト＋単語信頼度）を描画する
   * @param {Array<{ text: string, confidence: number }>} words
   * @param {string} fullText
   */
  function renderOcrResult(words, fullText) {
    const textEl  = document.getElementById('ocrFullText');
    const wordsEl = document.getElementById('ocrWords');
    const statEl  = document.getElementById('ocrStat');

    /* 全テキスト */
    if (textEl) textEl.value = fullText.trim();

    /* 単語数バッジ */
    if (statEl) statEl.textContent = `${words.length} 単語`;

    if (!wordsEl) return;
    wordsEl.innerHTML = '';

    words.forEach(w => {
      const conf  = w.confidence;
      const level = conf >= 85 ? 'high' : conf >= 60 ? 'mid' : 'low';

      const chip = document.createElement('span');
      chip.className = `conf-chip conf-${level}`;
      chip.title     = `"${escHtml(w.text)}"  信頼度: ${conf}%`;

      /* テキスト部分（textNode でインジェクション防止） */
      chip.appendChild(document.createTextNode(w.text + '\u00A0'));

      /* 信頼度スコア */
      const score = document.createElement('small');
      score.className   = 'conf-score';
      score.textContent = conf + '%';
      chip.appendChild(score);

      wordsEl.appendChild(chip);
    });
  }

  /* ── Public API ─────────────────────────────────────── */
  return {
    initAccordions,
    initSliders,
    initBinaryMethodToggle,
    showImageArea,
    updateCanvases,
    showToast,
    initModals,
    openModal,
    closeModal,
    showOcrPanel,
    showOcrProgress,
    updateOcrProgress,
    renderOcrResult,
  };

})();
