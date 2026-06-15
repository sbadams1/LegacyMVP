# tools/stamp-end-session.ps1

$path = "supabase/functions/ai-brain/pipelines/end_session.ts"

if (!(Test-Path $path)) {
  Write-Error "File not found: $path"
  exit 1
}

# Generate ISO timestamp (UTC, same format you're using)
$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# Replace the build stamp line safely
$content = Get-Content $path -Raw

$newContent = $content -replace 'const END_SESSION_BUILD_STAMP = ".*?";', "const END_SESSION_BUILD_STAMP = `"$stamp`";"

# Safety check: ensure replacement actually happened
if ($content -eq $newContent) {
  Write-Error "Build stamp not replaced. Pattern not found."
  exit 1
}

# Write back
Set-Content -Path $path -Value $newContent -NoNewline

Write-Host "Updated END_SESSION_BUILD_STAMP to $stamp"