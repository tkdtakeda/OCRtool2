# 帳票OCR統合ツール

帳票（発注書・請求書など）の画像／PDFから、登録したレイアウトに沿って
指定領域を自動でOCR認識するツールです。

OCR・画像マッチング（帳票の自動判定・傾き補正・罫線除去）はローカルで
動くPythonサーバーが処理し、それ以外（レイアウト登録・設定・文字制約・
判定しきい値・履歴・照合などの操作画面）はすべてブラウザ側で今まで通り
動きます。

## セットアップ

### 1. Tesseract OCR 本体をインストール

Pythonパッケージとは別に、OCRエンジン本体（Tesseract）が必要です。

- **Windows**: [UB-Mannheim版インストーラー](https://github.com/UB-Mannheim/tesseract/wiki) を使用。
  インストール時に「Additional language data」から **Japanese** をチェックしてください。
- **macOS**: `brew install tesseract tesseract-lang`
- **Linux (Debian/Ubuntu)**: `sudo apt install tesseract-ocr tesseract-ocr-jpn`

### 2. Pythonパッケージをインストール

Python 3.9以上が必要です。

```bash
pip install -r requirements.txt
```

これだけで動作します（コンパイラ等は不要です）。

### 3. （任意）文字別の確信度をより精密にする

OCR実行結果の「文字別の確信度」表示は、既定では単語単位の確信度を文字に
割り当てた近似値になります。以下を追加でインストールすると、文字1つ1つの
実際の確信度が使われるようになり、精度・速度とも向上します（Cコンパイラと
Tesseractの開発ヘッダが必要なため、環境によっては失敗することがあります。
失敗しても動作に問題はなく、既定の近似値表示になるだけです）。

```bash
pip install tesserocr
```

- Linux: あらかじめ `sudo apt install libtesseract-dev libleptonica-dev pkg-config` が必要です。
- macOS: Homebrewで入れた `tesseract` に開発ヘッダが含まれるため、通常はそのまま `pip install tesserocr` で通ります。
- Windows: 通常のpipでは入りにくいため、Anaconda/Minicondaをお使いの場合は
  `conda install -c conda-forge tesserocr` を試してください。難しければ
  インストールをスキップして構いません。

## 起動方法

**Windows**: `run.bat` をダブルクリックしてください。依存パッケージの確認
（初回のみ）→サーバー起動→ブラウザが自動で開く、まで行います。Pythonが
見つからない場合はインストール手順を案内して終了します。

**macOS / Linux（またはコマンドラインから起動したい場合）**:

```bash
python run_server.py
```

自動でブラウザが開きます（開かない場合は `http://127.0.0.1:5001/` へ
アクセスしてください）。終了するにはターミナル（`run.bat`の場合はその
ウィンドウ）で `Ctrl+C` を押します。

オプション:

```bash
python run_server.py --port 8080     # ポートを変更
python run_server.py --no-browser    # 起動時にブラウザを自動で開かない
```

サーバーは `127.0.0.1`（このPC内から）のみで待ち受けます。帳票には業務・
金銭情報が含まれることがあるため、外部からアクセスできるようにはしていません。

## トラブルシューティング

**`OCRエンジン（Tesseract）を初期化できませんでした` と表示されて起動しない**
Tesseract本体がインストールされていないか、PATHが通っていません。上記
「セットアップ 1」を確認してください。

**ブラウザで「サーバーに接続できませんでした」と出る**
`python run_server.py` を実行したままにしているか確認してください
（ターミナルを閉じるとサーバーも終了します）。ポートが他のアプリと
競合している場合は `--port` で変更してください。

**`pip install -r requirements.txt` が失敗する**
`requirements.txt` に含まれるパッケージはOSを問わずビルド不要な物のみ
なので、通常は失敗しません。失敗する場合はPythonのバージョン
（3.9以上を推奨）をご確認ください。

## 開発メモ

全ファイルこのフォルダ直下にフラットに置いています（サブフォルダなし）。

- `index.html` / `*.js` / `*.css` — 画面・設定・操作。帳票レイアウト等は
  これまで通りブラウザのIndexedDBに保存されます。
- `app.py` / `imaging.py` / `matcher.py` / `processor_server.py` /
  `ocr_server.py` — Pythonサーバー本体。`matcher.py`（画像マッチング）・
  `processor_server.py`（傾き補正・罫線除去）・`ocr_server.py`（OCR）が、
  対応する `matcher_engine.js` / `processor.js` / `ocr.js` の処理をそのまま
  引き継いでいます（アルゴリズム・設定項目とも変更していません。同名の
  `.js`ファイルと紛れないよう、JS側と役割が対応するPython側のうち
  ocr/processorには `_server` を付けています）。
- 判定しきい値（`voting.js`）や文字制約（`constraint.js`）などの
  ロジックはブラウザ側のまま変更していません。
- `run.bat` — Windows用の起動ランチャー（依存確認→`run_server.py`起動）。
