@echo off
rem ACT WebUI 启动器 —— ACT 的前端/后端都能独立运行，不依赖 DSH。
cd /d "%~dp0"
echo ACT WebUI  http://127.0.0.1:8735/
node tools\act\server.cjs --port=8735
pause
