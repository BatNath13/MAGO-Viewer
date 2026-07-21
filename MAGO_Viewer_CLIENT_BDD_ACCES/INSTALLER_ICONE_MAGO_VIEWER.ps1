$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$LAUNCHER = Join-Path $ROOT "launcher"
$SCRIPT = Join-Path $LAUNCHER "mago_launch.py"
$EXE = Join-Path $LAUNCHER "dist\MAGO.exe"
$ICON = Join-Path $LAUNCHER "MAGO_viewer_icon.ico"
$DESKTOP = [Environment]::GetFolderPath("Desktop")
$LNK = Join-Path $DESKTOP "MAGO Viewer.lnk"

if (-not (Test-Path $SCRIPT)) {
  throw "mago_launch.py introuvable : $SCRIPT"
}

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($LNK)

if (Test-Path $EXE) {
  $Shortcut.TargetPath = $EXE
  $Shortcut.Arguments = ""
} else {
  $PYTHONW = Get-Command pythonw.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
  if (-not $PYTHONW) {
    $PYTHONW = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
  }
  if (-not $PYTHONW) {
    throw "pythonw.exe/python.exe introuvable. Installe Python ou reconstruis l'exe avec PyInstaller."
  }
  $Shortcut.TargetPath = $PYTHONW
  $Shortcut.Arguments = "`"$SCRIPT`""
}

$Shortcut.WorkingDirectory = $ROOT
if (Test-Path $ICON) { $Shortcut.IconLocation = $ICON }
$Shortcut.Save()

Write-Host "Raccourci cree : $LNK"
