param($JwtFile)

if (Test-Path $JwtFile) {
    $json = Get-Content $JwtFile -Raw | ConvertFrom-Json
    if ($json.email) {
        Write-Output $json.email
    }
}
