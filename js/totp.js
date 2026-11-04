// =============================================================================
// totp.js — Calcula o código de 6/8 dígitos de cada conta
// -----------------------------------------------------------------------------
// É o mesmo cálculo que o app autenticador faz no celular (RFC 4226 / RFC 6238):
//   1) Pega o secret (bytes) e um "contador".
//      - TOTP: contador = segundos desde 1970 ÷ período (30s)  -> muda a cada 30s
//      - HOTP: contador = número guardado na conta             -> muda a cada uso
//   2) Calcula HMAC(secret, contador) com SHA1/SHA256/SHA512.
//   3) Extrai 31 bits do resultado e pega os últimos 6 (ou 8) dígitos.
// Usa a criptografia nativa do navegador (crypto.subtle) — nada sai do computador.
// Mostrar o código atual serve para conferir se a exportação está correta:
// o código da tabela deve ser igual ao do celular.
// =============================================================================

(function () {
  "use strict";

  const HASH_WEBCRYPTO = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

  const ALFABETO_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  const cacheChaves = new Map();

  // ---------------------------------------------------------------------------
  // decodificarBase32: converte o secret em texto Base32 de volta para bytes.
  // ---------------------------------------------------------------------------
  function decodificarBase32(texto) {
    const limpo = texto.toUpperCase().replace(/[=\s]/g, "");
    const bytes = [];
    let acumulador = 0;
    let bits = 0;
    for (const letra of limpo) {
      const valor = ALFABETO_BASE32.indexOf(letra);
      if (valor < 0) throw new Error("secret em Base32 inválido");
      acumulador = (acumulador << 5) | valor;
      bits = bits + 5;
      if (bits >= 8) {
        bytes.push((acumulador >>> (bits - 8)) & 0xff);
        bits = bits - 8;
      }
      acumulador = acumulador & ((1 << bits) - 1);
    }
    return new Uint8Array(bytes);
  }

  // ---------------------------------------------------------------------------
  // obterChave: prepara (uma única vez) a chave HMAC de uma conta.
  // ---------------------------------------------------------------------------
  async function obterChave(secret, nomeHash) {
    const id = nomeHash + ":" + secret;
    if (!cacheChaves.has(id)) {
      const chave = crypto.subtle.importKey(
        "raw",
        decodificarBase32(secret),
        { name: "HMAC", hash: nomeHash },
        false,
        ["sign"]
      );
      cacheChaves.set(id, chave);
    }
    return cacheChaves.get(id);
  }

  // ---------------------------------------------------------------------------
  // gerarCodigo: calcula o código de uma conta para um contador.
  // Retorna o código em texto (ex.: "042817") ou null se o algoritmo não
  // for suportado pelo navegador (MD5).
  // ---------------------------------------------------------------------------
  async function gerarCodigo(conta, contador) {
    const nomeHash = HASH_WEBCRYPTO[conta.algoritmo];
    if (!nomeHash) return null;
    const chave = await obterChave(conta.secret, nomeHash);
    const mensagem = new DataView(new ArrayBuffer(8));
    mensagem.setUint32(0, Math.floor(contador / 4294967296));
    mensagem.setUint32(4, contador >>> 0);
    const assinatura = await crypto.subtle.sign("HMAC", chave, mensagem.buffer);
    const h = new Uint8Array(assinatura);
    const deslocamento = h[h.length - 1] & 0x0f;
    const numero =
      ((h[deslocamento] & 0x7f) << 24) |
      (h[deslocamento + 1] << 16) |
      (h[deslocamento + 2] << 8) |
      h[deslocamento + 3];
    const codigo = numero % Math.pow(10, conta.digitos);
    return String(codigo).padStart(conta.digitos, "0");
  }

  // ---------------------------------------------------------------------------
  // contadorAtual: devolve o contador a usar agora para uma conta.
  // ---------------------------------------------------------------------------
  function contadorAtual(conta, agoraSegundos) {
    if (conta.tipo === "hotp") return conta.contador;
    return Math.floor(agoraSegundos / conta.periodo);
  }

  // ---------------------------------------------------------------------------
  // limparCache: esquece as chaves preparadas (usado no botão "Limpar tudo").
  // ---------------------------------------------------------------------------
  function limparCache() {
    cacheChaves.clear();
  }

  globalThis.Totp = {
    gerarCodigo: gerarCodigo,
    contadorAtual: contadorAtual,
    limparCache: limparCache,
  };
})();
