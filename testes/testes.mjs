// =============================================================================
// testes/testes.mjs — Testes automáticos da lógica (sem abrir o navegador)
// -----------------------------------------------------------------------------
// Como rodar (na pasta do projeto):   node --test testes/testes.mjs
// Usa apenas contas FICTÍCIAS. Testa: leitura do formato do Google, links
// cortados, links otpauth:// e o cálculo dos códigos (vetores oficiais RFC).
// A leitura de QR em imagens é testada no navegador (precisa de <canvas>).
// =============================================================================

import { test } from "node:test"; // Executor de testes nativo do Node.
import assert from "node:assert/strict"; // Funções de verificação (assert.equal etc.).
import { readFileSync } from "node:fs"; // Leitura de arquivos.
import vm from "node:vm"; // Executa os scripts da página dentro do Node.
import { fileURLToPath } from "node:url"; // Converte o endereço deste arquivo em caminho.
import path from "node:path"; // Monta caminhos de arquivo.

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."); // Pasta do projeto.
const contexto = vm.createContext({ TextDecoder, URL, atob, crypto: globalThis.crypto }); // "Janela" falsa com o que os scripts usam.
contexto.globalThis = contexto; // Os scripts publicam suas funções em globalThis.
for (const arquivo of ["js/protobuf.js", "js/migracao.js", "js/totp.js"]) { // Carrega os scripts na ordem da página...
  vm.runInContext(readFileSync(path.join(raiz, arquivo), "utf8"), contexto, { filename: arquivo }); // ...executando cada um.
} // Fim do carregamento.
const { Migracao, Totp } = contexto; // Pega os objetos publicados pelos scripts.

// ---------- Codificador protobuf mínimo (só para montar dados de teste) ----------
function varint(n) { // Converte um número em bytes varint.
  const bytes = []; // Bytes resultantes.
  let v = BigInt.asUintN(64, BigInt(n)); // Trabalha com 64 bits sem sinal (aceita negativos).
  do { // Repete...
    let b = Number(v & 0x7fn); // ...pega 7 bits...
    v >>= 7n; // ...remove esses bits...
    if (v) b |= 0x80; // ...marca que há mais bytes...
    bytes.push(b); // ...e guarda.
  } while (v); // ...até acabar.
  return bytes; // Devolve os bytes.
} // Fim de varint.
const campoNum = (numero, valor) => [...varint(numero << 3), ...varint(valor)]; // Campo do tipo número.
const campoBytes = (numero, bytes) => [...varint((numero << 3) | 2), ...varint(bytes.length), ...bytes]; // Campo do tipo bytes.
const texto = (s) => [...new TextEncoder().encode(s)]; // Texto -> bytes UTF-8.

function linkFicticio(indice, total, nomes, extras = {}) { // Monta um link de migração com contas fictícias.
  let payload = []; // Bytes da mensagem.
  nomes.forEach((nome, i) => { // Para cada conta...
    const conta = [ // ...monta os campos da conta:
      ...campoBytes(1, texto("12345678901234567890".slice(0, 10 + i))), // secret;
      ...campoBytes(2, texto(nome)), // nome;
      ...campoBytes(3, texto(extras.emissor ?? "Exemplo")), // emissor;
      ...campoNum(4, extras.algoritmo ?? 1), // algoritmo;
      ...campoNum(5, extras.digitos ?? 1), // dígitos;
      ...campoNum(6, extras.tipo ?? 2), // tipo;
      ...(extras.contador ? campoNum(7, extras.contador) : []), // contador (opcional).
    ]; // Fim da conta.
    payload = payload.concat(campoBytes(1, conta)); // Acrescenta a conta à mensagem.
  }); // Fim do laço.
  payload = payload.concat(campoNum(2, 1), campoNum(3, total), campoNum(4, indice), campoNum(5, extras.loteId ?? -123456)); // Campos do lote.
  const base64 = Buffer.from(payload).toString("base64"); // Bytes -> Base64.
  return "otpauth-migration://offline?data=" + encodeURIComponent(base64); // Link completo.
} // Fim de linkFicticio.

// ---------- Testes ----------
test("lê link de migração com várias contas e dados do lote", () => { // Teste 1.
  const r = Migracao.analisarLink(linkFicticio(1, 3, ["ana@exemplo.com", "bob@exemplo.com"])); // Analisa um QR 2 de 3.
  assert.equal(r.erro, ""); // Não deve haver erro.
  assert.equal(r.tipo, "migracao"); // Tipo correto.
  assert.equal(r.loteIndice, 1); // Posição 1 (= "QR 2").
  assert.equal(r.loteTamanho, 3); // Total 3.
  assert.equal(r.loteId, -123456); // Id negativo lido corretamente (int32 com sinal).
  assert.equal(r.contas.length, 2); // Duas contas.
  assert.equal(r.contas[0].secret, "GEZDGNBVGY3TQOJQ"); // Mesmo secret que a versão em Go gerava.
  assert.equal(r.contas[0].digitos, 6); // 1 = seis dígitos.
  assert.equal(r.contas[0].uri, "otpauth://totp/Exemplo:ana%40exemplo.com?secret=GEZDGNBVGY3TQOJQ&issuer=Exemplo&algorithm=SHA1&digits=6&period=30"); // Link montado.
}); // Fim do teste 1.

test("lê acentos, SHA256, 8 dígitos e HOTP", () => { // Teste 2.
  const r = Migracao.analisarLink(linkFicticio(0, 1, ["joão"], { emissor: "Serviço Ç", algoritmo: 2, digitos: 2, tipo: 1, contador: 7 })); // Conta especial.
  const c = r.contas[0]; // A conta.
  assert.equal(c.nome, "joão"); // Acento preservado.
  assert.equal(c.emissor, "Serviço Ç"); // Acento preservado.
  assert.equal(c.algoritmo, "SHA256"); // Algoritmo 2.
  assert.equal(c.digitos, 8); // Dígitos 2 = oito.
  assert.equal(c.tipo, "hotp"); // Tipo 1 = HOTP.
  assert.equal(c.contador, 7); // Contador.
}); // Fim do teste 2.

test("tolera '+' trocado por espaço e falta de '='", () => { // Teste 3.
  const original = linkFicticio(0, 1, ["x", "y", "z", "w"]); // Link válido.
  const data = decodeURIComponent(original.split("data=")[1]); // Base64 puro.
  const estragado = "otpauth-migration://offline?data=" + data.replace(/\+/g, " ").replace(/=+$/, ""); // Simula leitor de QR ruim.
  const r = Migracao.analisarLink(estragado); // Analisa.
  assert.equal(r.erro, ""); // Deve funcionar mesmo assim.
  assert.equal(r.contas.length, 4); // Todas as contas.
}); // Fim do teste 3.

test("link cortado gera erro claro", () => { // Teste 4.
  const link = linkFicticio(0, 1, ["conta-com-nome-longo@exemplo.com"]); // Link válido.
  const r = Migracao.analisarLink(link.slice(0, link.length - 20)); // Corta o final.
  assert.notEqual(r.erro, ""); // Deve ter erro.
  assert.equal(r.contas.length, 0); // Sem contas parciais.
  assert.match(Migracao.analisarLink("https://exemplo.com").erro, /não contém um link/); // Outro tipo de QR.
}); // Fim do teste 4.

test("lê link otpauth:// de conta única", () => { // Teste 5.
  const r = Migracao.analisarLink("otpauth://totp/Servico:joao?secret=JBSWY3DPEHPK3PXP&digits=8&period=60"); // Link padrão.
  const c = r.contas[0]; // A conta.
  assert.equal(c.emissor, "Servico"); // Emissor do rótulo.
  assert.equal(c.nome, "joao"); // Nome do rótulo.
  assert.equal(c.digitos, 8); // Dígitos.
  assert.equal(c.periodo, 60); // Período.
  assert.match(Migracao.analisarLink("otpauth://totp/x?secret=INVALIDO1").erro, /Base32/); // Secret inválido.
}); // Fim do teste 5.

test("extrai vários links de um texto", () => { // Teste 6.
  const t = "linha 1: " + linkFicticio(0, 2, ["a"]) + "\nlixo\n" + linkFicticio(1, 2, ["b"]) + " fim"; // Texto misturado.
  assert.equal(Migracao.extrairLinks(t).length, 2); // Dois links encontrados.
}); // Fim do teste 6.

test("códigos batem com os vetores oficiais da RFC 6238", async () => { // Teste 7.
  const b32 = (s) => Migracao.codificarBase32(new TextEncoder().encode(s)); // Texto -> Base32.
  const casos = [ // [algoritmo, chave, segundos, código esperado]
    ["SHA1", "12345678901234567890", 59, "94287082"], // Vetor RFC.
    ["SHA1", "12345678901234567890", 1111111109, "07081804"], // Vetor RFC.
    ["SHA1", "12345678901234567890", 20000000000, "65353130"], // Vetor RFC (ano 2603).
    ["SHA256", "12345678901234567890123456789012", 59, "46119246"], // Vetor RFC.
    ["SHA512", "1234567890123456789012345678901234567890123456789012345678901234", 59, "90693936"], // Vetor RFC.
  ]; // Fim dos casos.
  for (const [algoritmo, chave, segundos, esperado] of casos) { // Para cada caso...
    const conta = { algoritmo, secret: b32(chave), digitos: 8, tipo: "totp", periodo: 30 }; // ...monta a conta...
    const codigo = await Totp.gerarCodigo(conta, Totp.contadorAtual(conta, segundos)); // ...calcula...
    assert.equal(codigo, esperado, algoritmo + " em " + segundos); // ...e compara.
  } // Fim do laço.
  assert.equal(await Totp.gerarCodigo({ algoritmo: "MD5", secret: "GEZDGNBV", digitos: 6 }, 1), null); // MD5: não suportado.
}); // Fim do teste 7.
