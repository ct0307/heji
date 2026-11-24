param([switch]$RunSyntaxCheck)
$ErrorActionPreference = 'Stop'
$nginxCommand = Get-Command nginx -ErrorAction SilentlyContinue
if (-not $nginxCommand) { Write-Output '未找到nginx；仅配置准备完成，语法/运行/HTTPS/WSS未验收。'; exit 2 }
if (-not $RunSyntaxCheck) { Write-Output '已找到nginx。显式使用-RunSyntaxCheck时才生成项目内包装配置并执行nginx -t；本脚本不启动或重载服务。'; exit 0 }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path.Replace('\','/')
$runtimeRoot = Join-Path $projectRoot '.local/nginx-check'
New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'logs') -Force | Out-Null
$wrapperPath = Join-Path $runtimeRoot 'nginx.conf'
$proxyHeaderPath = Join-Path $projectRoot 'deploy/nginx/proxy-headers.conf'
$configuration = [System.IO.File]::ReadAllText((Join-Path $projectRoot 'deploy/nginx/heji-dev.conf'))
$configuration = $configuration.Replace('include deploy/nginx/proxy-headers.conf;',('include "'+$proxyHeaderPath+'";'))
$content = "worker_processes 1;`npid logs/nginx.pid;`nevents { worker_connections 128; }`nhttp {`n$configuration`n}`n"
[System.IO.File]::WriteAllText($wrapperPath,$content,[System.Text.UTF8Encoding]::new($false))
& $nginxCommand.Source -p ($runtimeRoot.Replace('\','/')+'/') -c $wrapperPath -t
exit $LASTEXITCODE
