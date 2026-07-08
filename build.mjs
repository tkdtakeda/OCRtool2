#!/usr/bin/env node
/* build.mjs  配布用の単一HTML(dist/index.html)を生成する。
   開発は index.html + 個別 JS/CSS ファイルのまま行う（差分レビューしやすいため）。
   配布したいときだけ `node build.mjs` を実行し、ローカルJS/CSSをインライン化した
   1ファイルを書き出す。OpenCV.js/Tesseract.js/pdf.js/フォント等のCDN参照はそのまま
   （ネット接続がある環境で開く想定）。
   ════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CSS_FILES = ['style.css', 'studio.css'];
const JS_FILES = [
  'processor.js', 'matcher_engine.js', 'ocr.js', 'constraint.js',
  'db.js', 'voting.js', 'recognizer.js', 'sample_forms.js',
  'studio_ui.js', 'charrule_editor.js', 'pdf_import.js', 'studio_app.js',
];
const OUT = 'dist/index.html';

let html = readFileSync('index.html', 'utf8');

const OLD_CSS_TAGS = '  <link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="studio.css">';
if (!html.includes(OLD_CSS_TAGS)) throw new Error('CSSの<link>タグが見つかりません（index.htmlの構成が変わった可能性）: ' + OLD_CSS_TAGS);
const cssBlock = CSS_FILES.map(f => `/* ===== ${f} ===== */\n${readFileSync(f, 'utf8')}`).join('\n');
html = html.replace(OLD_CSS_TAGS, `  <style>\n${cssBlock}\n  </style>`);

for (const f of JS_FILES) {
  const tag = `<script src="${f}"></script>`;
  if (!html.includes(tag)) throw new Error(`置換対象の<script>タグが見つかりません: ${tag}`);
  html = html.replace(tag, `<script>\n/* ===== ${f} ===== */\n${readFileSync(f, 'utf8')}\n</script>`);
}

mkdirSync('dist', { recursive: true });
writeFileSync(OUT, html);
console.log(`書き出しました: ${OUT} (${Math.round(html.length / 1024)} KB)`);
