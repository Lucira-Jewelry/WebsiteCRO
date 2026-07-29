<#
  merge_csv.ps1 — idempotent CSV merge.

  Removes any rows in -Target whose key columns match rows in -Fragment, then appends
  the fragment and re-sorts. Running the same day twice therefore overwrites rather
  than duplicating, which makes the daily job safe to retry.

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\merge_csv.ps1 `
      -Target data\daily_device.csv -Fragment data\_frag.csv -Keys date,deviceCategory
#>
param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Fragment,
  [Parameter(Mandatory=$true)][string[]]$Keys
)
$ErrorActionPreference = 'Stop'

# When invoked via `powershell -File`, "-Keys date,device" arrives as a single string.
# Split and flatten so both call styles behave the same.
$Keys = @($Keys | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

if (-not (Test-Path $Fragment)) { throw "Fragment not found: $Fragment" }
$new = @(Import-Csv $Fragment)
if ($new.Count -eq 0) { Write-Output "Fragment empty - nothing to merge."; return }

foreach ($k in $Keys) {
  if ($new[0].PSObject.Properties.Name -notcontains $k) { throw "Fragment missing key column '$k'." }
}
function Key-Of($row) { ($Keys | ForEach-Object { [string]$row.$_ }) -join '||' }

$existing = @()
if (Test-Path $Target) { $existing = @(Import-Csv $Target) }

$newKeys = @{}
foreach ($r in $new) { $newKeys[(Key-Of $r)] = $true }

$kept = @($existing | Where-Object { -not $newKeys.ContainsKey((Key-Of $_)) })
$replaced = $existing.Count - $kept.Count

$all = @($kept) + @($new)
$sorted = $all | Sort-Object @{ Expression = { $_.($Keys[0]) } }, @{ Expression = { if ($Keys.Count -gt 1) { $_.($Keys[1]) } else { '' } } }, @{ Expression = { if ($Keys.Count -gt 2) { $_.($Keys[2]) } else { '' } } }

$sorted | Export-Csv $Target -NoTypeInformation -Encoding utf8
Remove-Item $Fragment -Force

$leaf = Split-Path $Target -Leaf
Write-Output "$leaf : +$($new.Count) rows (replaced $replaced), total $($sorted.Count)"
