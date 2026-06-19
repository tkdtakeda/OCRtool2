/* ════════════════════════════════════════════════════════
   sample_forms.js  サンプル帳票ジェネレーター（動作確認用）
   Responsibility: 統合ツールのデータモデルに沿ったサンプル帳票を生成。
     - referenceImage : 帳票全体（OCR座標の基準）
     - anchors        : 識別用の特徴画像（複数・基準画像内の位置付き）
     - ocrRegions     : 基準画像上の絶対座標で指定した読取領域
   将来 PDF 対応時もこのデータ構造はそのまま流用できる。
   ════════════════════════════════════════════════════════ */
'use strict';

const SampleForms = (() => {

  let _seq = 0;
  const uid = () => 's' + (Date.now().toString(36)) + (_seq++);

  function mkCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function crop(src, x, y, w, h) {
    const c = mkCanvas(w, h);
    c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
    return c;
  }
  const url = c => c.toDataURL('image/png');

  /* ── 表描画 ─────────────────────────────────────────── */
  function drawTable(ctx, x, y, totalW, rowH, rows, colRatios, headers, data, accent) {
    ctx.fillStyle = accent + '25'; ctx.fillRect(x, y, totalW, rowH);
    ctx.strokeStyle = '#999'; ctx.lineWidth = 0.8;
    ctx.strokeRect(x, y, totalW, rowH * (rows + 1));
    let cx = x;
    colRatios.forEach((r, ci) => {
      const cw = totalW * r;
      if (ci > 0) { ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx, y + rowH * (rows + 1)); ctx.stroke(); }
      ctx.fillStyle = accent; ctx.font = 'bold 10px sans-serif';
      ctx.fillText(headers[ci] || '', cx + 4, y + rowH - 5);
      cx += cw;
    });
    for (let r = 0; r < rows; r++) {
      const ry = y + rowH * (r + 1);
      ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x + totalW, ry); ctx.stroke();
      if (data && data[r]) {
        cx = x;
        colRatios.forEach((ratio, ci) => {
          const cw = totalW * ratio;
          const v = (data[r][ci] || '').substring(0, 16);
          if (v) { ctx.fillStyle = '#333'; ctx.font = '9px monospace'; ctx.fillText(v, cx + 3, ry + rowH - 5); }
          cx += cw;
        });
      }
    }
  }

  /* ── 帳票仕様 ───────────────────────────────────────── */
  const SPECS = [
    {
      name: '発注書', accent: '#1D6BB0', title: '発 注 書',
      numLabel: '発注番号:', numValue: 'PO-2024-0001',
      dateLabel: '発注日:',  dateValue: '2024-06-12',
      subLabel: '担当者:',   subValue: 'TANAKA',
      total: '283,000',
    },
    {
      name: '納品書', accent: '#0F7D5E', title: '納 品 書',
      numLabel: '納品番号:', numValue: 'DN-2024-0001',
      dateLabel: '納品日:',  dateValue: '2024-06-15',
      subLabel: '納品先:',   subValue: 'OOSEISAKUSHO',
      total: '157,000',
    },
  ];

  /* ── 帳票全体画像を描画 ─────────────────────────────── */
  function drawForm(spec) {
    const W = 640, H = 760, c = mkCanvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

    /* タイトルブロック（識別アンカー①の領域: x30 y20 w200 h48） */
    ctx.fillStyle = spec.accent; ctx.fillRect(30, 20, 200, 48);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 24px sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(spec.title, 42, 44); ctx.textBaseline = 'alphabetic';

    /* 発行元ブロック（識別アンカー②の領域: x420 y14 w190 h44） */
    ctx.strokeStyle = spec.accent; ctx.lineWidth = 1; ctx.strokeRect(420, 14, 190, 44);
    ctx.fillStyle = '#444'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('SAMPLE MFG CO., LTD.', 604, 28);
    ctx.fillText('Aichi, Tsushima 490-0000', 604, 41);
    ctx.fillText('TEL 0567-XX-XXXX', 604, 54);
    ctx.textAlign = 'left';

    ctx.strokeStyle = spec.accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(30, 74); ctx.lineTo(W - 30, 74); ctx.stroke();

    /* 番号欄（OCR領域①: 値ボックス x105 y78 w170 h18） */
    ctx.fillStyle = '#666'; ctx.font = '11px sans-serif'; ctx.fillText(spec.numLabel, 30, 92);
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 0.8; ctx.strokeRect(105, 78, 170, 18);
    ctx.fillStyle = '#000'; ctx.font = '12px monospace'; ctx.fillText(spec.numValue, 110, 91);

    /* 日付欄（OCR領域②: x80 y104 w110 h18）/ 担当欄（OCR領域③: x246 y104 w140 h18） */
    ctx.fillStyle = '#666'; ctx.font = '11px sans-serif'; ctx.fillText(spec.dateLabel, 30, 118);
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 0.8; ctx.strokeRect(80, 104, 110, 18);
    ctx.fillStyle = '#000'; ctx.font = '12px monospace'; ctx.fillText(spec.dateValue, 85, 117);
    ctx.fillStyle = '#666'; ctx.font = '11px sans-serif'; ctx.fillText(spec.subLabel, 200, 118);
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 0.8; ctx.strokeRect(246, 104, 140, 18);
    ctx.fillStyle = '#000'; ctx.font = '12px monospace'; ctx.fillText(spec.subValue, 251, 117);

    /* 明細表 */
    const tY = 140, tW = W - 60, rowH = 22;
    drawTable(ctx, 30, tY, tW, rowH, 10,
      [0.07, 0.33, 0.20, 0.13, 0.13, 0.14],
      ['No.', 'ITEM', 'SPEC', 'QTY', 'UNIT', 'AMOUNT'],
      [['1', 'AL PLATE A1050', 't2x200x300', '50', '1,200', '60,000'],
       ['2', 'AL BAR A6061', 'd20x1000', '20', '3,500', '70,000'],
       ['3', 'ANGLE A6063', '30x30x1000', '15', '1,800', '27,000']],
      spec.accent);

    /* 合計 */
    const totY = tY + rowH * 11 + 12;
    ctx.fillStyle = spec.accent + '18'; ctx.fillRect(30 + tW * 0.72, totY, tW * 0.28, 26);
    ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.strokeRect(30 + tW * 0.72, totY, tW * 0.28, 26);
    ctx.fillStyle = '#444'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('TOTAL', 30 + tW * 0.72 + 8, totY + 17);
    ctx.fillStyle = spec.accent; ctx.font = 'bold 13px monospace'; ctx.textAlign = 'right';
    ctx.fillText(spec.total, W - 32, totY + 17); ctx.textAlign = 'left';
    return c;
  }

  /* ── 帳票レイアウト（FormDB 形式）を生成 ────────────── */
  function build() {
    return SPECS.map(spec => {
      const ref = drawForm(spec);
      const anchorRects = [
        { name: 'タイトルブロック', x: 30,  y: 20, w: 200, h: 48 },
        { name: '発行元ブロック',   x: 420, y: 14, w: 190, h: 44 },
      ];
      const anchors = anchorRects.map(r => ({
        id: uid(), name: r.name,
        dataURL: url(crop(ref, r.x, r.y, r.w, r.h)),
        w: r.w, h: r.h, refX: r.x, refY: r.y,
      }));
      /* charRule: 桁別の文字制約（字種制限＋誤認補正）のデモ
         番号 例 PO-2024-0001（英大2 - 数字4 - 数字4）/ 日付 例 2024-06-15（数字-数字-数字） */
      const U = CharConstraint.presetSet('upper');
      const D = CharConstraint.presetSet('digit');
      const ocrRegions = [
        { id: uid(), name: '番号', x: 105, y: 78,  w: 170, h: 18, charRule: { len: 12, pos: [U, U, '-', D, D, D, D, '-', D, D, D, D] } },
        { id: uid(), name: '日付', x: 80,  y: 104, w: 110, h: 18, charRule: { len: 10, pos: [D, D, D, D, '-', D, D, '-', D, D] } },
        { id: uid(), name: '担当', x: 246, y: 104, w: 140, h: 18 },
      ];
      return {
        id: uid(),
        name: spec.name,
        referenceImage: { dataURL: url(ref), w: ref.width, h: ref.height },
        anchors,
        ocrRegions,
        ocrSettings: { psm: 7, lang: 'eng' },
        lineRemoval: LineRemovalProcessor.defaultParams(),
        isSample: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });
  }

  /** 判定対象として使える「帳票全体の画像」キャンバス（傾き付き）も提供 */
  function sampleInputCanvas(formIndex = 0, angleDeg = 0) {
    const c = drawForm(SPECS[formIndex]);
    if (!angleDeg) return c;
    const out = mkCanvas(c.width, c.height);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(angleDeg * Math.PI / 180);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
    return out;
  }

  return { build, sampleInputCanvas, drawForm, SPECS };

})();
