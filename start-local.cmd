@echo off
cd /d "%~dp0"
if not exist "node_modules\ws" call npm.cmd install
call npm.cmd start
pause
