@echo off
setlocal
cd /d %~dp0
chcp 65001 >nul
set PATH=%CD%\tools\node-v22.22.3-win-x64;%PATH%
if not exist node_modules (
  echo [workbench] 正在安装依赖，请稍候...
  call npm.cmd install
  if errorlevel 1 goto :fail
)
echo [workbench] 正在启动阅片工作台...
call npm.cmd run dev
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo [workbench] 启动失败，请检查终端输出。
pause
