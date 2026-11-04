# Exportador do Google Authenticator

Desenvolvido por Artur Teixeira. **Uso exclusivamente interno da Gemma Viagens e Turismo LTDA**; veja [LICENCA.txt](LICENCA.txt).

Ferramenta que lê os QR codes de exportação do Google Authenticator (prints ou fotos), mostra todas as contas em uma tabela e permite exportá-las para outro aplicativo ou para backup.

Tudo roda **dentro do navegador** de quem abre a página. Não há servidor, instalação nem internet envolvidos, e os secrets nunca saem do computador.

## Como usar

1. No celular, abra o Google Authenticator: **Transferir contas → Exportar contas**. Selecione as contas.
2. Tire print (ou foto, com outro aparelho) de **cada** QR code mostrado ("1 de 4", "2 de 4"...).
3. No computador, abra o arquivo [index.html](index.html) com dois cliques (Chrome, Edge ou Firefox).
4. Arraste os prints para a página, clique para escolhê-los ou cole com Ctrl+V.
5. A seção **Verificação** mostra quais QR codes já foram lidos e quais estão faltando.
6. A tabela **Contas** mostra serviço, conta, código atual (para conferir com o celular) e secret, além de um QR por conta para importar em outro app.
7. Exporte em **CSV** (Excel), **JSON**, **links otpauth** (importáveis em Aegis, 2FAS, Bitwarden etc.) ou **backup migração** (os links originais).

Os dados ficam só na memória da aba: fechar ou recarregar a página apaga tudo.

## Como disponibilizar para outras pessoas

O programa é um conjunto de arquivos estáticos (HTML, CSS e JavaScript), sem login nem banco de dados. Há duas formas de compartilhar:

O uso é restrito aos colaboradores da Gemma Viagens e Turismo LTDA ([LICENCA.txt](LICENCA.txt)). Não compartilhe fora da empresa.

**Opção 1: enviar a pasta pelos canais internos (recomendada).** Compacte a pasta e envie. Cada pessoa descompacta e abre o `index.html`. Quem tem os arquivos consegue usar.

> ⚠️ Antes de compactar, **apague arquivos com dados reais** (`teste.txt`, exportações `.csv`/`.json`/`.txt`).

**Opção 2: acessar direto da máquina do Artur (servidor incluído).** Veja a seção [Servidor na rede](#servidor-na-rede).

**Opção 3: hospedar em um servidor interno** (IIS, Apache, Nginx, etc.). Copie `index.html`, `css/`, `js/` e `vendor/` para o servidor.

- **Quem pode acessar** é definido pelo próprio servidor: por exemplo, no IIS ative a "Autenticação do Windows" e libere apenas um grupo do AD.
- **Use HTTPS.** Sem HTTPS (fora de `localhost`), o navegador bloqueia o cálculo dos códigos e o botão de copiar.
- **Restrinja quem pode alterar os arquivos no servidor.** Quem altera o JavaScript poderia capturar os secrets de quem usa a página. Mesmo hospedado, o processamento continua no navegador de cada usuário e o servidor não recebe os secrets.

## Servidor na rede

O arquivo [servidor/servidor.mjs](servidor/servidor.mjs) publica a página na rede interna com HTTPS e login por usuário. Requer [Node.js](https://nodejs.org/) 18+ na máquina que serve; quem acessa só precisa do navegador.

Preparação (uma vez, no PowerShell, na pasta do projeto):

```powershell
# 1. Certificado HTTPS (refaça se o nome ou o IP da máquina mudar)
powershell -ExecutionPolicy Bypass -File servidor\criar-certificado.ps1

# 2. Um usuário por pessoa autorizada (pede a senha, mínimo 10 caracteres)
node servidor/servidor.mjs --adicionar-usuario nome.sobrenome

# 3. Liberar a porta no firewall — PowerShell como ADMINISTRADOR, só rede do domínio
New-NetFirewallRule -DisplayName "Exportador Authenticator (HTTPS 8443)" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Domain -RemoteAddress LocalSubnet
```

Para colocar no ar: `node servidor/servidor.mjs` (a janela deve ficar aberta). O endereço aparece no terminal, por exemplo `https://DESKTOP-D1MKCED:8443/`.

Gerenciar acessos: `--adicionar-usuario nome` (também troca a senha), `--remover-usuario nome`, `--listar-usuarios`. Cada acesso aparece no terminal com usuário, IP e horário. Um IP que errar a senha 10 vezes fica bloqueado por 15 minutos.

Aviso de "conexão não segura": o certificado é autoassinado. Para removê-lo, instale `servidor\certificado.cer` em "Autoridades de Certificação Raiz Confiáveis" nas máquinas de quem acessa (idealmente via GPO).

**Desligar o login (usuário e senha):** inicie com a variável `LOGIN=desligado`. No PowerShell:

```powershell
$env:LOGIN = "desligado"; node servidor/servidor.mjs
```

Sem login, qualquer pessoa que alcance a porta abre a página. O terminal mostra um aviso. Para religar, feche e abra o PowerShell (ou rode `Remove-Item Env:LOGIN`) antes de iniciar de novo.

## Docker

Arquivos: [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml) e [docker/entrypoint.sh](docker/entrypoint.sh). A imagem recebe só os arquivos da página e o servidor (nada de `teste.txt`, exportações ou manual). Na primeira execução, o contêiner cria sozinho um certificado HTTPS. O certificado e os usuários ficam no volume `dados`, que sobrevive a atualizações.

1. Em [docker-compose.yml](docker-compose.yml), ajuste `NOMES_CERTIFICADO` (nome e IP da máquina do Docker) e `LOGIN` (`ligado` ou `desligado`).
2. Construa a imagem: `docker compose build`.
3. Se `LOGIN: "ligado"`, crie os usuários: `docker compose run --rm exportador node servidor/servidor.mjs --adicionar-usuario nome.sobrenome`.
4. Suba: `docker compose up -d`. Acesse `https://NOME-DA-MAQUINA:8443/`.

Comandos úteis:

| Ação | Comando |
| --- | --- |
| Ver o log de acessos | `docker compose logs -f` |
| Parar | `docker compose down` |
| Atualizar após mudar o código | `docker compose up -d --build` |
| Listar usuários | `docker compose run --rm exportador node servidor/servidor.mjs --listar-usuarios` |
| Remover usuário | `docker compose run --rm exportador node servidor/servidor.mjs --remover-usuario nome` |
| Copiar o certificado para instalar nos PCs | `docker compose cp exportador:/dados/certificado.crt .` |
| Gerar novo certificado (mudou nome/IP) | `docker compose exec exportador rm /dados/certificado.crt /dados/certificado.key` e depois `docker compose restart` |

### Pelo Portainer

1. Gere o pacote: `powershell -ExecutionPolicy Bypass -File docker\empacotar.ps1` (cria `exportador-docker.tar`, só com a página e o servidor).
2. Portainer → ambiente do servidor → **Images** → **Build a new image**: nome `exportador-authenticator-gemma:1.0`, aba **Upload**, envie o `.tar`, **Build the image**.
3. **Stacks** → **Add stack** → **Web editor**: cole [docker/portainer-stack.yml](docker/portainer-stack.yml) e ajuste as linhas marcadas com `TROQUE`: a porta (número à esquerda em `ports`) e `NOMES_CERTIFICADO` (nome do servidor Docker usado no link). **Deploy the stack**.
4. O login vem **desligado** nessa stack, porque o acesso é controlado pela plataforma interna da empresa. Para ligá-lo, adicione a variável `LOGIN` = `ligado` e crie os usuários em **Containers** → contêiner do exportador → **Console** → `/bin/sh` → **Connect** e rode `node servidor/servidor.mjs --adicionar-usuario nome.sobrenome`. Vale na hora, sem reiniciar.

Para atualizar: gere o pacote de novo, repita o passo 2 com a nova versão (ex.: `:1.1`), troque a versão na stack e clique em **Update the stack**. Usuários e certificado ficam preservados no volume.

## Estrutura do projeto

| Arquivo | O que faz |
| --- | --- |
| [index.html](index.html) | Estrutura da tela |
| [css/estilo.css](css/estilo.css) | Aparência no padrão visual da Gemma (cores, fontes e layout do manual de marca) |
| [img/logo-gemma.png](img/logo-gemma.png) | Logotipo oficial (versão preferencial, extraído do manual de marca) |
| [fontes/](fontes/) | Fonte Raleway (licença OFL), usada quando as fontes oficiais não estão instaladas |
| [js/protobuf.js](js/protobuf.js) | Decodifica o formato binário do Google Authenticator |
| [js/migracao.js](js/migracao.js) | Interpreta os links `otpauth-migration://` e `otpauth://` |
| [js/totp.js](js/totp.js) | Calcula os códigos de 6/8 dígitos (RFC 6238) |
| [js/leitor-qr.js](js/leitor-qr.js) | Encontra e lê os QR codes nas imagens; gera QR de importação |
| [js/app.js](js/app.js) | Controla a tela: fila de arquivos, verificação, tabela, exportações |
| [testes/testes.mjs](testes/testes.mjs) | Testes automáticos da lógica |
| [servidor/](servidor/) | Servidor HTTPS com login para acesso pela rede, e script que cria o certificado |
| [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml), [docker/](docker/) | Execução em contêiner Docker |
| [vendor/](vendor/) | Bibliotecas de terceiros: [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (Apache-2.0) para ler QR e [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (MIT) para gerar QR |
| [LICENCA.txt](LICENCA.txt) | Licença de uso interno |

Cada arquivo em `js/` começa com um bloco explicando o que ele faz, e cada função tem um comentário descrevendo o que recebe, o que faz e o que devolve. As bibliotecas em `vendor/` são cópias sem alteração dos originais.

## Testes

Requer [Node.js](https://nodejs.org/) 18 ou superior (apenas para desenvolvedores; usuários não precisam):

```sh
node --test testes/testes.mjs
```

## Licença

Software proprietário de Artur Teixeira, licenciado para uso exclusivamente interno da Gemma Viagens e Turismo LTDA; veja [LICENCA.txt](LICENCA.txt). As bibliotecas em `vendor/` mantêm suas próprias licenças (Apache-2.0 e MIT).

## Créditos

Inspirado em <https://gist.github.com/mapster/4b8b9f8f6b92cc1ca58ae5506e0508f7> e no projeto original [yehudah/google-authenticator-exporter](https://github.com/yehudah/google-authenticator-exporter).
