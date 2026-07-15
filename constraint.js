/* ════════════════════════════════════════════════════════
   constraint.js  OCR領域ごとの「文字制約」エンジン
   Responsibility: 桁数＋桁ごとの許可文字（構造化ルール）を解釈し
     ① Tesseract へ渡すホワイトリストの導出（OCR出力の字種制限）
     ② OCR結果の桁別チェックと誤認補正（O↔0・一→1 等）
     ③ 値の前後にある余分な文字の自動除去（抽出）
     ④ UI（文字制約エディタ）用の文字種ヘルパー・要約表示
   を行う確定的ロジックのみ。DOM操作・状態は持たない。
   ────────────────────────────────────────────────────────
   ルール形式（構造化・直感的に編集できる形）:
     固定長  { len: 6, pos: ["AR", "ABC…Z0…9", …], extract?: bool }
     可変長  { variable: true, set: "0123456789", extract?: bool }
       len/pos … 各桁に使える文字（'' は任意）
       set     … 全桁共通で使える文字（桁数は不問）
       extract … 値の前後にある余分な文字を自動除去するか
   旧形式（文字列マスク 例 "[AR]X{5}"）も読み込み互換あり。
   ════════════════════════════════════════════════════════ */
'use strict';

const CharConstraint = (() => {

  /* ── 文字グループ ───────────────────────────────────── */
  const DIGITS = '0123456789';
  const UPPER  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER  = 'abcdefghijklmnopqrstuvwxyz';
  const ORDER  = DIGITS + UPPER + LOWER;   // 正規順（要約・整列に使用）
  const NUM_NOISE = ', 　，¥￥$\t';         // 数字欄で出るノイズ（桁区切り・空白・通貨）

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
     キー=認識された文字 / 値=本来あり得る候補（優先順）。
     形が似た取り違え＋日本語OCRで数字が漢字/記号になる例を含む。 */
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
    'Y': ['V', 'v'], 'V': ['Y'], 'v': ['Y'],
    /* 日本語OCRの数字誤認（漢数字・記号） */
    '一': ['1'], '〇': ['0'], '○': ['0'], '◯': ['0'], '２': ['2'],
  };

  /* ── 集合ユーティリティ ─────────────────────────────── */
  function orderSet(chars) {
    const set = new Set(chars);
    let out = '';
    for (const c of ORDER) if (set.has(c)) out += c;
    for (const c of set) if (!ORDER.includes(c)) out += c;
    return out;
  }
  function sameSet(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    const sa = new Set(a), sb = new Set(b);
    if (sa.size !== sb.size) return false;
    for (const c of sa) if (!sb.has(c)) return false;
    return true;
  }

  /* ── 旧形式（文字列マスク）→ 固定長ルール（互換用） ─── */
  function maskUnit(ch) {
    switch (ch) {
      case '9': return DIGITS;
      case 'A': return UPPER;
      case 'a': return LOWER;
      case 'L': return UPPER + LOWER;
      case 'X': return UPPER + DIGITS;
      case 'x': return UPPER + LOWER + DIGITS;
      case '*': return '';
      default:  return ch;
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
      if (ch === ' ' || ch === '\t' || ch === '+') { i++; continue; }
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
   * 任意の入力を正規化する。
   * subs/sub: ユーザーが桁ごとに管理できる独自の読み替え（例: OCRが"v"と読んだら"Y"扱い）。
   *   組み込みのCONFUSEテーブルより優先して参照される。
   * strict: 読み替え・CONFUSEのどちらでも直せない誤読を、読み取った文字のまま出す
   *   のではなく「?」に置き換えて必ず気づけるようにするか（桁ごとに指定可）。
   * @returns {{ variable:boolean, len?:number, pos?:string[], subs?:object[], strict?:boolean[],
   *             set?:string, sub?:object, extract:boolean } | null}
   */
  function normalize(rule) {
    if (!rule) return null;
    if (typeof rule === 'string') return normalize(fromMask(rule));
    const extract = !!rule.extract;
    const cloneMap = m => (m && typeof m === 'object') ? { ...m } : {};
    if (rule.variable) {
      const set = typeof rule.set === 'string' ? rule.set : '';
      if (!set) return null;
      return { variable: true, set, extract, sub: cloneMap(rule.sub), strict: !!rule.strict };
    }
    const len = rule.len | 0;
    if (len <= 0 || !Array.isArray(rule.pos)) return null;
    const pos = [], subs = [], strict = [];
    for (let i = 0; i < len; i++) {
      pos.push(typeof rule.pos[i] === 'string' ? rule.pos[i] : '');
      subs.push(cloneMap(rule.subs && rule.subs[i]));
      strict.push(!!(rule.strict && rule.strict[i]));
    }
    return { variable: false, len, pos, subs, strict, extract };
  }

  function isActive(rule) { return !!normalize(rule); }

  /** 許可文字がすべて ASCII（英数字・記号）か＝日本語不要か。
      true の領域は英語OCRモデルで認識した方が高精度（数字の「1」→「一」誤認を防ぐ）。 */
  function isLatinOnly(rule) {
    const r = normalize(rule);
    if (!r) return false;
    const chars = r.variable ? r.set : r.pos.join('');
    if (!chars) return false;
    for (const c of chars) if (c.charCodeAt(0) > 0x7F) return false;   // 非ASCII（日本語等）
    return true;
  }

  /* 空欄プレースホルダ: 読み替え・CONFUSEどちらでも直せず、かつstrict指定の桁で使う。
     普通の文字と混同されないよう半角記号1文字にする。 */
  const UNRESOLVED = '?';

  /* ── 1文字補正（許可集合に合うように寄せる） ─────────────
     customSubs（ユーザーがその桁専用に登録した読み替え）を、組み込みの
     CONFUSEテーブルより先に見る＝ユーザー設定が常に優先される。 */
  function correctChar(c, allow, customSubs) {
    if (allow.has(c)) return c;
    if (customSubs) {
      const mapped = customSubs[c];
      if (mapped !== undefined && allow.has(mapped)) return mapped;
    }
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
   * Tesseract 用ホワイトリスト文字列を導出する。
   * 任意桁を含む等で制限できない場合は ''（=制限なし）。
   */
  function derivedWhitelist(rule) {
    const r = normalize(rule);
    if (!r) return '';
    if (r.variable) return r.set;
    const out = new Set();
    for (const s of r.pos) {
      if (!s) return '';
      for (const c of s) out.add(c);
    }
    return [...out].join('');
  }

  /* 値の前後にある余分な文字を自動除去（抽出） */
  function extractStr(text, r) {
    const arr = [...String(text == null ? '' : text)];
    if (r.variable) {
      /* 使える文字（補正で寄せられる文字）だけ残し、区切り・空白などは捨てる */
      const setS = new Set(r.set);
      return arr.filter(c => correctChar(c, setS, r.sub) != null).join('');
    }
    /* 固定長: 制約に最も合う len 文字の窓を探す */
    const L = r.len;
    if (arr.length <= L) return arr.join('');
    let best = 0, bestScore = -1;
    for (let i = 0; i + L <= arr.length; i++) {
      let sc = 0;
      for (let k = 0; k < L; k++) {
        const s = r.pos[k];
        if (!s || correctChar(arr[i + k], new Set(s), r.subs[k]) != null) sc++;
      }
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    return arr.slice(best, best + L).join('');
  }

  /**
   * OCR結果へ制約を適用（抽出 → 桁別チェック＋誤認補正）。
   * @returns {{ text:string, valid:boolean, applied:boolean }}
   */
  function apply(text, rule) {
    const r = normalize(rule);
    if (!r) return { text, valid: true, applied: false };
    let chars = [...String(text == null ? '' : text)];
    if (r.extract) chars = [...extractStr(chars.join(''), r)];

    if (r.variable) {
      const setS = new Set(r.set);
      /* 数字のみの欄では、桁区切り(,)・空白・通貨記号は常にノイズとして除去
         （「201,300」→「201300」。元の値に含めたい場合は記号を許可文字に追加） */
      const numeric = r.set.length > 0 && [...r.set].every(c => c >= '0' && c <= '9');
      let valid = true;
      const out = [];
      for (const c of chars) {
        if (numeric && !setS.has(c) && NUM_NOISE.includes(c)) continue;   // 桁区切り等を除去
        const f = correctChar(c, setS, r.sub);
        if (f != null) out.push(f); else { out.push(r.strict ? UNRESOLVED : c); valid = false; }
      }
      if (!out.length) valid = false;
      return { text: out.join(''), valid, applied: true };
    }

    let valid = true;
    const out = [];
    for (let i = 0; i < chars.length; i++) {
      if (i >= r.len) { out.push(chars[i]); valid = false; continue; }
      const s = r.pos[i];
      if (!s) { out.push(chars[i]); continue; }
      const fixed = correctChar(chars[i], new Set(s), r.subs[i]);
      if (fixed != null) out.push(fixed);
      else { out.push(r.strict[i] ? UNRESOLVED : chars[i]); valid = false; }
    }
    if (chars.length < r.len) valid = false;
    return { text: out.join(''), valid, applied: true };
  }

  /* ── 表示用の要約 ───────────────────────────────────── */
  function summarizePos(set) {
    if (!set) return '任意';
    const uniq = orderSet(set);
    if (sameSet(uniq, DIGITS)) return '数字';
    if (sameSet(uniq, UPPER))  return '英大';
    if (sameSet(uniq, LOWER))  return '英小';
    if (sameSet(uniq, UPPER + DIGITS))         return '英数';
    if (sameSet(uniq, UPPER + LOWER + DIGITS)) return '英数(小)';
    if ([...uniq].length <= 4) return [...uniq].join('/');
    for (const [g, name] of [[UPPER + DIGITS, '英数'], [UPPER, '英大'], [DIGITS, '数字'], [UPPER + LOWER + DIGITS, '英数(小)'], [LOWER, '英小']]) {
      const inG = [...uniq].every(c => g.includes(c));
      if (!inG) continue;
      const removed = [...g].filter(c => !uniq.includes(c));
      if (removed.length === 0) return name;
      if (removed.length <= 3) return `${name}−${removed.join('')}`;
    }
    /* 既知グループ＋記号（例 数字+- ）。大きいグループ優先で余りを最小化 */
    for (const [g, name] of [[UPPER + LOWER + DIGITS, '英数(小)'], [UPPER + DIGITS, '英数'], [UPPER, '英大'], [DIGITS, '数字'], [LOWER, '英小']]) {
      const hasAll = [...g].every(c => uniq.includes(c));
      if (!hasAll) continue;
      const extra = [...uniq].filter(c => !g.includes(c));
      if (extra.length && extra.length <= 3) return `${name}+${extra.join('')}`;
    }
    return `${[...uniq].length}種`;
  }
  /** 桁数ラベル（'5桁' / '可変長'） */
  function lengthLabel(rule) {
    const r = normalize(rule);
    if (!r) return '';
    return r.variable ? '可変長' : `${r.len}桁`;
  }
  /** ルール全体 → 一行の説明（桁数ラベルとは別に内容のみ）。
      独自読み替え・厳格モードを設定していれば、一覧でも気付けるよう件数を添える。 */
  function describe(rule) {
    const r = normalize(rule);
    if (!r) return '制約なし';
    const body = r.variable ? summarizePos(r.set)
                            : r.pos.map((s, i) => `${i + 1}:${summarizePos(s)}`).join(' / ');
    const subsCount = r.variable ? Object.keys(r.sub).length : r.subs.reduce((n, s) => n + Object.keys(s).length, 0);
    const hasStrict = r.variable ? r.strict : r.strict.some(Boolean);
    let out = r.extract ? `${body}（前後除去）` : body;
    if (subsCount) out += ` ・読替${subsCount}`;
    if (hasStrict) out += ' ・厳格';
    return out;
  }

  return {
    DIGITS, UPPER, LOWER,
    presetSet, orderSet, sameSet,
    normalize, isActive, isLatinOnly, derivedWhitelist, apply, correctChar, extractStr,
    summarizePos, lengthLabel, describe, fromMask,
  };

})();
