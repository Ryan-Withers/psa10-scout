@echo off
setlocal enabledelayedexpansion
REM ---------------------------------------------------------------------
REM  Everything from "empty GitHub account" to "first scan running".
REM
REM  Replaces steps 1 through 6 of GITHUB-SETUP.md. Uses GitHub's own CLI,
REM  so the repo, the push, all five secrets, the dry-run flag and the first
REM  run happen here rather than through fifteen minutes of clicking.
REM
REM  Safe to re-run. Every step checks whether it has already been done.
REM  Nothing is deleted and nothing is sent to anyone but GitHub.
REM ---------------------------------------------------------------------

cd /d "%~dp0"
echo.
echo   PSA 10 scout, cloud setup
echo   =========================
echo.

REM ---------- prerequisites ----------

git --version >nul 2>&1
if errorlevel 1 (
  echo   git is missing. Install it, then run this again:
  echo     https://git-scm.com/download/win
  echo.
  pause & exit /b 1
)

gh --version >nul 2>&1
if errorlevel 1 (
  echo   GitHub's command line tool is missing. Installing it now.
  echo.
  winget install --id GitHub.cli --accept-source-agreements --accept-package-agreements
  echo.
  echo   Installed. Windows needs a fresh window to see it.
  echo   CLOSE THIS WINDOW, open a new Command Prompt, and run this again:
  echo     cd /d C:\psa10-scout ^&^& setup-cloud.cmd
  echo.
  pause & exit /b 0
)

REM ---------- sign in ----------

gh auth status >nul 2>&1
if errorlevel 1 (
  echo   [1/7] Signing in to GitHub. A browser will open.
  gh auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 goto :fail
) else (
  echo   [1/7] Already signed in to GitHub.
)

for /f "delims=" %%A in ('gh api user --jq .login 2^>nul') do set "GHUSER=%%A"
if not defined GHUSER goto :fail
echo         Signed in as !GHUSER!

REM ---------- git identity ----------

for /f "delims=" %%A in ('git config --global user.name 2^>nul') do set "HAVENAME=%%A"
if not defined HAVENAME (
  git config --global user.name "!GHUSER!"
  git config --global user.email "!GHUSER!@users.noreply.github.com"
)

REM ---------- repo ----------

echo   [2/7] Repository
gh repo view !GHUSER!/psa10-scout >nul 2>&1
if errorlevel 1 (
  git add -A >nul 2>&1
  git commit -m "PSA 10 scout" >nul 2>&1
  git branch -M main >nul 2>&1
  gh repo create psa10-scout --public --source=. --remote=origin --push
  if errorlevel 1 goto :fail
  echo         Created and pushed.
) else (
  echo         Already exists, pushing any changes.
  git add -A >nul 2>&1
  git commit -m "update" >nul 2>&1
  git branch -M main >nul 2>&1
  git remote remove origin >nul 2>&1
  git remote add origin "https://github.com/!GHUSER!/psa10-scout.git"
  git push -u origin main
  if errorlevel 1 goto :fail
)

REM ---------- secrets ----------
REM  Piped on stdin rather than passed as an argument, so the values never
REM  appear in a command line that Windows records in history.

echo   [3/7] Secrets. Paste each value and press Enter.
echo.
call :secret EBAY_CLIENT_ID      "eBay App ID (starts RyanWith-)"
call :secret EBAY_CLIENT_SECRET  "eBay Cert ID (starts PRD-)"
call :secret RESEND_API_KEY      "Resend API key (starts re_)"
call :secret ALERT_TO            "Email address to send alerts TO"
echo.
echo         ALERT_FROM must be a name then the address in angle brackets,
echo         for example:  PSA 10 Scout ^<scout@yourdomain.com^>
echo         The address has to be on a domain verified in Resend.
call :secret ALERT_FROM          "Sender, in that form"

REM ---------- dry run flag ----------

echo   [4/7] Muting the first run so it cannot email you yet
echo 1| gh variable set ALERT_DRY_RUN >nul 2>&1
if errorlevel 1 (echo         could not set the variable, carrying on) else (echo         done)

REM ---------- kick it off ----------

echo   [5/7] Starting a full sweep
gh workflow run scan.yml -f full=true
if errorlevel 1 goto :fail
echo         queued, waiting for it to appear
timeout /t 10 /nobreak >nul

REM ---------- watch ----------

REM Watch the run we just started by id. A bare "gh run watch" asks which
REM run you mean when more than one is live, and a question with nobody to
REM answer it hangs the script forever.
set "RUNID="
for /f "delims=" %%A in ('gh run list --workflow=scan.yml --limit 1 --json databaseId --jq ".[0].databaseId" 2^>nul') do set "RUNID=%%A"

echo   [6/7] Watching the run. This takes about 3 minutes.
echo.
if defined RUNID (
  gh run watch !RUNID! --exit-status
) else (
  echo         could not find the run id, check the Actions tab on github.com
)
set "RUNRESULT=!errorlevel!"

echo.
echo   [7/7] Result
if "!RUNRESULT!"=="0" (
  echo         The scan succeeded.
  echo.
  echo   See what it found:
  echo     gh run view --log ^| findstr /C:"listings" /C:"searches" /C:"STRONG BUY"
  echo.
  echo   Download the full report and the email preview:
  echo     gh run download
  echo.
  echo   When you are happy, turn emails on:
  echo     gh variable delete ALERT_DRY_RUN
  echo.
  echo   Then do step 7 in GITHUB-SETUP.md for exact 20 minute timing.
) else (
  echo         The scan failed. See what went wrong:
  echo     gh run view --log-failed
  echo.
  echo   Send me that output.
)
echo.
pause
exit /b 0

REM ---------- helpers ----------

:secret
REM enabledelayedexpansion matters here. A plain setlocal would leave the
REM !VALUE! below unexpanded and pipe the literal text "!VALUE!" into gh,
REM setting every secret to nonsense while reporting success.
setlocal enabledelayedexpansion
set "NAME=%~1"
set "PROMPT=%~2"
gh secret list 2>nul | findstr /B /C:"%NAME%" >nul
if not errorlevel 1 (
  echo         %NAME% is already set, skipping
  endlocal & exit /b 0
)
set "VALUE="
set /p VALUE=        %PROMPT%:
if not defined VALUE (
  echo         nothing entered, skipping %NAME%
  endlocal & exit /b 0
)
echo !VALUE!| gh secret set %NAME% >nul 2>&1
if errorlevel 1 (echo         FAILED to set %NAME%) else (echo         %NAME% set)
endlocal & exit /b 0

:fail
echo.
echo   That step failed. Copy the text above and send it to Claude.
echo.
pause
exit /b 1
