# Link the reference package's node_modules into this package via junctions.
# Used only for local build/test. When installed as a DSH profile plugin the
# profile's own node_modules is used instead.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as the
# system ANSI codepage (GBK here) and non-ASCII characters break the parser.
$ErrorActionPreference = 'Stop'

$src = 'C:\Users\Betsy\.dsh\plugin-src\dsh-providers-hub\node_modules'
$dst = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\node_modules'))

if (-not (Test-Path $src)) { throw "reference node_modules missing: $src" }

$targets = @(
  '@deepseek-ai\cordis',
  '@deepseek-ai\cosmokit',
  '@deepseek-ai\dsh-agent',
  '@deepseek-ai\dsh-brand',
  '@deepseek-ai\dsh-commands',
  '@deepseek-ai\dsh-credentials',
  '@deepseek-ai\dsh-llm',
  '@deepseek-ai\schemastery',
  '@types\node',
  'esbuild',
  'tsx',
  'typescript',
  'vitest'
)

foreach ($rel in $targets) {
  $source = Join-Path $src $rel
  $link = Join-Path $dst $rel
  if (-not (Test-Path -LiteralPath $source)) {
    Write-Output "MISSING $rel (skipped)"
    continue
  }
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    if ($item.LinkType -eq 'Junction') {
      [System.IO.Directory]::Delete($link)
    } else {
      Remove-Item -LiteralPath $link -Recurse -Force
    }
  }
  New-Item -ItemType Junction -Path $link -Target $source | Out-Null
  $ok = Test-Path -LiteralPath (Join-Path $link 'package.json')
  Write-Output ("OK   {0,-30} package.json={1}" -f $rel, $ok)
}
