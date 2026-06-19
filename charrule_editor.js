/* ════════════════════════════════════════════════════════
   charrule_editor.js  文字制約ビジュアルエディタ（モーダル）
   Responsibility: 「桁数を決める → 各桁に使える文字を選ぶ」操作を
     直感的に行うUI。認知負荷を下げる設計:
       ・桁を左→右のタイルで空間表示（読み順と一致）
       ・字種はチャンク化したボタン（数字/英大/英数…）で即指定
       ・個別文字はパレットのトグルで微調整（例「2桁目はOを除く」）
       ・タイル要約とプレビューで結果を即時フィードバック
   状態は本モジュール内に閉じ、確定時に onSave(rule|null) を呼ぶだけ。
   ════════════════════════════════════════════════════════ */
'use strict';

const CharRuleEditor = (() => {

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let cur = { len: 0, pos: [] };   // 編集中ルール
  let sel = 0;                     // 選択中の桁
  let showLower = false;           // 小文字パレット表示
  let onSaveCb = null;

  const DEFAULT_SET = () => CharConstraint.presetSet('alnum');   // 新規桁の既定＝英数
  const visibleAlnum = () => CharConstraint.presetSet(showLower ? 'alnumAll' : 'alnum');

  /* ── 公開: 開く ─────────────────────────────────────── */
  function open(fieldName, rule, onSave) {
    onSaveCb = onSave;
    const norm = CharConstraint.normalize(rule);
    cur = norm ? { len: norm.len, pos: norm.pos.slice() }
               : { len: 4, pos: Array.from({ length: 4 }, DEFAULT_SET) };
    sel = 0;
    showLower = cur.pos.some(s => /[a-z]/.test(s));
    $('crFieldName').textContent = fieldName ? `「${fieldName}」` : '';
    $('crLen').value = cur.len;
    $('crModal').classList.remove('hidden');
    renderAll();
  }
  function close() { $('crModal').classList.add('hidden'); }

  /* ── 桁数の変更 ─────────────────────────────────────── */
  function setLen(n) {
    n = Math.max(0, Math.min(20, Math.floor(n || 0)));
    const pos = cur.pos.slice(0, n);
    while (pos.length < n) pos.push(DEFAULT_SET());
    cur = { len: n, pos };
    if (sel >= n) sel = Math.max(0, n - 1);
    $('crLen').value = n;
    renderAll();
  }

  /* ── 描画 ───────────────────────────────────────────── */
  function renderAll() { renderPositions(); renderEditor(); renderPreview(); }

  function renderPositions() {
    const c = $('crPositions'); c.innerHTML = '';
    if (!cur.len) { c.innerHTML = '<div class="cr-empty">「制約なし」です。桁数を 1 以上にすると、各桁に使える文字を指定できます。</div>'; return; }
    for (let i = 0; i < cur.len; i++) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'cr-tile' + (i === sel ? ' is-sel' : '');
      tile.innerHTML = `<span class="cr-tile-no">${i + 1}</span><span class="cr-tile-sum">${esc(CharConstraint.summarizePos(cur.pos[i]))}</span>`;
      tile.addEventListener('click', () => { sel = i; renderAll(); });
      c.appendChild(tile);
    }
  }

  function renderEditor() {
    const wrap = $('crEditor');
    if (!cur.len) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    $('crEditTitle').textContent = `${sel + 1}桁目`;
    const setStr = cur.pos[sel];
    /* ベース字種ボタンの選択状態 */
    document.querySelectorAll('#crBaseTypes [data-base]').forEach(b => {
      const ps = CharConstraint.presetSet(b.dataset.base);
      const active = b.dataset.base === 'any' ? !setStr : CharConstraint.sameSet(setStr, ps);
      b.classList.toggle('is-active', active);
    });
    renderPalette();
    $('crToggleLower').classList.toggle('is-active', showLower);
    $('crPosSummary').textContent = setStr
      ? `この桁の使用可: ${[...setStr].length}文字（${CharConstraint.summarizePos(setStr)}）`
      : 'この桁: 任意（すべての文字を許可）';
    $('crAnyNote').style.display = setStr ? 'none' : '';
  }

  function renderPalette() {
    const p = $('crPalette'); p.innerHTML = '';
    const setStr = cur.pos[sel];
    const isAny = !setStr;
    const allow = new Set(setStr);
    const groups = [['数字', CharConstraint.DIGITS], ['英大', CharConstraint.UPPER]];
    if (showLower) groups.push(['英小', CharConstraint.LOWER]);
    groups.forEach(([label, chars]) => {
      const row = document.createElement('div'); row.className = 'cr-prow';
      const lab = document.createElement('span'); lab.className = 'cr-prow-lab'; lab.textContent = label;
      row.appendChild(lab);
      for (const ch of chars) {
        const chip = document.createElement('button');
        chip.type = 'button';
        /* 任意のときは「全て許可」を表す on 表示。クリックで英数ベースに切替え除外。 */
        chip.className = 'cr-chip' + (isAny ? ' is-on is-anyon' : (allow.has(ch) ? ' is-on' : ' is-off'));
        chip.textContent = ch;
        chip.addEventListener('click', () => toggleChar(ch));
        row.appendChild(chip);
      }
      p.appendChild(row);
    });
  }

  function renderPreview() {
    $('crPreview').innerHTML = cur.len
      ? `<span class="cr-prev-lbl">設定内容</span> <b>${cur.len}桁</b> ・ ${esc(CharConstraint.describe(cur))}`
      : '<span class="cr-prev-lbl">設定内容</span> 制約なし';
  }

  /* ── 操作 ───────────────────────────────────────────── */
  function setBase(type) {
    cur.pos[sel] = CharConstraint.presetSet(type);   // any は ''
    renderAll();
  }
  function toggleChar(ch) {
    let setStr = cur.pos[sel];
    if (!setStr) setStr = visibleAlnum();             // 任意 → まず英数(可視)を土台に
    const set = new Set(setStr);
    if (set.has(ch)) set.delete(ch); else set.add(ch);
    cur.pos[sel] = CharConstraint.orderSet([...set].join(''));
    renderAll();
  }
  function applyAllPositions() {
    const v = cur.pos[sel];
    cur.pos = cur.pos.map(() => v);
    renderAll();
  }

  function save() {
    const rule = cur.len ? { len: cur.len, pos: cur.pos.slice() } : null;
    close();
    if (onSaveCb) onSaveCb(rule);
  }

  /* ── 初期化（モーダル内コントロールの配線） ─────────── */
  function init() {
    if (!$('crModal')) return;
    $('crClose').addEventListener('click', close);
    $('crCancel').addEventListener('click', close);
    $('crSave').addEventListener('click', save);
    $('crModal').addEventListener('click', e => { if (e.target === $('crModal')) close(); });

    $('crLenMinus').addEventListener('click', () => setLen(cur.len - 1));
    $('crLenPlus').addEventListener('click', () => setLen(cur.len + 1));
    $('crLen').addEventListener('change', () => setLen(parseInt($('crLen').value, 10)));
    $('crNoConstraint').addEventListener('click', () => setLen(0));
    $('crLenPresets').addEventListener('click', e => { const b = e.target.closest('button[data-len]'); if (b) setLen(parseInt(b.dataset.len, 10)); });

    $('crBaseTypes').addEventListener('click', e => { const b = e.target.closest('button[data-base]'); if (b) setBase(b.dataset.base); });
    $('crApplyAll').addEventListener('click', applyAllPositions);
    $('crToggleLower').addEventListener('click', () => { showLower = !showLower; renderEditor(); });
  }

  return { init, open };

})();
