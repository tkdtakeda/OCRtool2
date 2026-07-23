@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  帳票OCR統合ツール
echo ============================================
echo.

echo [1/3] Pythonを確認しています...
set PYCMD=
for /f "delims=" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo %PYVER% | findstr /b /c:"Python " >nul
if not errorlevel 1 (
    set PYCMD=python
    goto :havepython
)

for /f "delims=" %%v in ('py --version 2^>^&1') do set PYVER=%%v
echo %PYVER% | findstr /b /c:"Python " >nul
if not errorlevel 1 (
    set PYCMD=py
    goto :havepython
)

echo.
echo [エラー] Python が見つかりませんでした。
echo   ・「python」コマンドはあるがストア版の案内が出る場合は、設定の
echo     「アプリ実行エイリアス」で python.exe / python3.exe をオフにしてから、
echo     https://www.python.org/downloads/ の公式インストーラーを使ってください。
echo   ・インストール時は必ず「Add python.exe to PATH」にチェックを入れてください。
echo   ・インストール後は一度このウィンドウを閉じ、run.bat を開き直してください。
goto :end

:havepython
echo   使用するPython: %PYCMD% ( %PYVER% )
echo.

echo [2/3] 依存パッケージを確認・インストールしています...
echo       （初回はダウンロードに数分かかることがあります。進捗が表示されます）
echo.
%PYCMD% -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [エラー] 依存パッケージのインストールに失敗しました。
    echo 上に表示されたメッセージ（赤字や ERROR で始まる行）をご確認ください。
    goto :end
)

echo.
echo [3/3] サーバーを起動します。
echo       終了するにはこのウィンドウを選んで Ctrl+C を押してください。
echo.
%PYCMD% run_server.py
echo.
echo サーバーが終了しました。

:end
echo.
echo ============================================
echo 何かキーを押すとこのウィンドウを閉じます。
echo （エラーが出た場合は、その内容を控えてご連絡ください）
echo ============================================
pause >nul
