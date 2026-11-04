# =============================================================================
# empacotar.ps1 — Gera exportador-docker.tar para construir a imagem no Portainer
# -----------------------------------------------------------------------------
# Uso (PowerShell, na pasta do projeto):
#   powershell -ExecutionPolicy Bypass -File docker\empacotar.ps1
#
# O pacote leva SOMENTE o necessário para a imagem (Dockerfile, página e
# servidor). Ficam de fora: teste.txt, exportações, manual de marca,
# certificados e usuários locais.
# =============================================================================

$ErrorActionPreference = "Stop"
$raiz = Split-Path $PSScriptRoot -Parent
$saida = Join-Path $raiz "exportador-docker.tar"

$itens = @("Dockerfile", "index.html", "LICENCA.txt", "css", "js", "vendor", "img", "fontes",
           "servidor/servidor.mjs", "docker/entrypoint.sh")

Push-Location $raiz
try {
    if (Test-Path $saida) { Remove-Item $saida }
    & "$env:SystemRoot\System32\tar.exe" -cf "exportador-docker.tar" @itens
    if ($LASTEXITCODE -ne 0) { throw "falha ao criar o pacote" }
} finally {
    Pop-Location
}

$tamanho = [math]::Round((Get-Item $saida).Length / 1KB)
Write-Host "Pacote criado: $saida ($tamanho KB)"
Write-Host "Envie-o no Portainer em: Images > Build a new image > Upload."
