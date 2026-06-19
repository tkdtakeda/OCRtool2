/* ════════════════════════════════════════════════════════
   constraint.js  OCR領域ごとの「文字制約」エンジン
   Responsibility: 位置別の文字種マスクを解釈し
     ① Tesseract へ渡すホワイトリストの導出（OCR出力の字種制限）
     ② OCR結果の位置別チェックと誤認補正（O↔0 等）
   を行う確定的ロジックのみ。DOM操作・状態は持たない。
   ────────────────────────────────────────────────────────
   マスク記法（左から1文字ずつ対応・空白は無視）:
     9   数字            [0-9]
     A   英大文字        [A-Z]
     a   英小文字        [a-z]
     L   英字            [A-Za-z]
     X   英数字(大)      [A-Z0-9]
     x   英数字          [A-Za-z0-9]
     *   任意（制限なし）
     [..] 指定文字       例 [AR] / [A-Z0-9] / [-/.]
     その他の文字は「その文字そのもの」を表す固定文字（例: - / .）
   量指定:
     {n}  直前トークンを n 文字ぶん繰り返す（例 X{5}）
     +    直前トークンを残り全文字に適用（可変長。例 9+ = 数字1文字以上）
   例「1文字目はA,R / 2〜6文字目は英数字」 → [AR]X{5}
   ════════════════════════════════════════════════════════ */
'use strict';

const CharConstraint = (() => {

  /* ── よくあるOCR誤認の候補（補正用） ────────────────────
     キー=認識された文字 / 値=本来あり得る候補（優先順）。
     「その位置で許可される字種」に合致する候補があれば置換する。 */
  const CONFUSE = {
    '0': ['O', 'D', 'Q', 'o'], 'O': ['0'], 'o': ['0'], 'Q': ['0'], 'D': ['0'],
    '1': ['I', 'l', '|'], 'I': ['1'], 'l': ['1'], '|': ['1'], 'i': ['1'], '!': ['1'],
    '2': ['Z'], 'Z': ['2'],
    '3': ['8'],
    '4': ['A'], 'A': ['4'],
    '5': ['S'], 'S': ['5'], 's': ['5'],
    '6': ['G', 'b'], 'G': ['6'], 'b': ['6'],
    '7': ['T'], 'T': ['7'],
    '8': ['B'], 'B': ['8'],
    '9': ['g', 'q'], 'g': ['9'], 'q': ['9'],
  };

  /* 文字集合の生成ヘルパー */
  function range(from, to) {
    const s = new Set();
    for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) s.add(String.fromCharCode(c));
    return s;
  }
  const DIGIT = range('0', '9');
  const UPPER = range('A', 'Z');
  const LOWER = range('a', 'z');
  const union = (...sets) => { const o = new Set(); sets.forEach(s => s.forEach(c => o.add(c))); return o; };

  /* 1文字トークン → 許可集合（null = 任意） */
  function unitSet(ch) {
    switch (ch) {
      case '9': return new Set(DIGIT);
      case 'A': return new Set(UPPER);
      case 'a': return new Set(LOWER);
      case 'L': return union(UPPER, LOWER);
      case 'X': return union(UPPER, DIGIT);
      case 'x': return union(UPPER, LOWER, DIGIT);
      case '*': return null;                 // 任意
      default:  return new Set([ch]);        // 固定文字
    }
  }

  /* [..] の中身を展開（A-Z のような範囲指定に対応） */
  function expandSet(body) {
    const set = new Set();
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '-' && i > 0 && i < body.length - 1) {
        const a = body.charCodeAt(i - 1), b = body.charCodeAt(i + 1);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let cc = lo + 1; cc <= hi; cc++) set.add(String.fromCharCode(cc));
        i++;                                  // 範囲終端は処理済み
      } else {
        set.add(c);
      }
    }
    return set;
  }

  /**
   * マスク文字列を解析する。
   * @returns {{ positions: Array<Set<string>|null>, repeatLast: boolean } | null}
   *   positions[i] = i文字目の許可集合（null は任意）。
   *   repeatLast=true のとき最後の集合を残り全文字へ適用（可変長）。
   *   空・不正な記法は null。
   */
  function parse(spec) {
    if (!spec || typeof spec !== 'string') return null;
    const s = spec.trim();
    if (!s) return null;
    const positions = [];
    let repeatLast = false;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t') { i++; continue; }
      /* 単位（[..] か 1文字トークン） */
      let set;
      if (ch === '[') {
        const end = s.indexOf(']', i + 1);
        if (end < 0) return null;             // 閉じ括弧なし
        set = expandSet(s.slice(i + 1, end));
        if (!set.size) return null;
        i = end + 1;
      } else {
        set = unitSet(ch);
        i++;
      }
      /* 量指定 {n} */
      let count = 1;
      if (s[i] === '{') {
        const end = s.indexOf('}', i + 1);
        if (end < 0) return null;
        const n = parseInt(s.slice(i + 1, end), 10);
        if (isFinite(n) && n > 0) count = n;
        i = end + 1;
      }
      for (let k = 0; k < count; k++) positions.push(set);
      /* 可変長マーカー + （以降は無視） */
      if (s[i] === '+') { repeatLast = true; i++; break; }
    }
    if (!positions.length) return null;
    return { positions, repeatLast };
  }

  /** その位置の許可集合に合うよう1文字を補正（できなければ null） */
  function correctChar(c, set) {
    if (set.has(c)) return c;
    /* 大文字小文字の取り違え（高確度） */
    if (c >= 'a' && c <= 'z' && set.has(c.toUpperCase())) return c.toUpperCase();
    if (c >= 'A' && c <= 'Z' && set.has(c.toLowerCase())) return c.toLowerCase();
    /* 形が似た文字の取り違え */
    for (const cand of (CONFUSE[c] || [])) {
      if (set.has(cand)) return cand;
      if (cand >= 'a' && cand <= 'z' && set.has(cand.toUpperCase())) return cand.toUpperCase();
      if (cand >= 'A' && cand <= 'Z' && set.has(cand.toLowerCase())) return cand.toLowerCase();
    }
    return null;
  }

  /**
   * 制約から Tesseract 用ホワイトリスト文字列を導出する。
   * 任意(*)を含む等で制限できない場合は ''（=制限なし）を返す。
   */
  function derivedWhitelist(spec) {
    const m = parse(spec);
    if (!m) return '';
    const out = new Set();
    for (const set of m.positions) {
      if (set === null) return '';            // 任意位置あり → 制限不可
      set.forEach(c => out.add(c));
    }
    return [...out].join('');
  }

  /**
   * OCR結果へ制約を適用（位置別チェック＋誤認補正）。
   * @returns {{ text:string, valid:boolean, applied:boolean }}
   *   applied=false は制約未設定/不正記法（無加工）。
   *   valid=false は補正しても制約を満たせなかった（桁数違い含む）。
   */
  function apply(text, spec) {
    const m = parse(spec);
    if (!m) return { text, valid: true, applied: false };
    const chars = [...String(text == null ? '' : text)];
    const last = m.positions[m.positions.length - 1];
    let valid = true;
    const out = [];
    for (let i = 0; i < chars.length; i++) {
      let set;
      if (i < m.positions.length) set = m.positions[i];
      else if (m.repeatLast) set = last;
      else { out.push(chars[i]); valid = false; continue; }   // 規定長を超過
      if (set === null) { out.push(chars[i]); continue; }      // 任意
      const fixed = correctChar(chars[i], set);
      if (fixed != null) out.push(fixed);
      else { out.push(chars[i]); valid = false; }
    }
    if (chars.length < m.positions.length) valid = false;       // 桁不足
    return { text: out.join(''), valid, applied: true };
  }

  return { parse, derivedWhitelist, apply, correctChar };

})();
