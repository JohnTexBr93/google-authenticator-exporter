#!/bin/sh
# =============================================================================
# entrypoint.sh — Executado sempre que o contêiner inicia.
# Na primeira vez, cria um certificado HTTPS autoassinado (válido 2 anos) para
# os nomes/IPs informados em NOMES_CERTIFICADO (separados por vírgula).
# Para gerar um novo, apague /dados/certificado.crt e reinicie o contêiner.
# =============================================================================
set -e
DADOS="${PASTA_DADOS:-/dados}"

if [ ! -f "$DADOS/certificado.pfx" ] && [ ! -f "$DADOS/certificado.crt" ]; then
  SAN=""
  IFS=','
  for nome in ${NOMES_CERTIFICADO:-localhost}; do
    nome=$(echo "$nome" | tr -d ' ')
    [ -z "$nome" ] && continue
    case "$nome" in
      *[!0-9.]*) item="DNS:$nome" ;;
      *)         item="IP:$nome" ;;
    esac
    SAN="${SAN:+$SAN,}$item"
  done
  unset IFS

  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 730 \
    -keyout "$DADOS/certificado.key" -out "$DADOS/certificado.crt" \
    -subj "/CN=Exportador Authenticator Gemma" \
    -addext "subjectAltName=$SAN" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
  chmod 600 "$DADOS/certificado.key"
  echo "Certificado criado para: $SAN"
fi

exec "$@"
