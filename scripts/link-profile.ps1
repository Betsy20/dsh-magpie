# Link dsh-magpie into the desktop profile's node_modules.
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as GBK, so any non-ASCII
# byte breaks the parser with "missing string terminator".
#
# A directory junction is used (not a symbolic link) because junctions do
# not require Developer Mode or elevation, and Node's realpath() resolves
# them transparently.

$profileModules = 'C:\Users\Betsy\.dsh\profiles\desktop\node_modules'
$source = 'C:\Users\Betsy\.dsh\plugin-src\dsh-magpie'
$link = Join-Path $profileModules 'dsh-magpie'

if (-not (Test-Path $source)) {
  throw "source package not found: $source"
}

if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    Write-Host "removing existing $($item.LinkType): $link"
    $item.Delete()
  } else {
    throw "refusing to delete a real directory: $link"
  }
}

New-Item -ItemType Junction -Path $link -Target $source | Out-Null
Write-Host "linked $link -> $source"

# Prove the resolution works the way Node will see it.
$entry = Join-Path $link 'lib\index.js'
if (-not (Test-Path $entry)) {
  throw "built entry missing: $entry (run 'node scripts/build.mjs' first)"
}
Write-Host "entry present: $entry"
