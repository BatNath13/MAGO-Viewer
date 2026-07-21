$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$LAUNCHER = Join-Path $ROOT "launcher"

cd $LAUNCHER
python -m pip install pyinstaller
python -m PyInstaller --clean --noconfirm MAGO.spec

Write-Host "EXE cree : $LAUNCHER\dist\MAGO.exe"
Write-Host "Tu peux relancer INSTALLER_ICONE_MAGO_VIEWER.ps1 pour que le raccourci pointe sur l'exe."
