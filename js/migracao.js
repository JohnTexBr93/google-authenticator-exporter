// =============================================================================
// migracao.js — Interpreta o texto lido de um QR code
// -----------------------------------------------------------------------------
// Aceita dois tipos de link:
//   1) otpauth-migration://offline?data=...  -> exportação do Google Authenticator
//                                               (várias contas por QR code)
//   2) otpauth://totp/Servico:conta?secret=... -> QR de uma única conta (padrão
//                                               usado por sites ao ativar o 2FA)
// Para cada link devolve um "resultado" com as contas encontradas, a posição
// do QR dentro da exportação ("QR 2 de 4") ou a mensagem de erro.
// Depende de: js/protobuf.js (precisa ser carregado antes deste arquivo).
// =============================================================================

(function () {
  "use strict";

  const REGEX_LINK = /otpauth(?:-migration)?:\/\/[^\s"'<>]+/gi; // Usada por extrairLinks.

  const ALFABETO_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  const NOMES_ALGORITMO = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512", 4: "MD5" };

  // ---------------------------------------------------------------------------
  // extrairLinks: encontra todos os links otpauth em um texto qualquer
  // (conteúdo de um .txt, texto colado, conteúdo de um QR code).
  // ---------------------------------------------------------------------------
  function extrairLinks(texto) {
    return String(texto || "").match(REGEX_LINK) || [];
  }

  // ---------------------------------------------------------------------------
  // codificarBase32: converte bytes no texto Base32 sem "=" no final, que é o
  // formato que os apps autenticadores esperam para o secret.
  // ---------------------------------------------------------------------------
  function codificarBase32(bytes) {
    let saida = "";
    let acumulador = 0;
    let bits = 0;
    for (const byte of bytes) {
      acumulador = (acumulador << 8) | byte;
      bits = bits + 8;
      while (bits >= 5) {
        saida = saida + ALFABETO_BASE32[(acumulador >>> (bits - 5)) & 31];
        bits = bits - 5;
      }
      acumulador = acumulador & ((1 << bits) - 1);
    }
    if (bits > 0) {
      saida = saida + ALFABETO_BASE32[(acumulador << (5 - bits)) & 31];
    }
    return saida;
  }

  // ---------------------------------------------------------------------------
  // base32Valido: confere se um secret digitado/lido é Base32 válido.
  // ---------------------------------------------------------------------------
  function base32Valido(texto) {
    return /^[A-Z2-7]+$/.test(texto);
  }

  // ---------------------------------------------------------------------------
  // decodificarBase64: converte o parâmetro "data" em bytes, tolerando os
  // defeitos mais comuns introduzidos por leitores de QR code:
  //   - "+" que virou espaço;  - variante "URL-safe" (- e _);  - "=" faltando.
  // ---------------------------------------------------------------------------
  function decodificarBase64(texto) {
    let limpo = texto.replace(/ /g, "+");
    limpo = limpo.replace(/-/g, "+").replace(/_/g, "/");
    limpo = limpo.replace(/=+$/, "");
    if (!/^[A-Za-z0-9+/]*$/.test(limpo) || limpo.length % 4 === 1) {
      throw new Error("o parâmetro data não é Base64 válido (link cortado?)");
    }
    while (limpo.length % 4 !== 0) limpo = limpo + "=";
    const binario = atob(limpo);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // montarURI: cria o link otpauth:// de uma conta. Esse link (ou o QR gerado
  // a partir dele) pode ser importado em qualquer app autenticador.
  // Formato: otpauth://totp/Servico:conta?secret=...&issuer=...&algorithm=...
  // ---------------------------------------------------------------------------
  function montarURI(conta) {
    let rotulo = encodeURIComponent(conta.nome);
    if (conta.emissor && !conta.nome.startsWith(conta.emissor + ":")) {
      rotulo = encodeURIComponent(conta.emissor) + ":" + rotulo;
    }
    const partes = ["secret=" + conta.secret];
    if (conta.emissor) partes.push("issuer=" + encodeURIComponent(conta.emissor));
    partes.push("algorithm=" + conta.algoritmo);
    partes.push("digits=" + conta.digitos);
    if (conta.tipo === "hotp") {
      partes.push("counter=" + conta.contador);
    } else {
      partes.push("period=" + conta.periodo);
    }
    return "otpauth://" + conta.tipo + "/" + rotulo + "?" + partes.join("&");
  }

  // ---------------------------------------------------------------------------
  // contaDoGoogle: converte uma conta decodificada do protobuf (formato do
  // Google) no formato usado pelo restante do programa.
  // ---------------------------------------------------------------------------
  function contaDoGoogle(c) {
    const conta = {
      emissor: c.issuer,
      nome: c.name,
      secret: codificarBase32(c.secret),
      tipo: c.type === 1 ? "hotp" : "totp",
      algoritmo: NOMES_ALGORITMO[c.algorithm] || "SHA1",
      digitos: c.digits === 2 ? 8 : 6,
      periodo: 30,
      contador: Number(c.counter),
      uri: "",
    };
    if (conta.tipo === "hotp") conta.periodo = 0;
    conta.uri = montarURI(conta);
    return conta;
  }

  // ---------------------------------------------------------------------------
  // contaDeOtpauth: lê um link otpauth:// de conta única.
  // Exemplo: otpauth://totp/Servico:joao?secret=JBSWY3DP&digits=6&period=30
  // ---------------------------------------------------------------------------
  function contaDeOtpauth(link) {
    const url = new URL(link);
    const tipo = url.hostname.toLowerCase();
    if (tipo !== "totp" && tipo !== "hotp") {
      throw new Error('tipo otpauth desconhecido: "' + url.hostname + '"');
    }
    const p = url.searchParams;
    const rotulo = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const doisPontos = rotulo.indexOf(":");
    const conta = {
      emissor: p.get("issuer") || (doisPontos >= 0 ? rotulo.slice(0, doisPontos).trim() : ""),
      nome: doisPontos >= 0 ? rotulo.slice(doisPontos + 1).trim() : rotulo,
      secret: (p.get("secret") || "").replace(/\s/g, "").replace(/=+$/, "").toUpperCase(),
      tipo: tipo,
      algoritmo: (p.get("algorithm") || "SHA1").toUpperCase().replace(/-/g, ""),
      digitos: parseInt(p.get("digits"), 10) || 6,
      periodo: tipo === "totp" ? parseInt(p.get("period"), 10) || 30 : 0,
      contador: tipo === "hotp" ? parseInt(p.get("counter"), 10) || 0 : 0,
      uri: "",
    };
    if (!conta.secret) throw new Error("link otpauth sem secret");
    if (!base32Valido(conta.secret)) throw new Error("secret inválido (não é Base32)");
    conta.uri = montarURI(conta);
    return conta;
  }

  // ---------------------------------------------------------------------------
  // analisarLink: função principal deste arquivo. Recebe o texto de UM link e
  // devolve um resultado com o tipo, as contas, a posição no lote e/ou o erro.
  // ---------------------------------------------------------------------------
  function analisarLink(texto) {
    texto = String(texto || "").trim();
    const resultado = {
      texto: texto,
      tipo: "desconhecido",
      erro: "",
      loteId: 0,
      loteIndice: 0,
      loteTamanho: 1,
      contas: [],
    };
    const minusculo = texto.toLowerCase();
    try {
      if (minusculo.startsWith("otpauth-migration://")) {
        resultado.tipo = "migracao";
        const url = new URL(texto);
        const data = url.searchParams.get("data");
        if (!data) throw new Error("parâmetro data ausente no link");
        const payload = Protobuf.decodificarPayload(decodificarBase64(data));
        resultado.loteId = payload.loteId;
        resultado.loteIndice = payload.loteIndice;
        resultado.loteTamanho = Math.max(1, payload.loteTamanho);
        resultado.contas = payload.contas.map(contaDoGoogle);
      } else if (minusculo.startsWith("otpauth://")) {
        resultado.tipo = "otpauth";
        resultado.contas = [contaDeOtpauth(texto)];
      } else {
        throw new Error("o QR code não contém um link do Google Authenticator (otpauth-migration:// ou otpauth://)");
      }
    } catch (e) {
      resultado.erro = e.message || String(e);
      resultado.contas = [];
    }
    return resultado;
  }

  globalThis.Migracao = {
    extrairLinks: extrairLinks,
    analisarLink: analisarLink,
    codificarBase32: codificarBase32,
  };
})();
