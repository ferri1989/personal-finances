@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instala Node.js 24 LTS o superior para abrir Mis Finanzas.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Preparando la aplicacion por primera vez...
  call npm ci --no-fund --no-audit
  if errorlevel 1 goto :failure
)
echo Preparando Mis Finanzas...
call npm run build
if errorlevel 1 goto :failure
call npm start
if errorlevel 1 goto :failure
exit /b 0
:failure
echo No se ha podido iniciar la aplicacion. Revisa el mensaje anterior.
pause
exit /b 1
