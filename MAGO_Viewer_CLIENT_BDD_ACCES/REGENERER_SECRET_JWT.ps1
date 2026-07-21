# ============================================================
# MAGO Viewer - Regeneration du secret JWT
# A executer avant tout deploiement hors du poste de dev.
# Invalide les jetons clients en cours (reconnexion necessaire).
# ============================================================
$ErrorActionPreference = "Stop"
$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path

# Cherche le .env de l'API a partir de l'emplacement du script
$envFile = Get-ChildItem $HERE -Recurse -Depth 5 -Filter ".env" -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "mago-enrichment-api" } | Select-Object -First 1
if (-not $envFile) { $envFile = Get-Item (Read-Host "Fichier .env introuvable pres du script. Chemin complet du .env") }

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

$content = Get-Content $envFile.FullName -Raw
$content = $content -replace "JWT_SECRET=.*", "JWT_SECRET=$secret"
Set-Content $envFile.FullName $content -NoNewline -Encoding UTF8

Write-Host "Nouveau JWT_SECRET ecrit dans $($envFile.FullName)" -ForegroundColor Green
Write-Host "Redemarrer l'API MAGO pour appliquer." -ForegroundColor Yellow
Read-Host "Entree pour fermer"
