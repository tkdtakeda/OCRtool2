@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  帳票OCR統合ツール
echo ============================================
echo.

set PYCMD=python
where python >nul 2>nul
if errorlevel 1 (
    where py >nul 2>nul
    if errorlevel 1 (
        echo [エラー] Python が見つかりません。
        echo https://www.python.org/downloads/ からインストールしてください。
        echo インストール時に「Add python.exe to PATH」に必ずチェックを入れてください。
        echo.
        pause
        exit /b 1
    )
    set PYCMD=py
)

echo 依存パッケージを確認しています（初回のみ少し時間がかかります）...
%PYCMD% -m pip install -q -r requirements.txt
if errorlevel 1 (
    echo.
    echo [エラー] 依存パッケージのインストールに失敗しました。
    echo 上に表示されたメッセージを確認するか、README.md をご覧ください。
    echo.
    pause
    exit /b 1
)

echo.
echo サーバーを起動します。終了するにはこのウィンドウで Ctrl+C を押してください。
echo.
%PYCMD% run_server.py

echo.
echo サーバーが終了しました。
pause
