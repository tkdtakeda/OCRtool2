/* ════════════════════════════════════════════════════════
   constraint.js  OCR領域ごとの「文字制約」エンジン
   Responsibility: 桁数＋桁ごとの許可文字（構造化ルール）を解釈し
     ① Tesseract へ渡すホワイトリストの導出（OCR出力の字種制限）
     ② OCR結果の桁別チェックと誤認補正（O↔0 等）
     ③ UI（文字制約エディタ）用の文字種ヘルパー・要約表示
   を行う確定的ロジックのみ。DOM操作・状態は持たない。
   ────────────────────────────────────────────────────────
   ルール形式（構造化・直感的に編集できる形）:
     { len: 6, pos: ["AR", "ABC…Z0…9", …] }
       len    … 文字数（桁数）。0/未設定 は「制約なし」
       pos[i] … i桁目に使える文字の集合（文字列）。'' は任意
   旧形式（文字列マスク 例 "[AR]X{5}"）も読み込み互換あり。
   ════════════════════════════════════════════════════════ */
'use strict';

const CharConstraint = (() => {

  /* ── 文字グループ ───────────────────────────────────── */
  const DIGITS = '0123456789';
  const UPPER  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER  = 'abcdefghijklmnopqrstuvwxyz';
  const ORDER  = DIGITS + UPPER + LOWER;   // 正規順（要約・整列に使用）

  /** ベース字種 → 文字集合（任意は ''） */
  function presetSet(type) {
    switch (type) {
      case 'digit':    return DIGITS;
      case 'upper':    return UPPER;
      case 'lower':    return LOWER;
      case 'alnum':    return UPPER + DIGITS;            // 英数（大文字）
      case 'alnumAll': return UPPER + LOWER + DIGITS;    // 英数（大小）
      case 'any': default: return '';
    }
  }

  /* ── よくあるOCR誤認の候補（補正用） ────────────────────
     キー=認識された文字 / 値=本来あり得る候補（優先順）。 */
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

  /* ── 集合ユーティリティ ─────────────────────────────── */
  /** 文字列を正規順に整列・重複除去（記号など ORDER 外は末尾へ） */
  function orderSet(chars) {
    const set = new Set(chars);
    let out = '';
    for (const c of ORDER) if (set.has(c)) out += c;
    for (const c of set) if (!ORDER.includes(c)) out += c;
    return out;
  }
  /** 2つの文字集合が等しいか */
  function sameSet(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    const sa = new Set(a), sb = new Set(b);
    if (sa.size !== sb.size) return false;
    for (const c of sa) if (!sb.has(c)) return false;
    return true;
  }

  /* ── 旧形式（文字列マスク）→ 構造化ルール（互換用） ─── */
  function maskUnit(ch) {
    switch (ch) {
      case '9': return DIGITS;
      case 'A': return UPPER;
      case 'a': return LOWER;
      case 'L': return UPPER + LOWER;
      case 'X': return UPPER + DIGITS;
      case 'x': return UPPER + LOWER + DIGITS;
      case '*': return '';            // 任意
      default:  return ch;            // 固定文字
    }
  }
  function expandBracket(body) {
    const set = new Set();
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '-' && i > 0 && i < body.length - 1) {
        const a = body.charCodeAt(i - 1), b = body.charCodeAt(i + 1);
        for (let cc = Math.min(a, b) + 1; cc <= Math.max(a, b); cc++) set.add(String.fromCharCode(cc));
        i++;
      } else set.add(c);
    }
    return [...set].join('');
  }
  function fromMask(spec) {
    if (typeof spec !== 'string') return null;
    const s = spec.trim();
    if (!s) return null;
    const pos = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t' || ch === '+') { i++; continue; }   // + 量子化は互換上スキップ
      let set;
      if (ch === '[') {
        const end = s.indexOf(']', i + 1);
        if (end < 0) return null;
        set = expandBracket(s.slice(i + 1, end));
        i = end + 1;
      } else { set = maskUnit(ch); i++; }
      let count = 1;
      if (s[i] === '{') {
        const end = s.indexOf('}', i + 1);
        if (end < 0) return null;
        const n = parseInt(s.slice(i + 1, end), 10);
        if (isFinite(n) && n > 0) count = n;
        i = end + 1;
      }
      for (let k = 0; k < count; k++) pos.push(set);
    }
    if (!pos.length) return null;
    return { len: pos.length, pos };
  }

  /**
   * 任意の入力（構造化ルール / 旧マスク文字列）を正規化する。
   * @returns {{ len:number, pos:string[] } | null}  制約なしは null
   */
  function normalize(rule) {
    if (!rule) return null;
    if (typeof rule === 'string') return normalize(fromMask(rule));
    const len = rule.len | 0;
    if (len <= 0 || !Array.isArray(rule.pos)) return null;
    const pos = [];
    for (let i = 0; i < len; i++) pos.push(typeof rule.pos[i] === 'string' ? rule.pos[i] : '');
    return { len, pos };
  }

  /** 制約が有効か（桁数1以上） */
  function isActive(rule) { return !!normalize(rule); }

  /* ── 1文字補正（許可集合に合うように寄せる） ─────────── */
  function correctChar(c, allow) {
    if (allow.has(c)) return c;
    if (c >= 'a' && c <= 'z' && allow.has(c.toUpperCase())) return c.toUpperCase();
    if (c >= 'A' && c <= 'Z' && allow.has(c.toLowerCase())) return c.toLowerCase();
    for (const cand of (CONFUSE[c] || [])) {
      if (allow.has(cand)) return cand;
      if (cand >= 'a' && cand <= 'z' && allow.has(cand.toUpperCase())) return cand.toUpperCase();
      if (cand >= 'A' && cand <= 'Z' && allow.has(cand.toLowerCase())) return cand.toLowerCase();
    }
    return null;
  }

  /**
   * 制約から Tesseract 用ホワイトリスト文字列を導出する。
   * 任意桁を含む等で制限できない場合は ''（=制限なし）。
   */
  function derivedWhitelist(rule) {
    const r = normalize(rule);
    if (!r) return '';
    const out = new Set();
    for (const s of r.pos) {
      if (!s) return '';                 // 任意桁あり → 制限不可
      for (const c of s) out.add(c);
    }
    return [...out].join('');
  }

  /**
   * OCR結果へ制約を適用（桁別チェック＋誤認補正）。
   * @returns {{ text:string, valid:boolean, applied:boolean }}
   */
  function apply(text, rule) {
    const r = normalize(rule);
    if (!r) return { text, valid: true, applied: false };
    const chars = [...String(text == null ? '' : text)];
    let valid = true;
    const out = [];
    for (let i = 0; i < chars.length; i++) {
      if (i >= r.len) { out.push(chars[i]); valid = false; continue; }   // 桁超過
      const s = r.pos[i];
      if (!s) { out.push(chars[i]); continue; }                          // 任意
      const fixed = correctChar(chars[i], new Set(s));
      if (fixed != null) out.push(fixed);
      else { out.push(chars[i]); valid = false; }
    }
    if (chars.length < r.len) valid = false;                             // 桁不足
    return { text: out.join(''), valid, applied: true };
  }

  /* ── 表示用の要約 ───────────────────────────────────── */
  /** 1桁の許可集合 → 短いラベル（例 '数字' '英数' 'A/R' '英数−O'） */
  function summarizePos(set) {
    if (!set) return '任意';
    const uniq = orderSet(set);
    if (sameSet(uniq, DIGITS)) return '数字';
    if (sameSet(uniq, UPPER))  return '英大';
    if (sameSet(uniq, LOWER))  return '英小';
    if (sameSet(uniq, UPPER + DIGITS))         return '英数';
    if (sameSet(uniq, UPPER + LOWER + DIGITS)) return '英数(小)';
    if ([...uniq].length <= 4) return [...uniq].join('/');
    /* 既知グループから数文字を除いた形 */
    for (const [g, name] of [[UPPER + DIGITS, '英数'], [UPPER, '英大'], [DIGITS, '数字'], [UPPER + LOWER + DIGITS, '英数(小)'], [LOWER, '英小']]) {
      const inG = [...uniq].every(c => g.includes(c));
      if (!inG) continue;
      const removed = [...g].filter(c => !uniq.includes(c));
      if (removed.length === 0) return name;
      if (removed.length <= 3) return `${name}−${removed.join('')}`;
    }
    return `${[...uniq].length}種`;
  }
  /** ルール全体 → 一行の説明（例 '1:A/R / 2:英数−O / 3:数字'） */
  function describe(rule) {
    const r = normalize(rule);
    if (!r) return '制約なし';
    return r.pos.map((s, i) => `${i + 1}:${summarizePos(s)}`).join(' / ');
  }

  return {
    DIGITS, UPPER, LOWER,
    presetSet, orderSet, sameSet,
    normalize, isActive, derivedWhitelist, apply, correctChar,
    summarizePos, describe, fromMask,
  };

})();
