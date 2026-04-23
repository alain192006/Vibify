@echo off
cd /d "%~dp0backend"
call ..\venv\Scripts\activate 2>nul || call ..\.venv\Scripts\activate 2>nul
echo.
echo  Vibify demarre...
echo  Ouvre sur ton tel : http://192.168.1.78:8000
echo.
uvicorn app.main:app --host 0.0.0.0 --port 8000
pause
