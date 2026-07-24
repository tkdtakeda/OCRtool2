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
（`run.bat`自体の画面表示は、日本語版Windowsでの文字化け・誤動作を避ける
目的で英語表記にしています。動作内容はこの節の説明の通りです）

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

**`ProxyError` / `407` / `authentication required` と表示されて失敗する**
社内ネットワークなど、認証が必要なプロキシ経由でないとインターネットに
出られない環境です（パスワード無しではpipがPyPIに接続できません）。

1. 会社のIT部門に、社外（PyPI）へ出る際のプロキシのアドレス・ユーザー名・
   パスワードを確認してください（Windowsの「設定 → ネットワークと
   インターネット → プロキシ」に既に設定されている場合もあります）。
2. このフォルダに **`proxy.txt`** という名前のテキストファイルを作り、
   1行だけ次の形式で書いて保存してください（`run.bat`が自動で読み込みます。
   このファイルは`.gitignore`で除外済みなので誤って共有される心配は
   ありません）:
   ```
   http://ユーザー名:パスワード@プロキシのアドレス:ポート番号
   ```
   例: `http://taro:mypassword@proxy.example.co.jp:8080`
3. もう一度 `run.bat` を実行してください。
4. これでも失敗する場合、プロキシがNTLM/Kerberos認証（Windowsログインと
   連携する方式）専用の可能性があります。この場合は上記のシンプルな
   `ユーザー名:パスワード`形式では通らないため、IT部門に「Pythonの
   pipコマンドからプロキシを使う方法」を確認するか、自宅やスマートフォンの
   テザリングなど別のネットワークで一度だけ `pip install -r
   requirements.txt` を実行してみてください（一度インストールできれば、
   以後の起動はインターネット接続なしで動きます）。

**`WinError 32` / `別のプロセスが使用中です` と表示されて失敗する**
ダウンロードした`.whl`ファイルを、ウイルス対策ソフト等がスキャンのために
一瞬ロックしてしまうことによる、Windowsでよくある一時的な競合です。
`run.bat`は自動的に数秒待って3回まで再試行するため、大抵はそのまま
再実行すれば通ります。3回とも失敗する場合は、ウイルス対策ソフトの管理者に
このフォルダとPythonのインストール先フォルダをリアルタイムスキャンの
除外対象に加えてもらうか、`run.bat`をもう一度実行してみてください。

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
