param(
    [string]$Repo = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = "Stop"
$Problems = New-Object System.Collections.Generic.List[string]

Write-Host "Repository audit: $Repo" -ForegroundColor Cyan

if ((Get-Command git.exe -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $Repo ".git"))) {
    Push-Location $Repo
    try {
        $Tracked = & git.exe ls-files
        $ForbiddenTracked = $Tracked | Where-Object {
            $_ -match '(^|/)(\.env|storage|SAUVEGARDES_BDD)(/|$)' -or
            $_ -match '\.(dump|log)$'
        }
        foreach ($File in $ForbiddenTracked) {
            $Problems.Add("Private/runtime file tracked by Git: $File")
        }
    }
    finally { Pop-Location }
}

$TextFiles = Get-ChildItem $Repo -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $_.FullName -notmatch '\\.git\\' -and
        $_.FullName -notmatch '\\node_modules\\' -and
        $_.FullName -notmatch '\\_PATCH_BACKUP_' -and
        $_.Extension -in '.ps1', '.ts', '.js', '.json', '.md', '.txt', '.sql', '.py', '.example'
    }

foreach ($File in $TextFiles) {
    $Text = [IO.File]::ReadAllText($File.FullName)
    if ($Text -match 'D:\\TFE Nathan') {
        $Problems.Add("Private development path found: $($File.FullName)")
    }
    if ($Text -match 'packages\.applied-caas-gateway1\.internal\.api\.openai\.org') {
        $Problems.Add("Internal npm registry found: $($File.FullName)")
    }
    if ($Text -match '(?m)^\s*\$env:PGPASSWORD\s*=\s*["''][^$][^"'']+["'']') {
        $Problems.Add("Hard-coded PostgreSQL password found: $($File.FullName)")
    }
}

$Required = @(
    "INSTALLER_VIEWER_COMPLET.ps1",
    "INSTALLATION_PUBLIQUE.md",
    "MAGO_Viewer_CLIENT_BDD_ACCES\api\mago-enrichment-api\sql\000_mago_schema.sql",
    "MAGO_Viewer_CLIENT_BDD_ACCES\api\mago-enrichment-api\sql\002_client_access_database.sql"
)
foreach ($Relative in $Required) {
    if (-not (Test-Path (Join-Path $Repo $Relative))) {
        $Problems.Add("Required public-install file missing: $Relative")
    }
}

if ($Problems.Count -gt 0) {
    Write-Host "`nPUBLIC REPOSITORY AUDIT FAILED:" -ForegroundColor Red
    $Problems | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}

Write-Host "`nPUBLIC REPOSITORY AUDIT: OK" -ForegroundColor Green
Write-Host "No tracked .env, storage, database dump, log, hard-coded password or private TFE path was detected." -ForegroundColor Green
