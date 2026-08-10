<#
  build_report.ps1 — assembles the interactive CRO report.

  Reads the three daily CSVs in /data, injects them into tools/report_template.html,
  and writes reports/interactive.html. Safe to run repeatedly; it is a pure rebuild
  from whatever the CSVs currently contain.

  Usage:  powershell -ExecutionPolicy Bypass -File tools\build_report.ps1
#>

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $base 'data'
$outDir  = Join-Path $base 'reports'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Norm-Date([string]$d) {
  if ($d -match '^\d{8}$') { return $d.Substring(0,4) + '-' + $d.Substring(4,2) + '-' + $d.Substring(6,2) }
  return $d
}

# ---- device / sessions ----
$devRows = @()
$devCsv = Join-Path $dataDir 'daily_device.csv'
if (Test-Path $devCsv) {
  foreach ($r in Import-Csv $devCsv) {
    $devRows += [ordered]@{
      d   = Norm-Date $r.date
      dev = $r.deviceCategory
      s   = [int]$r.sessions
      u   = [int]$r.totalUsers
      br  = [double]$r.bounceRate
      eng = [int]$r.userEngagementDuration
      pv  = [int]$r.screenPageViews
    }
  }
}

# ---- funnel events ----
$fnRows = @()
$fnCsv = Join-Path $dataDir 'daily_funnel.csv'
if (Test-Path $fnCsv) {
  foreach ($r in Import-Csv $fnCsv) {
    $fnRows += [ordered]@{ d = Norm-Date $r.date; dev = $r.device; e = $r.event; n = [int]$r.events }
  }
}

# ---- clarity ----
$clRows = @()
$clCsv = Join-Path $dataDir 'daily_clarity.csv'
if (Test-Path $clCsv) {
  foreach ($r in Import-Csv $clCsv) {
    $clRows += [ordered]@{
      d = Norm-Date $r.date; dev = $r.device
      rage = [int]$r.rage_clicks; dead = [int]$r.dead_clicks; scroll = [double]$r.scroll_depth_pct
    }
  }
}

if ($devRows.Count -eq 0) { throw "No rows in data\daily_device.csv - nothing to build." }

$allDates  = ($devRows | ForEach-Object { $_.d }) | Sort-Object -Unique
$clDates   = ($clRows  | ForEach-Object { $_.d }) | Sort-Object -Unique
$minDate   = $allDates[0]
$maxDate   = $allDates[-1]
$totalDays = [int]((New-TimeSpan -Start ([datetime]$minDate) -End ([datetime]$maxDate)).Days) + 1

# ---- freshness / health ----
# The real risk for a meeting artefact is not a wrong number, it is a silently stale one.
# Data is expected to run through T-2; anything older is flagged loudly in the report.
$today       = Get-Date
$expectedMax = $today.AddDays(-2).ToString('yyyy-MM-dd')
$daysBehind  = [int]((New-TimeSpan -Start ([datetime]$maxDate) -End ([datetime]$expectedMax)).Days)
$clarityBehind = if ($clDates.Count) {
  [int]((New-TimeSpan -Start ([datetime]$clDates[-1]) -End ([datetime]$expectedMax)).Days)
} else { 999 }

$health = if ($daysBehind -le 0) { 'current' } elseif ($daysBehind -eq 1) { 'lagging' } else { 'stale' }

# last run outcome, if the log exists
$lastRun = $null
$logPath = Join-Path $dataDir 'run_log.csv'
if (Test-Path $logPath) {
  $log = @(Import-Csv $logPath)
  if ($log.Count) { $lastRun = $log[-1] }
}

$payload = [ordered]@{
  meta = [ordered]@{
    generated  = $today.ToString('yyyy-MM-dd HH:mm')
    minDate    = $minDate
    maxDate    = $maxDate
    totalDays  = $totalDays
    ga4        = '478308692'
    clarity    = 'ro0m9zh071'
    rows       = $devRows.Count + $fnRows.Count + $clRows.Count
    clarityFrom = if ($clDates.Count) { $clDates[0] }  else { 'n/a' }
    clarityTo   = if ($clDates.Count) { $clDates[-1] } else { 'n/a' }
    expectedMax   = $expectedMax
    daysBehind    = $daysBehind
    clarityBehind = $clarityBehind
    health        = $health
    lastRunAt     = if ($lastRun) { $lastRun.run_at }  else { 'never' }
    lastRunNotes  = if ($lastRun) { $lastRun.notes }   else { '' }
    lastRunStatus = if ($lastRun) {
      # ASCII separator only: PowerShell 5.1 reads .ps1 files as ANSI and mangles non-ASCII.
      @("GA4 device: $($lastRun.ga4_device)", "GA4 funnel: $($lastRun.ga4_funnel)",
        "Clarity: $($lastRun.clarity_daily)", "Snapshot: $($lastRun.snapshot)") -join ' | '
    } else { 'no run logged yet' }
  }
  device  = $devRows
  funnel  = $fnRows
  clarity = $clRows
}

$json = $payload | ConvertTo-Json -Depth 6 -Compress

# ---- deep-dive snapshot ----
# latest.json is the single source of truth for the fixed-window analysis (page tables,
# fold analysis, click elements, findings, corrections). Injected verbatim so the
# narrative data can never drift from the interactive report.
$snapPath = Join-Path $dataDir 'latest.json'
if (-not (Test-Path $snapPath)) { throw "data\latest.json not found - the snapshot sections need it." }
$snapRaw = Get-Content $snapPath -Raw -Encoding UTF8
try { $null = $snapRaw | ConvertFrom-Json } catch { throw "data\latest.json is not valid JSON: $_" }
$snapJson = ($snapRaw | ConvertFrom-Json) | ConvertTo-Json -Depth 12 -Compress

$tplPath = Join-Path $PSScriptRoot 'report_template.html'
$tpl = Get-Content $tplPath -Raw -Encoding UTF8
if ($tpl -notmatch [regex]::Escape('/*__DATA__*/'))     { throw "Placeholder /*__DATA__*/ missing from template." }
if ($tpl -notmatch [regex]::Escape('/*__SNAPSHOT__*/')) { throw "Placeholder /*__SNAPSHOT__*/ missing from template." }
$html = $tpl.Replace('/*__DATA__*/{}', $json).Replace('/*__SNAPSHOT__*/{}', $snapJson)

$stamp = Get-Date -Format 'yyyy-MM-dd'
Set-Content -Path (Join-Path $outDir 'interactive.html')            -Value $html -Encoding utf8
Set-Content -Path (Join-Path $outDir "${stamp}_interactive.html")   -Value $html -Encoding utf8

Write-Output "Built interactive report"
Write-Output "  HEALTH       : $($health.ToUpper())  (data through $maxDate, expected $expectedMax, $daysBehind day(s) behind)"
if ($health -ne 'current') {
  Write-Warning "Report is NOT current. Run tools\DAILY_RUN.md before presenting this in a meeting."
}
Write-Output "  date range   : $minDate -> $maxDate ($totalDays days)"
Write-Output "  device rows  : $($devRows.Count)"
Write-Output "  funnel rows  : $($fnRows.Count)"
Write-Output "  clarity rows : $($clRows.Count)  ($($payload.meta.clarityFrom) -> $($payload.meta.clarityTo))"
Write-Output "  daily payload: $([math]::Round($json.Length/1KB,1)) KB"
Write-Output "  snapshot     : $([math]::Round($snapJson.Length/1KB,1)) KB from data\latest.json"
Write-Output "  output       : reports\interactive.html"

# ---- daily tasks tab ----
# data/tasks.json is the single source of truth for the Tasks tab -- a list of what users
# are currently facing, read off GA4 + Clarity + Playwright + Shopify, each with insight/
# action/impact. Injected verbatim, same pattern as the snapshot above.
$tasksPath = Join-Path $dataDir 'tasks.json'
if (Test-Path $tasksPath) {
  $tasksRaw = Get-Content $tasksPath -Raw -Encoding UTF8
  try { $tasksObj = $tasksRaw | ConvertFrom-Json } catch { throw "data\tasks.json is not valid JSON: $_" }

  $tasksArrJson = $tasksObj.tasks | ConvertTo-Json -Depth 8 -Compress
  if ($tasksObj.tasks.Count -eq 1) { $tasksArrJson = '[' + $tasksArrJson + ']' }
  $metaObj = [ordered]@{
    generated_at = $tasksObj.generated_at
    window       = $tasksObj.window
    sources      = $tasksObj.sources
  }
  $metaJson = $metaObj | ConvertTo-Json -Depth 4 -Compress

  $tasksTplPath = Join-Path $PSScriptRoot 'tasks_template.html'
  if (-not (Test-Path $tasksTplPath)) { throw "tools\tasks_template.html not found." }
  $tasksTpl = Get-Content $tasksTplPath -Raw -Encoding UTF8
  if ($tasksTpl -notmatch [regex]::Escape('/*__META__*/'))  { throw "Placeholder /*__META__*/ missing from tasks_template.html." }
  if ($tasksTpl -notmatch [regex]::Escape('/*__TASKS__*/')) { throw "Placeholder /*__TASKS__*/ missing from tasks_template.html." }
  $tasksHtml = $tasksTpl.Replace('/*__META__*/{}', $metaJson).Replace('/*__TASKS__*/[]', $tasksArrJson)

  Set-Content -Path (Join-Path $outDir 'tasks.html') -Value $tasksHtml -Encoding utf8

  Write-Output ""
  Write-Output "Built tasks report"
  Write-Output "  tasks        : $($tasksObj.tasks.Count)"
  Write-Output "  generated_at : $($tasksObj.generated_at)"
  Write-Output "  output       : reports\tasks.html"
} else {
  Write-Warning "data\tasks.json not found - skipped building reports\tasks.html."
}
