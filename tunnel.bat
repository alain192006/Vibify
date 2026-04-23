@echo off
echo.
echo  Lancement du tunnel HTTPS...
echo  Attends l'URL qui commence par https://
echo.
ssh -o StrictHostKeyChecking=no -R 80:127.0.0.1:8000 nokey@localhost.run
pause
