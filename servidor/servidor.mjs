// =============================================================================
// servidor.mjs — Disponibiliza o Exportador para outras máquinas da rede
// -----------------------------------------------------------------------------
// Uso (na pasta do projeto, com Node.js 18+):
//   node servidor/servidor.mjs                         inicia o servidor
//   node servidor/servidor.mjs --adicionar-usuario joao   cria/altera um usuário (pede a senha)
//   node servidor/servidor.mjs --remover-usuario joao     remove um usuário
//   node servidor/servidor.mjs --listar-usuarios          lista os usuários
//
// Variáveis de ambiente (opcionais):
//   LOGIN=desligado     não pede usuário e senha (qualquer pessoa da rede acessa)
//   PORTA=8443          porta do servidor
//   ENDERECO=0.0.0.0    endereço de escuta (127.0.0.1 = só esta máquina)
//   PASTA_DADOS=...     pasta do certificado e de usuarios.json (padrão: servidor/)
//
// Como funciona:
//   - Serve apenas os arquivos da página (index.html, css/, js/, vendor/, img/,
//     fontes/). Nada mais da pasta é acessível (nem teste.txt, nem o manual,
//     nem esta pasta servidor/).
//   - Usa HTTPS (obrigatório: sem ele o navegador bloqueia o cálculo dos códigos
//     e o botão de copiar). O certificado é criado por criar-certificado.ps1.
//   - Pede usuário e senha (cadastrados com --adicionar-usuario). As senhas são
//     guardadas como hash scrypt em servidor/usuarios.json, nunca em texto puro.
//   - Bloqueia por 15 minutos um IP que errar a senha 10 vezes.
//   - Os secrets do Google Authenticator NUNCA chegam a este servidor: a leitura
//     dos QR codes acontece no navegador de quem acessa.
// =============================================================================

import https from "node:https";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PASTA_SERVIDOR = path.dirname(fileURLToPath(import.meta.url));
const PASTA_RAIZ = path.join(PASTA_SERVIDOR, "..");
const PASTA_DADOS = process.env.PASTA_DADOS || PASTA_SERVIDOR;
const ARQ_USUARIOS = path.join(PASTA_DADOS, "usuarios.json");
const ARQ_CERTIFICADO = path.join(PASTA_DADOS, "certificado.pfx");       // criado no Windows
const ARQ_SENHA_CERT = path.join(PASTA_DADOS, "certificado-senha.txt");
const ARQ_CERT_PEM = path.join(PASTA_DADOS, "certificado.crt");          // criado no Docker
const ARQ_CHAVE_PEM = path.join(PASTA_DADOS, "certificado.key");
const PORTA = Number(process.env.PORTA) || 8443;
const ENDERECO = process.env.ENDERECO || "0.0.0.0"; // ENDERECO=127.0.0.1 = só esta máquina (para testes).
const LOGIN_DESLIGADO = /^(desligado|nao|não|false|0)$/i.test(process.env.LOGIN || "");

// Somente estes caminhos podem ser baixados pelo navegador.
const ARQUIVOS_PERMITIDOS = ["index.html"];
const PASTAS_PERMITIDAS = ["css/", "js/", "vendor/", "img/", "fontes/"];

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const CABECALHOS_SEGURANCA = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const MAX_FALHAS = 10;
const JANELA_FALHAS_MS = 10 * 60 * 1000;
const BLOQUEIO_MS = 15 * 60 * 1000;

// -----------------------------------------------------------------------------
// lerUsuarios / salvarUsuarios: leem e gravam servidor/usuarios.json
// ({ "nome": "scrypt$sal$hash" }).
// -----------------------------------------------------------------------------
function lerUsuarios() {
  if (!fs.existsSync(ARQ_USUARIOS)) return {};
  return JSON.parse(fs.readFileSync(ARQ_USUARIOS, "utf8"));
}

function salvarUsuarios(usuarios) {
  fs.writeFileSync(ARQ_USUARIOS, JSON.stringify(usuarios, null, 2) + "\n");
}

// -----------------------------------------------------------------------------
// gerarHash: transforma a senha em um hash scrypt com sal aleatório.
// conferirSenha: compara uma senha digitada com o hash guardado (tempo constante).
// -----------------------------------------------------------------------------
function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, sal, 32);
  return "scrypt$" + sal.toString("hex") + "$" + hash.toString("hex");
}

function conferirSenha(senha, guardado) {
  const [tipo, salHex, hashHex] = String(guardado).split("$");
  if (tipo !== "scrypt" || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, "hex");
  const calculado = crypto.scryptSync(senha, Buffer.from(salHex, "hex"), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

// -----------------------------------------------------------------------------
// lerSenhaOculta: pergunta uma senha no terminal sem mostrar o que é digitado.
// -----------------------------------------------------------------------------
function lerSenhaOculta(pergunta) {
  return new Promise((resolver, rejeitar) => {
    const entrada = process.stdin;
    process.stdout.write(pergunta);
    if (!entrada.isTTY) return rejeitar(new Error("execute este comando em um terminal interativo"));
    let senha = "";
    entrada.setRawMode(true);
    entrada.resume();
    entrada.setEncoding("utf8");
    const aoDigitar = (tecla) => {
      for (const c of tecla) {
        if (c === "\r" || c === "\n") {
          entrada.setRawMode(false);
          entrada.pause();
          entrada.removeListener("data", aoDigitar);
          process.stdout.write("\n");
          return resolver(senha);
        }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(1); }
        if (c === "\u0008" || c === "\u007f") { if (senha.length) { senha = senha.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        senha += c;
        process.stdout.write("*");
      }
    };
    entrada.on("data", aoDigitar);
  });
}

// -----------------------------------------------------------------------------
// gerenciarUsuarios: trata os comandos --adicionar-usuario, --remover-usuario
// e --listar-usuarios. Devolve true se algum comando foi executado.
// -----------------------------------------------------------------------------
async function gerenciarUsuarios(argumentos) {
  const [comando, nome] = argumentos;
  const usuarios = lerUsuarios();
  if (comando === "--listar-usuarios") {
    const nomes = Object.keys(usuarios);
    console.log(nomes.length ? "Usuários: " + nomes.join(", ") : "Nenhum usuário cadastrado.");
    return true;
  }
  if (comando === "--adicionar-usuario" || comando === "--remover-usuario") {
    if (!nome || !/^[A-Za-z0-9._-]{2,40}$/.test(nome)) {
      console.error("Informe um nome de usuário válido (letras, números, ponto, hífen ou sublinhado).");
      process.exit(1);
    }
    if (comando === "--remover-usuario") {
      if (!usuarios[nome]) { console.error(`Usuário "${nome}" não existe.`); process.exit(1); }
      delete usuarios[nome];
      salvarUsuarios(usuarios);
      console.log(`Usuário "${nome}" removido.`);
      return true;
    }
    const senha = await lerSenhaOculta(`Senha para "${nome}" (mínimo 10 caracteres): `);
    if (senha.length < 10) { console.error("Senha curta demais."); process.exit(1); }
    const confirmacao = await lerSenhaOculta("Repita a senha: ");
    if (senha !== confirmacao) { console.error("As senhas não conferem."); process.exit(1); }
    const existia = Boolean(usuarios[nome]);
    usuarios[nome] = gerarHash(senha);
    salvarUsuarios(usuarios);
    console.log(`Usuário "${nome}" ${existia ? "atualizado" : "criado"}.`);
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Controle de tentativas de login por IP (proteção contra adivinhação de senha).
// -----------------------------------------------------------------------------
const falhasPorIP = new Map();

function ipBloqueado(ip) {
  const r = falhasPorIP.get(ip);
  return Boolean(r && r.bloqueadoAte > Date.now());
}

function registrarFalha(ip) {
  const agora = Date.now();
  const r = falhasPorIP.get(ip) || { quantidade: 0, inicio: agora, bloqueadoAte: 0 };
  if (agora - r.inicio > JANELA_FALHAS_MS) { r.quantidade = 0; r.inicio = agora; }
  r.quantidade++;
  if (r.quantidade >= MAX_FALHAS) {
    r.bloqueadoAte = agora + BLOQUEIO_MS;
    r.quantidade = 0;
    registrar(`BLOQUEIO: ${ip} errou a senha ${MAX_FALHAS} vezes; bloqueado por 15 minutos`);
  }
  falhasPorIP.set(ip, r);
}

// -----------------------------------------------------------------------------
// autenticar: confere o cabeçalho "Authorization: Basic ..." da requisição.
// Devolve o nome do usuário ou null. Logins já conferidos ficam 10 minutos em
// cache (o scrypt é lento de propósito e a página faz várias requisições).
// -----------------------------------------------------------------------------
const cacheLogins = new Map();

function autenticar(cabecalho) {
  if (!cabecalho || !cabecalho.startsWith("Basic ")) return null;
  const chaveCache = crypto.createHash("sha256").update(cabecalho).digest("hex");
  const emCache = cacheLogins.get(chaveCache);
  if (emCache && emCache.expira > Date.now()) return emCache.usuario;
  const decodificado = Buffer.from(cabecalho.slice(6), "base64").toString("utf8");
  const separador = decodificado.indexOf(":");
  if (separador < 0) return null;
  const nome = decodificado.slice(0, separador);
  const senha = decodificado.slice(separador + 1);
  const guardado = lerUsuarios()[nome];
  if (!guardado || !conferirSenha(senha, guardado)) return null;
  cacheLogins.set(chaveCache, { usuario: nome, expira: Date.now() + 10 * 60 * 1000 });
  return nome;
}

// -----------------------------------------------------------------------------
// resolverArquivo: converte o endereço pedido em um arquivo permitido.
// Devolve o caminho no disco ou null se o arquivo não pode ser servido.
// -----------------------------------------------------------------------------
function resolverArquivo(urlPedida) {
  let relativo;
  try {
    relativo = decodeURIComponent(new URL(urlPedida, "https://x").pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (relativo === "") relativo = "index.html";
  if (relativo.includes("..") || relativo.includes("\\") || relativo.includes("\0")) return null;
  const permitido = ARQUIVOS_PERMITIDOS.includes(relativo) || PASTAS_PERMITIDAS.some((p) => relativo.startsWith(p));
  if (!permitido || !TIPOS[path.extname(relativo).toLowerCase()]) return null;
  const absoluto = path.resolve(PASTA_RAIZ, relativo);
  if (!absoluto.startsWith(PASTA_RAIZ + path.sep)) return null;
  try {
    return fs.statSync(absoluto).isFile() ? absoluto : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// registrar: escreve uma linha de log com data e hora no terminal.
// -----------------------------------------------------------------------------
function registrar(mensagem) {
  console.log(new Date().toLocaleString("pt-BR") + "  " + mensagem);
}

// -----------------------------------------------------------------------------
// atender: trata cada requisição (login, segurança e envio do arquivo).
// -----------------------------------------------------------------------------
function atender(req, res) {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  for (const [nome, valor] of Object.entries(CABECALHOS_SEGURANCA)) res.setHeader(nome, valor);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  if (ipBloqueado(ip)) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("Muitas tentativas de login. Aguarde 15 minutos.");
    return;
  }
  const usuario = LOGIN_DESLIGADO ? "(sem login)" : autenticar(req.headers.authorization);
  if (!usuario) {
    if (req.headers.authorization) {
      registrarFalha(ip);
      registrar(`Senha incorreta vinda de ${ip}`);
    }
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Exportador Authenticator - Gemma", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    }).end("Acesso restrito. Informe usuário e senha.");
    return;
  }
  const arquivo = resolverArquivo(req.url);
  if (!arquivo) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Não encontrado.");
    return;
  }
  if (arquivo.endsWith("index.html")) registrar(`Acesso: ${usuario} (${ip})`);
  res.writeHead(200, { "Content-Type": TIPOS[path.extname(arquivo).toLowerCase()] });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(arquivo).pipe(res);
}

// -----------------------------------------------------------------------------
// enderecosDaRede: lista os IPs desta máquina na rede (para mostrar o link).
// -----------------------------------------------------------------------------
function enderecosDaRede() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => i.address);
}

// -----------------------------------------------------------------------------
// lerCertificado: carrega o certificado .pfx (Windows) ou .crt/.key (Docker).
// Devolve as opções para o https.createServer ou null se não encontrar.
// -----------------------------------------------------------------------------
function lerCertificado() {
  if (fs.existsSync(ARQ_CERTIFICADO) && fs.existsSync(ARQ_SENHA_CERT)) {
    return { pfx: fs.readFileSync(ARQ_CERTIFICADO), passphrase: fs.readFileSync(ARQ_SENHA_CERT, "utf8").trim() };
  }
  if (fs.existsSync(ARQ_CERT_PEM) && fs.existsSync(ARQ_CHAVE_PEM)) {
    return { cert: fs.readFileSync(ARQ_CERT_PEM), key: fs.readFileSync(ARQ_CHAVE_PEM) };
  }
  return null;
}

// -----------------------------------------------------------------------------
// iniciar: confere certificado e usuários e coloca o servidor no ar.
// -----------------------------------------------------------------------------
function iniciar() {
  const certificado = lerCertificado();
  if (!certificado) {
    console.error("Certificado não encontrado. Rode primeiro (no PowerShell, na pasta do projeto):");
    console.error("  powershell -ExecutionPolicy Bypass -File servidor\\criar-certificado.ps1");
    process.exit(1);
  }
  // Sem usuários, o servidor sobe mesmo assim (no Docker/Portainer é preciso o
  // contêiner estar rodando para abrir o console e criar o primeiro usuário),
  // mas recusa todos os acessos até que um usuário seja cadastrado.
  if (!LOGIN_DESLIGADO && !Object.keys(lerUsuarios()).length) {
    console.error("AVISO: nenhum usuário cadastrado — todos os acessos serão recusados. Crie um com:");
    console.error("  node servidor/servidor.mjs --adicionar-usuario seu.nome");
    console.error("(ou inicie com LOGIN=desligado para não pedir senha)");
  }
  const servidorHttps = https.createServer({ ...certificado, minVersion: "TLSv1.2" }, atender);

  // Quem acessar por http:// (ex.: link de porta do Portainer) é redirecionado
  // para https:// no mesmo endereço e porta.
  const servidorHttp = http.createServer((req, res) => {
    const host = String(req.headers.host || "").replace(/[^A-Za-z0-9.:\-\[\]]/g, "");
    if (!host) { res.writeHead(400).end(); return; }
    res.writeHead(301, { Location: "https://" + host + "/" }).end();
  });

  // Uma única porta atende os dois: olha o primeiro byte da conexão
  // (0x16 = início de uma conexão TLS/HTTPS) e entrega ao servidor certo.
  const servidor = net.createServer((conexao) => {
    conexao.once("data", (inicio) => {
      conexao.pause();
      conexao.unshift(inicio);
      (inicio[0] === 0x16 ? servidorHttps : servidorHttp).emit("connection", conexao);
      process.nextTick(() => conexao.resume());
    });
    conexao.on("error", () => {});
  });
  servidor.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `A porta ${PORTA} já está em uso.` : e.message);
    process.exit(1);
  });
  servidor.listen(PORTA, ENDERECO, () => {
    const nomeMaquina = os.hostname();
    console.log("Exportador do Google Authenticator — servidor no ar");
    if (LOGIN_DESLIGADO) console.log("ATENÇÃO: login DESLIGADO — qualquer pessoa que alcance esta porta pode abrir a página.");
    console.log("Endereços para acessar de outras máquinas:");
    const nomes = (process.env.NOMES_CERTIFICADO || "").split(",").map((n) => n.trim()).filter((n) => n && n !== "localhost");
    if (nomes.length) {
      for (const n of nomes) console.log(`  https://${n}:${PORTA}/`);
    } else {
      console.log(`  https://${nomeMaquina}:${PORTA}/`);
      for (const ip of enderecosDaRede()) console.log(`  https://${ip}:${PORTA}/`);
    }
    console.log("Mantenha esta janela aberta. Para encerrar: Ctrl+C.");
  });
}

const argumentos = process.argv.slice(2);
if (!(await gerenciarUsuarios(argumentos))) {
  if (argumentos.length) {
    console.error("Opção desconhecida: " + argumentos.join(" "));
    process.exit(1);
  }
  iniciar();
}
