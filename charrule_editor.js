/* ════════════════════════════════════════════════════════
   charrule_editor.js  文字制約ビジュアルエディタ（モーダル）
   Responsibility: 「桁数を決める → 各桁に使える文字を選ぶ」操作を
     直感的に行うUI。固定長／可変長／制約なしを切り替えられ、
     値の前後にある余分な文字の自動除去（抽出）もチェック1つで指定可能。
     状態は本モジュール内に閉じ、確定時に onSave(rule|null) を呼ぶだけ。
   ════════════════════════════════════════════════════════ */
'use strict';

const CharRuleEditor = (() => {

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* cur.mode: 'fixed' | 'variable' | 'none'
     fixed   → len + pos[]、variable → set、共通 → extract */
  let cur = { mode: 'fixed', len: 4, pos: [], set: '', extract: false };
  let sel = 0;              // 選択中の桁（固定長時）
  let showLower = false;    // 小文字パレット表示
  let onSaveCb = null;

  const DEF = () => CharConstraint.presetSet('alnum');             // 新規桁の既定＝英数
  const visAlnum = () => CharConstraint.presetSet(showLower ? 'alnumAll' : 'alnum');
  const SYMBOLS = ['-', '/', '.', ':', '(', ')', '#', '&', ' '];   // 区切り・記号（' '=空白）

  /* ── 公開: 開く ─────────────────────────────────────── */
  function open(fieldName, rule, onSave) {
    onSaveCb = onSave;
    const n = CharConstraint.normalize(rule);
    if (n && n.variable) {
      cur = { mode: 'variable', len: 4, pos: Array.from({ length: 4 }, DEF), set: n.set, extract: n.extract };
    } else if (n) {
      cur = { mode: 'fixed', len: n.len, pos: n.pos.slice(), set: CharConstraint.presetSet('digit'), extract: n.extract };
    } else {
      cur = { mode: 'fixed', len: 4, pos: Array.from({ length: 4 }, DEF), set: CharConstraint.presetSet('digit'), extract: false };
    }
    sel = 0;
    showLower = cur.pos.some(s => /[a-z]/.test(s)) || /[a-z]/.test(cur.set);
    $('crFieldName').textContent = fieldName ? `「${fieldName}」` : '';
    $('crModal').classList.remove('hidden');
    renderAll();
  }
  function close() { $('crModal').classList.add('hidden'); }

  /* 現在編集対象の文字集合（固定=選択桁 / 可変=全桁共通） */
  function activeSet() { return cur.mode === 'variable' ? cur.set : (cur.pos[sel] || ''); }
  function setActive(v) { if (cur.mode === 'variable') cur.set = v; else cur.pos[sel] = v; }

  /* ── モード切替 ─────────────────────────────────────── */
  function setLenFixed(n) {
    n = Math.max(0, Math.min(20, Math.floor(n || 0)));
    if (!n) { cur.mode = 'none'; renderAll(); return; }
    cur.mode = 'fixed';
    const pos = cur.pos.slice(0, n);
    while (pos.length < n) pos.push(DEF());
    cur.pos = pos; cur.len = n;
    if (sel >= n) sel = Math.max(0, n - 1);
    renderAll();
  }
  function setVariable() { cur.mode = 'variable'; if (!cur.set) cur.set = CharConstraint.presetSet('digit'); renderAll(); }
  function setNone() { cur.mode = 'none'; renderAll(); }

  /* ── 描画 ───────────────────────────────────────────── */
  function renderAll() { renderLenCtl(); renderPositions(); renderEditor(); renderPreview(); }

  function renderLenCtl() {
    $('crLen').value = cur.mode === 'fixed' ? cur.len : '';
    $('crLen').disabled = cur.mode !== 'fixed';
    $('crVarToggle').classList.toggle('is-active', cur.mode === 'variable');
  }

  function renderPositions() {
    const c = $('crPositions'); c.innerHTML = '';
    if (cur.mode === 'none') { c.innerHTML = '<div class="cr-empty">「制約なし」です。文字数を1以上にするか「可変長」を選ぶと、使える文字を指定できます。</div>'; return; }
    if (cur.mode === 'variable') { c.innerHTML = '<div class="cr-empty cr-var-note"><i class="fas fa-arrows-left-right"></i> 可変長（文字数は不問）。下で「使える文字」を指定します。</div>'; return; }
    for (let i = 0; i < cur.len; i++) {
      const tile = document.createElement('button'); tile.type = 'button';
      tile.className = 'cr-tile' + (i === sel ? ' is-sel' : '');
      tile.innerHTML = `<span class="cr-tile-no">${i + 1}</span><span class="cr-tile-sum">${esc(CharConstraint.summarizePos(cur.pos[i]))}</span>`;
      tile.addEventListener('click', () => { sel = i; renderAll(); });
      c.appendChild(tile);
    }
  }

  function renderEditor() {
    const wrap = $('crEditor');
    if (cur.mode === 'none') { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    $('crEditTitle').textContent = cur.mode === 'variable' ? '使える文字（全桁共通）' : `${sel + 1}桁目`;
    const setStr = activeSet();
    document.querySelectorAll('#crBaseTypes [data-base]').forEach(b => {
      const ps = CharConstraint.presetSet(b.dataset.base);
      const active = b.dataset.base === 'any' ? !setStr : CharConstraint.sameSet(setStr, ps);
      b.classList.toggle('is-active', active);
    });
    renderPalette();
    $('crToggleLower').classList.toggle('is-active', showLower);
    $('crApplyAll').style.display = cur.mode === 'fixed' ? '' : 'none';
    $('crExtract').checked = !!cur.extract;
    $('crPosSummary').textContent = setStr
      ? `使用可: ${[...setStr].length}文字（${CharConstraint.summarizePos(setStr)}）`
      : '任意（すべての文字を許可）';
    $('crAnyNote').style.display = setStr ? 'none' : '';
  }

  function renderPalette() {
    const p = $('crPalette'); p.innerHTML = '';
    const setStr = activeSet();
    const isAny = !setStr;
    const allow = new Set(setStr);
    const groups = [['数字', [...CharConstraint.DIGITS]], ['英大', [...CharConstraint.UPPER]]];
    if (showLower) groups.push(['英小', [...CharConstraint.LOWER]]);
    groups.push(['記号', SYMBOLS]);          // 区切り記号（- / . など）も指定できる
    groups.forEach(([label, chars]) => {
      const row = document.createElement('div'); row.className = 'cr-prow';
      const lab = document.createElement('span'); lab.className = 'cr-prow-lab'; lab.textContent = label;
      row.appendChild(lab);
      for (const ch of chars) {
        const chip = document.createElement('button'); chip.type = 'button';
        chip.className = 'cr-chip' + (isAny ? ' is-on is-anyon' : (allow.has(ch) ? ' is-on' : ' is-off'));
        chip.textContent = ch === ' ' ? '␣' : ch;
        if (ch === ' ') chip.title = '空白';
        chip.addEventListener('click', () => toggleChar(ch));
        row.appendChild(chip);
      }
      p.appendChild(row);
    });
  }

  function renderPreview() {
    let txt;
    if (cur.mode === 'none') txt = '制約なし';
    else if (cur.mode === 'variable') txt = `可変長 ・ ${CharConstraint.describe({ variable: true, set: cur.set, extract: cur.extract })}`;
    else txt = `${cur.len}桁 ・ ${CharConstraint.describe({ len: cur.len, pos: cur.pos, extract: cur.extract })}`;
    $('crPreview').innerHTML = `<span class="cr-prev-lbl">設定内容</span> ${esc(txt)}`;
  }

  /* ── 操作 ───────────────────────────────────────────── */
  function setBase(type) { setActive(CharConstraint.presetSet(type)); renderAll(); }
  function toggleChar(ch) {
    let setStr = activeSet();
    if (!setStr) setStr = visAlnum();                 // 任意 → まず英数(可視)を土台に
    const set = new Set(setStr);
    if (set.has(ch)) set.delete(ch); else set.add(ch);
    setActive(CharConstraint.orderSet([...set].join('')));
    renderAll();
  }
  function applyAllPositions() {
    if (cur.mode !== 'fixed') return;
    const v = cur.pos[sel];
    cur.pos = cur.pos.map(() => v);
    renderAll();
  }

  function save() {
    let rule = null;
    if (cur.mode === 'fixed' && cur.len) rule = { len: cur.len, pos: cur.pos.slice(), extract: cur.extract };
    else if (cur.mode === 'variable' && cur.set) rule = { variable: true, set: cur.set, extract: cur.extract };
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

    $('crLenMinus').addEventListener('click', () => setLenFixed((cur.mode === 'fixed' ? cur.len : 0) - 1));
    $('crLenPlus').addEventListener('click', () => setLenFixed((cur.mode === 'fixed' ? cur.len : 0) + 1));
    $('crLen').addEventListener('change', () => setLenFixed(parseInt($('crLen').value, 10)));
    $('crLenPresets').addEventListener('click', e => { const b = e.target.closest('button[data-len]'); if (b) setLenFixed(parseInt(b.dataset.len, 10)); });
    $('crVarToggle').addEventListener('click', setVariable);
    $('crNoConstraint').addEventListener('click', setNone);

    $('crBaseTypes').addEventListener('click', e => { const b = e.target.closest('button[data-base]'); if (b) setBase(b.dataset.base); });
    $('crApplyAll').addEventListener('click', applyAllPositions);
    $('crToggleLower').addEventListener('click', () => { showLower = !showLower; renderEditor(); });
    $('crExtract').addEventListener('change', () => { cur.extract = $('crExtract').checked; renderPreview(); });
  }

  return { init, open };

})();
