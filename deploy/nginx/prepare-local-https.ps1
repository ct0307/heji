param(
    [string]$NginxDirectory,
    [switch]$Prepare
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
function Convert-ToNginxPath([string]$Path) { return $Path.Replace('\', '/') }
if (-not $Prepare) {
    Write-Output '默认仅显示计划：明确获准后用-Prepare及-NginxDirectory生成独立包装配置；不安装、不生成私钥、不启动服务。'
    Write-Output '运行依据：docs/development/m4-local-https-plan.md；配置：deploy/nginx/heji-local-https.conf。'
    exit 0
}
if ([string]::IsNullOrWhiteSpace($NginxDirectory)) { throw '须显式指定本项目.local/tools内的已审核Nginx目录。' }
$toolsRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.local/tools')) + [System.IO.Path]::DirectorySeparatorChar
$nginxRoot = (Resolve-Path -LiteralPath $NginxDirectory).Path
if (-not ($nginxRoot + [System.IO.Path]::DirectorySeparatorChar).StartsWith($toolsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '仅接受项目.local/tools内的便携Nginx。' }
$nginxExecutable = Join-Path $nginxRoot 'nginx.exe'
$mimePath = Join-Path $nginxRoot 'conf/mime.types'
foreach ($required in @($nginxExecutable, $mimePath, (Join-Path $projectRoot 'apps/web/dist/index.html'), (Join-Path $projectRoot '.local/tls/heji-local-cert.pem'), (Join-Path $projectRoot '.local/tls/heji-local-key.pem'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw '缺少运行依赖、构建产物或已授权生成的证书；停止准备。' }
}
$runtimeRoot = Join-Path $projectRoot '.local/nginx-runtime'
$wrapperPath = Join-Path $runtimeRoot 'nginx.conf'
$fragmentPath = Join-Path $runtimeRoot 'heji-local.conf'
if ((Test-Path -LiteralPath $wrapperPath) -or (Test-Path -LiteralPath $fragmentPath)) { throw '包装配置或片段已存在，拒绝覆盖；请先检查原运行状态。' }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$mimeNginxPath = Convert-ToNginxPath $mimePath
$fragmentNginxPath = Convert-ToNginxPath $fragmentPath
$headerNginxPath = Convert-ToNginxPath (Join-Path $projectRoot 'deploy/nginx/proxy-headers.conf')
$certNginxPath = Convert-ToNginxPath (Join-Path $projectRoot '.local/tls/heji-local-cert.pem')
$keyNginxPath = Convert-ToNginxPath (Join-Path $projectRoot '.local/tls/heji-local-key.pem')
$fragment = [System.IO.File]::ReadAllText((Join-Path $projectRoot 'deploy/nginx/heji-local-https.conf'), [System.Text.Encoding]::UTF8)
# Nginx的相对include按主配置目录解析，证书也显式绝对化，不依赖启动工作目录。
$fragment = $fragment.Replace('include deploy/nginx/proxy-headers.conf;', ('include "' + $headerNginxPath + '";'))
$fragment = $fragment.Replace('ssl_certificate .local/tls/heji-local-cert.pem;', ('ssl_certificate "' + $certNginxPath + '";'))
$fragment = $fragment.Replace('ssl_certificate_key .local/tls/heji-local-key.pem;', ('ssl_certificate_key "' + $keyNginxPath + '";'))
$content = @"
worker_processes 1;
pid .local/nginx-runtime/nginx.pid;
error_log .local/nginx-runtime/bootstrap.log warn;
events { worker_connections 128; }
http {
    include "$mimeNginxPath";
    default_type application/octet-stream;
    client_body_temp_path .local/nginx-runtime/client-body;
    proxy_temp_path .local/nginx-runtime/proxy;
    fastcgi_temp_path .local/nginx-runtime/fastcgi;
    uwsgi_temp_path .local/nginx-runtime/uwsgi;
    scgi_temp_path .local/nginx-runtime/scgi;
    include "$fragmentNginxPath";
}
"@
# 仅创建新文件；避免误覆盖其他运行配置，也不读出证书或私钥内容。
foreach ($entry in @(@{ Path = $fragmentPath; Content = $fragment }, @{ Path = $wrapperPath; Content = $content })) {
    $stream = [System.IO.File]::Open($entry.Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($entry.Content)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
Write-Output '独立包装配置已创建；本脚本没有启动或重载服务。语法检查命令：'
# Windows版Nginx的命令行中文路径可能经过ANSI编码；工作目录由PowerShell设置，参数保持ASCII。
Write-Output ('Set-Location -LiteralPath "' + $projectRoot + '"')
Write-Output ('& "' + $nginxExecutable + '" -p ./ -c .local/nginx-runtime/nginx.conf -e .local/nginx-runtime/bootstrap.log -t')
