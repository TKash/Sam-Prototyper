@echo off
title Clip Proto
cd /d "%~dp0app"
echo.
echo   Clip Proto is starting. Your browser will open in a moment.
echo   Keep this window open while you use it; close it to stop Clip Proto.
echo.
set CLIP_PROTO_OPEN=1
"%~dp0runtime\windows\node.exe" server.js
echo.
pause
