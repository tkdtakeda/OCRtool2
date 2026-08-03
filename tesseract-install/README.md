# Tesseract OCR のインストール

このツールは文字認識（OCR）に **Tesseract** という無料のOCRエンジンを
使っています。Tesseractはこのツール（Pythonプログラム一式）とは別に、
お使いのパソコンへ単体でインストールしておく必要があります。

Python環境をお持ちでない方でも、このフォルダの案内だけで完結します。

## Windows

1. [UB-Mannheim版インストーラー](https://github.com/UB-Mannheim/tesseract/wiki) を開き、
   最新の64bit版インストーラー（`tesseract-ocr-w64-setup-*.exe`）をダウンロードします。
2. ダウンロードしたインストーラーを実行します。
3. インストール画面の途中で「Additional language data」という項目が
   出てきたら、**Japanese** にチェックを入れてください
   （日本語の帳票を読み取るために必須です）。
4. そのまま画面の指示に従ってインストールを完了してください。

## macOS

ターミナルで以下を実行してください（[Homebrew](https://brew.sh/) が必要です）。

```bash
brew install tesseract tesseract-lang
```

## Linux (Debian / Ubuntu)

```bash
sudo apt install tesseract-ocr tesseract-ocr-jpn
```

## インストールできているか確認する

ターミナル（Windowsの場合はコマンドプロンプト）で次を実行し、
バージョンらしき文字列が表示されればインストール完了です。

```
tesseract --version
```

## 補足

- Tesseractは無料・オープンソースのOCRエンジンで、本ツールとは別に
  配布されています（本ツールの一部ではありません）。
- 本ツール本体（Pythonプログラム）のセットアップ手順は、リポジトリ直下の
  `README.md` をご覧ください。
