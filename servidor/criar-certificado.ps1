# =============================================================================
# criar-certificado.ps1 — Cria o certificado HTTPS usado por servidor.mjs
# -----------------------------------------------------------------------------
# Uso (PowerShell, na pasta do projeto; não precisa ser administrador):
#   powershell -ExecutionPolicy Bypass -File servidor\criar-certificado.ps1
#
# Gera um certificado autoassinado válido por 2 anos para o nome desta máquina
# e seus IPs na rede. Cria três arquivos nesta pasta:
#   certificado.pfx         certificado + chave privada (usado pelo servidor)
#   certificado-senha.txt   senha aleatória que protege o .pfx
#   certificado.cer         só o certificado público, para instalar nas máquinas
#                           de quem vai acessar (evita o aviso "não seguro")
# Rode de novo se o nome ou o IP da máquina mudar.
# =============================================================================

$ErrorActionPreference = "Stop"
$pasta = $PSScriptRoot

$nome = $env:COMPUTERNAME
$dominio = (Get-CimInstance Win32_ComputerSystem).Domain
$nomes = @($nome, "localhost")
if ($dominio -and $dominio -ne "WORKGROUP") { $nomes += "$nome.$dominio" }
$ips = @(Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch '^(169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' -or $_.IPAddress -eq '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress)

$san = (($nomes | ForEach-Object { "DNS=$_" }) + ($ips | ForEach-Object { "IPAddress=$_" })) -join "&"

$cert = New-SelfSignedCertificate `
    -Subject "CN=$nome - Exportador Authenticator Gemma" `
    -TextExtension @("2.5.29.17={text}$san", "2.5.29.37={text}1.3.6.1.5.5.7.3.1") `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(2) `
    -CertStoreLocation "Cert:\CurrentUser\My"

$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$senhaTexto = [Convert]::ToBase64String($bytes)
$senha = ConvertTo-SecureString $senhaTexto -AsPlainText -Force

Export-PfxCertificate -Cert $cert -FilePath (Join-Path $pasta "certificado.pfx") -Password $senha | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $pasta "certificado.cer") | Out-Null
Set-Content -Path (Join-Path $pasta "certificado-senha.txt") -Value $senhaTexto -Encoding ascii -NoNewline
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"

Write-Host "Certificado criado para: $($nomes -join ', '), $($ips -join ', ')"
Write-Host "Validade: $($cert.NotAfter.ToString('dd/MM/yyyy'))"
