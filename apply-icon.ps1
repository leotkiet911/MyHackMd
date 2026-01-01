# Script to apply icon to MyHackMd.exe
# Usage: .\apply-icon.ps1

$exePath = "MyHackMd.exe"
$iconPath = "logo.ico"

if (-not (Test-Path $exePath)) {
    Write-Host "❌ Error: $exePath not found!" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $iconPath)) {
    Write-Host "❌ Error: $iconPath not found!" -ForegroundColor Red
    exit 1
}

$rceditPath = "node_modules\rcedit\bin\rcedit-x64.exe"

if (-not (Test-Path $rceditPath)) {
    Write-Host "📦 Installing rcedit..." -ForegroundColor Yellow
    npm install rcedit --save-dev
}

if (Test-Path $rceditPath) {
    Write-Host "📷 Applying icon to $exePath..." -ForegroundColor Cyan
    & $rceditPath $exePath --set-icon $iconPath
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Icon applied successfully!" -ForegroundColor Green
        Write-Host "💡 Refresh File Explorer (F5) to see the new icon" -ForegroundColor Yellow
    } else {
        Write-Host "❌ Failed to apply icon" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "❌ Error: rcedit-x64.exe not found!" -ForegroundColor Red
    Write-Host "   Please run: npm install rcedit --save-dev" -ForegroundColor Yellow
    exit 1
}









