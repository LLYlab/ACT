@echo off
rem LLMR WebUI 启动器 —— LLMR 的前端/后端都能独立运行，不依赖 DSH。
cd /d "%~dp0"
echo LLMR WebUI  http://127.0.0.1:8735/
node tools\llmr\server.cjs --port=8735
pause
