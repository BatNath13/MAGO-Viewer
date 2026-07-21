$ErrorActionPreference = "SilentlyContinue"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$API  = Join-Path $ROOT "api\mago-enrichment-api"
$URL_FILE = Join-Path $API ".client_public_url"

$CLOUDFLARED = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
if (!(Test-Path $CLOUDFLARED)) {
  $CLOUDFLARED = Get-ChildItem "$env:LOCALAPPDATA","C:\Program Files","C:\Program Files (x86)" -Recurse -Filter "cloudflared.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

if (!(Test-Path $CLOUDFLARED)) {
  Write-Host "cloudflared.exe introuvable. Installe-le avec : winget install Cloudflare.cloudflared" -ForegroundColor Red
  Read-Host "Appuie sur Entrée pour fermer"
  exit 1
}

Write-Host "Démarrage du tunnel public MAGO..." -ForegroundColor Cyan
Write-Host "Quand l'URL https://...trycloudflare.com apparaît, elle est enregistrée ici :" -ForegroundColor Cyan
Write-Host $URL_FILE -ForegroundColor Yellow
Write-Host "Garde cette fenêtre ouverte tant que le client doit accéder au viewer." -ForegroundColor Cyan
Write-Host ""

& $CLOUDFLARED tunnel --url http://localhost:3001 2>&1 | ForEach-Object {
  $line = $_.ToString()
  if ($line -match "https://[a-zA-Z0-9-]+\.trycloudflare\.com") {
    $url = $Matches[0].TrimEnd('/')
    Set-Content $URL_FILE $url -Encoding UTF8
    Write-Host "URL publique MAGO détectée : $url" -ForegroundColor Green
  }
  Write-Host $line
}
