# =============================================================================
# Dockerfile — Imagem do Exportador do Google Authenticator (servidor HTTPS)
# -----------------------------------------------------------------------------
# Copia SOMENTE os arquivos da página e o servidor. Arquivos com dados reais
# (teste.txt, exportações), o manual de marca e certificados locais ficam fora.
# Certificado e usuários ficam no volume /dados (sobrevivem a atualizações).
# =============================================================================
FROM node:22-alpine

RUN apk add --no-cache openssl

WORKDIR /app
COPY index.html LICENCA.txt ./
COPY css ./css
COPY js ./js
COPY vendor ./vendor
COPY img ./img
COPY fontes ./fontes
COPY servidor/servidor.mjs ./servidor/servidor.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
 && chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir /dados && chown node:node /dados

ENV PASTA_DADOS=/dados \
    PORTA=8443

USER node
EXPOSE 8443
VOLUME /dados

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "servidor/servidor.mjs"]
