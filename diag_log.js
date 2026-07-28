/* ════════════════════════════════════════════════════════
   diag_log.js  診断ログの収集
   Responsibility: console.log の傍受とリングバッファ保持のみ。DOM 操作なし。
   ────────────────────────────────────────────────────────
   速度・精度の問題を報告する際、これまでは利用者がDevToolsを開き、[perf]や[align]
   などのログを自分で探してコピーする必要があった。その手間を無くすため、既存の
   console.log呼び出し（recognizer.js の [perf]/[align]、studio_app.js の
   [perf] p{n}・visibilitychange 等）をここで一箇所だけ傍受してバッファに残しておき、
   「診断情報をコピー」操作（studio_app.js側）が探すことなく取り出せるようにする。
   ページ内の他スクリプトより先に読み込むこと（呼び出しを1件も取りこぼさないため）。
   ════════════════════════════════════════════════════════ */
'use strict';

const DiagLog = (() => {

  const MAX_LINES = 500;
  const buf = [];
  const origLog = console.log.bind(console);

  console.log = (...args) => {
    origLog(...args);
    try {
      const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      buf.push(line);
      if (buf.length > MAX_LINES) buf.shift();
    } catch (_) { /* シリアライズ失敗（循環参照など）は診断バッファなので無視してよい */ }
  };

  /** 直近ログ（新しい順ではなく発生順）。n省略で全件。 */
  function recent(n = MAX_LINES) {
    return buf.slice(-n);
  }

  return { recent };

})();
