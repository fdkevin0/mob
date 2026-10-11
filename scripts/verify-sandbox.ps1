# Verifies the container sandbox on Windows with WSL containers (wslc): the
# runtime CLI through `mob container`, then the model's sandbox tool through
# `mob serve --demo`. Prints PASS/FAIL per check and keeps the work directory
# when anything fails. Works in Windows PowerShell 5.1 and PowerShell 7.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-sandbox.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\verify-sandbox.ps1 -Mob C:\path\mob.exe -Image alpine:3.20 -Port 8799
param(
	[string]$Mob = '',
	[string]$Image = 'alpine:3.20',
	[int]$Port = 8799
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
# A space in the path catches quoting mistakes; user profiles often have one.
$Work = Join-Path ([IO.Path]::GetTempPath()) ('mob sandbox ' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Token = -join ((1..40) | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] })
$script:Failed = 0
$Serve = $null

function Pass([string]$Name) { Write-Host "PASS  $Name" }
function Fail([string]$Name, [string]$Detail = '') {
	Write-Host "FAIL  $Name" -ForegroundColor Red
	if ($Detail) { Write-Host ('      ' + $Detail.Substring(0, [Math]::Min(2000, $Detail.Length))) }
	$script:Failed++
}
function Check([string]$Name, [string]$Hay, [string[]]$Needles) {
	foreach ($n in $Needles) {
		if (-not $Hay.Contains($n)) { Fail $Name "missing '$n' in: $Hay"; return }
	}
	Pass $Name
}
# Runs mob and returns its combined output as one string.
function Mob { $out = & $Mob @args 2>&1 | ForEach-Object { "$_" }; ($out -join "`n") }

try {
	Write-Host '== Environment'
	[Environment]::OSVersion.VersionString
	wsl --version
	if (-not (Get-Command wslc -ErrorAction SilentlyContinue)) { Write-Host 'wslc is not on PATH'; exit 2 }

	if (-not $Mob) {
		Write-Host '== Build'
		$Mob = Join-Path $Work 'bin\mob.exe'
		Push-Location $Root
		go build -o $Mob ./cmd/mob
		$built = $LASTEXITCODE
		Pop-Location
		if ($built -ne 0) { Write-Host 'build failed'; exit 2 }
	}
	& $Mob --version
	$env:MOB_CONFIG = Join-Path $Work 'config.yaml'
	$env:MOB_SANDBOX_RUNTIME = 'wslc'
	Set-Content -Path $env:MOB_CONFIG -Value '' -Encoding ASCII

	Write-Host '== mob container'
	$out = Mob container status
	Check 'container status' $out @('wslc (wslc)', 'Ready.')
	$out = Mob container pull $Image
	if ($LASTEXITCODE -eq 0) { Pass "container pull $Image" } else { Fail "container pull $Image" $out }
	$hostDir = Join-Path $Work 'host'
	New-Item -ItemType Directory -Force -Path $hostDir | Out-Null
	Set-Content -Path (Join-Path $hostDir 'in.txt') -Value 'hello' -Encoding ASCII
	# A Windows path with a drive letter and a space, as Mob passes it.
	$out = Mob container run -v "${hostDir}:/work" -w /work -e GREETING=hi $Image sh -c 'echo $GREETING; cat in.txt; echo out > out.txt'
	Check 'run: env, Windows-path bind mount, workdir' $out @('hi', 'hello')
	$written = Get-Content -Path (Join-Path $hostDir 'out.txt') -ErrorAction SilentlyContinue
	if ($written -eq 'out') { Pass 'run: container writes reach the host' } else { Fail 'run: container writes reach the host' ((Get-ChildItem $hostDir | Out-String)) }
	$out = Mob container run $Image sh -c 'exit 3'
	Check 'run: exit status' $out @('status 3')
	# read rather than cat, so a runtime that keeps stdin open after EOF cannot hang this.
	$out = ('piped' | & $Mob container run -i $Image sh -c 'read l; echo got-$l' 2>&1 | ForEach-Object { "$_" }) -join "`n"
	Check 'run: stdin with -i' $out @('got-piped')
	# Prints a token per limit that took effect: cgroup v2 or v1 inside the
	# session's kernel. No double quotes, which Windows PowerShell 5.1 mangles.
	$Limits = 'n=$(ls /sys/class/net); c=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us); m=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes); set -- $(grep MemTotal /proc/meminfo); echo net=$n nproc=$(nproc) cpu=$c mem=$m total=$2; [ $n = lo ] && echo no-network; { [ $(nproc) = 1 ] || [ ${c%% *} = 100000 ]; } && echo one-cpu; { [ $m = 268435456 ] || [ $2 -le 262144 ]; } && echo memory-capped; true'
	$out = Mob container run --network none --cpus 1 --memory 256m $Image sh -c $Limits
	Check 'run: --network none, --cpus 1, --memory 256m' $out @('no-network', 'one-cpu', 'memory-capped')

	Write-Host '== Sandbox tool through mob serve --demo'
	@"
addr: 127.0.0.1:$Port
demo: true
data_dir: '$(Join-Path $Work 'data')'
state_dir: '$(Join-Path $Work 'state')'
sandbox:
  enabled: true
  image: $Image
  network: none
  cpus: 1
  memory: 256m
"@ | Set-Content -Path $env:MOB_CONFIG -Encoding ASCII
	$env:MOB_TOKEN = $Token
	$start = @{ FilePath = $Mob; ArgumentList = 'serve'; PassThru = $true
		RedirectStandardOutput = (Join-Path $Work 'serve.log'); RedirectStandardError = (Join-Path $Work 'serve.err.log') }
	if ($env:OS -eq 'Windows_NT') { $start.WindowStyle = 'Hidden' }
	$Serve = Start-Process @start
	$Api = "http://127.0.0.1:$Port/api"
	$Headers = @{ Authorization = "Bearer $Token" }
	for ($i = 0; $i -lt 50; $i++) {
		try { Invoke-RestMethod -Uri "$Api/config" -Headers $Headers | Out-Null; break } catch { Start-Sleep -Milliseconds 200 }
	}
	$Id = (Invoke-RestMethod -Method Post -Uri "$Api/conversations" -Headers $Headers).id
	if (-not $Id) { Fail 'service started' (Get-Content (Join-Path $Work 'serve.err.log') -Raw); exit 1 }
	Pass "service started, conversation $Id"

	# One turn; returns the whole event stream.
	$Chat = {
		param($Api, $Token, $Id, $Command)
		$body = @{ id = $Id; text = "/sandbox $Command"; requestId = [guid]::NewGuid().ToString('N') } | ConvertTo-Json -Compress
		$r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$Api/chat" -Headers @{ Authorization = "Bearer $Token" } `
			-ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 600
		$r.Content
	}
	function Chat([string]$Command) { & $Chat $Api $Token $Id $Command }

	$out = Chat 'echo kept > note.txt; echo gone > /tmp/marker; id -u; pwd'
	Check 'tool: runs without approval in /workspace' $out @('tool-output-available', '"exitCode":0', '/workspace')
	$out = Chat 'cat note.txt; cat /tmp/marker 2>&1; ls /mnt/c 2>&1'
	Check 'tool: workspace persists, the rest and drive C: are not visible' $out @('kept', 'No such file')
	$note = Get-Content -Path (Join-Path (Join-Path (Join-Path (Join-Path $Work 'data') 'sandbox') $Id) 'note.txt') -ErrorAction SilentlyContinue
	if ($note -eq 'kept') { Pass 'tool: workspace is data_dir\sandbox\<id> on the host' } else { Fail 'tool: workspace on the host' ((Get-ChildItem -Recurse (Join-Path $Work 'data') | Out-String)) }
	$out = Chat 'exit 3'
	Check 'tool: nonzero exit is a result' $out @('"exitCode":3')
	$out = Chat 'yes x | head -c 40000'
	Check 'tool: output capped' $out @('"truncated":true')
	$out = Chat $Limits
	Check 'tool: network, CPU and memory limits apply' $out @('no-network', 'one-cpu', 'memory-capped')

	# Stopping the turn must remove the running container.
	$job = Start-Job -ScriptBlock $Chat -ArgumentList $Api, $Token, $Id, 'sleep 600'
	Start-Sleep -Seconds 8
	$pattern = 'mob-[0-9a-f]{16}'
	# Where-Object, not -match: one line of output would make -match return a bool.
	$running = @(wslc container list --all 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match $pattern }).Count
	Invoke-RestMethod -Method Post -Uri "$Api/conversations/$Id/stop" -Headers $Headers | Out-Null
	Wait-Job $job -Timeout 60 | Out-Null
	Remove-Job $job -Force
	Start-Sleep -Seconds 3
	$left = @(wslc container list --all 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match $pattern })
	if ($running -ge 1 -and $left.Count -eq 0) { Pass 'stop: running container removed' } else { Fail 'stop: running container removed' "running before stop: $running; left after: $($left -join '; ')" }
}
catch {
	# An unexpected error must never read as a pass.
	Fail 'script error' ($_ | Out-String)
}
finally {
	if ($Serve) { Stop-Process -Id $Serve.Id -Force -ErrorAction SilentlyContinue }
	Write-Host "== $script:Failed failed"
	if ($script:Failed -eq 0) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue } else { Write-Host "Kept for inspection: $Work" }
}
if ($script:Failed -ne 0) { exit 1 }
