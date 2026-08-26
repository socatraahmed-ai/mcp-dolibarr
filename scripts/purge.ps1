<#
.SYNOPSIS
  Assistant Windows pour la purge des factures fournisseurs d'un Dolibarr de TEST.

.DESCRIPTION
  Enchaîne tout ce qui doit l'être : dépendances, compilation, création du .env
  (clé saisie au clavier, jamais en clair dans une commande), puis exécution de
  scripts/purge-supplier-invoices.mjs.

  Par défaut RIEN n'est supprimé : le script produit uniquement le rapport.

.EXAMPLE
  .\scripts\purge.ps1
  Affiche la cible (URL, société, version) puis le rapport. Ne supprime rien.

.EXAMPLE
  .\scripts\purge.ps1 -Execute -ConfirmCompany "MA SOCIETE TEST"
  Supprime réellement, après confirmation du nom exact de la société.
#>
[CmdletBinding()]
param(
  [string]$Url,
  [switch]$Execute,
  [string]$ConfirmCompany
)

$ErrorActionPreference = 'Stop'

# Racine du projet, quel que soit le répertoire courant
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Projet : $root" -ForegroundColor DarkGray

# ── Node ──
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js introuvable. Installez-le depuis https://nodejs.org puis relancez."
}
Write-Host ("Node   : " + (& node -v)) -ForegroundColor DarkGray

# ── Dépendances ──
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host "`nInstallation des dependances..." -ForegroundColor Cyan
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install a echoue." }
}

# ── Compilation ──
Write-Host "`nCompilation..." -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build a echoue." }

# ── Lecture du .env existant ──
$envPath = Join-Path $root '.env'
$envUrl = $null
$envKey = $null
if (Test-Path $envPath) {
  foreach ($line in (Get-Content $envPath)) {
    if ($line -match '^\s*DOLIBARR_URL\s*=\s*(.+)$')     { $envUrl = $Matches[1].Trim() }
    if ($line -match '^\s*DOLIBARR_API_KEY\s*=\s*(.+)$') { $envKey = $Matches[1].Trim() }
  }
}

# ── URL cible ──
if ($Url) { $envUrl = $Url.Trim() }
while (-not $envUrl) {
  $envUrl = (Read-Host "URL de l'API Dolibarr de TEST (ex: http://192.168.1.10/dolibarr/api/index.php)").Trim()
}
if ($envUrl -match 'erp\.digitalfactory\.sn') {
  throw "URL de PRODUCTION refusee. Ce script ne cible que l'environnement de TEST."
}

# ── Clé API : saisie masquée, jamais dans l'historique ──
$placeholders = @('COLLE_TA_CLE_ICI', 'ta_vraie_cle_ici', 'votre_cle_api_dolibarr', 'VOTRE_CLE_API')
if ((-not $envKey) -or ($placeholders -contains $envKey)) {
  Write-Host "`nCle API Dolibarr requise." -ForegroundColor Yellow
  Write-Host "  Dolibarr > Accueil > Utilisateurs & Groupes > votre utilisateur" -ForegroundColor DarkGray
  Write-Host "  > onglet 'Fiche utilisateur' > champ 'Cle pour l'API REST'" -ForegroundColor DarkGray
  $secure = Read-Host "Collez la cle API" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try   { $envKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $envKey) { throw "Aucune cle saisie. Abandon." }

# ── Écriture du .env en UTF-8 SANS BOM ──
$content = "DOLIBARR_URL=$envUrl`nDOLIBARR_API_KEY=$envKey`n"
[IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding $false))
Write-Host ".env ecrit — cle de $($envKey.Length) caracteres" -ForegroundColor Green

# ── Lancement ──
$nodeArgs = @('scripts/purge-supplier-invoices.mjs')
if ($Execute) {
  if (-not $ConfirmCompany) {
    throw "-Execute exige -ConfirmCompany '<nom exact de la societe affiche par le rapport>'."
  }
  $nodeArgs += '--execute'
  $nodeArgs += '--confirm-company'
  $nodeArgs += $ConfirmCompany
}

Write-Host ""
& node $nodeArgs
exit $LASTEXITCODE
