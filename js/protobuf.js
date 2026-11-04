// =============================================================================
// protobuf.js — Leitor do formato binário usado pelo Google Authenticator
// -----------------------------------------------------------------------------
// O QR code de exportação do Google Authenticator contém um link assim:
//     otpauth-migration://offline?data=CjEKCkhlbGxv...
// O texto depois de "data=" é Base64. Ao decodificar o Base64 obtemos bytes
// no formato "Protocol Buffers" (protobuf), um formato binário do Google.
// Este arquivo transforma esses bytes em um objeto JavaScript comum.
//
// Estrutura da mensagem (igual ao arquivo versao-go/migration-payload.proto):
//   MigrationPayload {
//     1: otp_parameters (lista de contas)  4: batch_index (nº deste QR, começa em 0)
//     2: version                            5: batch_id    (identifica a exportação)
//     3: batch_size (total de QR codes)
//   }
//   OtpParameters {
//     1: secret (bytes)  2: name  3: issuer  4: algorithm  5: digits  6: type  7: counter
//   }
// =============================================================================

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Tipos de campo ("wire types") definidos pelo formato protobuf.
  // ---------------------------------------------------------------------------
  const TIPO_VARINT = 0;
  const TIPO_64BITS = 1;
  const TIPO_TAMANHO = 2;
  const TIPO_32BITS = 5;

  const decodificadorUTF8 = new TextDecoder("utf-8");

  // ---------------------------------------------------------------------------
  // lerVarint: lê um número "varint" a partir da posição indicada.
  // Em um varint, cada byte guarda 7 bits do número; o 8º bit (0x80) indica
  // se ainda há mais bytes. Usamos BigInt porque o número pode ter até 64 bits.
  // Retorna { valor: BigInt, pos: próxima posição a ler }.
  // ---------------------------------------------------------------------------
  function lerVarint(bytes, pos) {
    let resultado = 0n;
    let deslocamento = 0n;
    while (true) {
      if (pos >= bytes.length) {
        throw new Error("dados truncados (o link parece estar cortado)");
      }
      const byte = bytes[pos];
      pos = pos + 1;
      resultado = resultado | (BigInt(byte & 0x7f) << deslocamento);
      if ((byte & 0x80) === 0) {
        return { valor: resultado, pos: pos };
      }
      deslocamento = deslocamento + 7n;
      if (deslocamento > 63n) {
        throw new Error("número varint inválido");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // lerCampos: percorre uma mensagem protobuf e devolve a lista de campos.
  // Cada campo começa com uma "chave" (varint) que diz o número do campo e o
  // tipo. Depois vem o valor, cujo formato depende do tipo.
  // Retorna uma lista de { numero, tipo, valor }.
  // ---------------------------------------------------------------------------
  function lerCampos(bytes) {
    const campos = [];
    let pos = 0;
    while (pos < bytes.length) {
      const chave = lerVarint(bytes, pos);
      pos = chave.pos;
      const numero = Number(chave.valor >> 3n);
      const tipo = Number(chave.valor & 7n);
      if (tipo === TIPO_VARINT) {
        const v = lerVarint(bytes, pos);
        pos = v.pos;
        campos.push({ numero: numero, tipo: tipo, valor: v.valor });
      } else if (tipo === TIPO_TAMANHO) {
        const tamanho = lerVarint(bytes, pos);
        pos = tamanho.pos;
        const fim = pos + Number(tamanho.valor);
        if (fim > bytes.length) {
          throw new Error("dados truncados (o link parece estar cortado)");
        }
        campos.push({ numero: numero, tipo: tipo, valor: bytes.subarray(pos, fim) });
        pos = fim;
      } else if (tipo === TIPO_64BITS) {
        pos = pos + 8;
      } else if (tipo === TIPO_32BITS) {
        pos = pos + 4;
      } else {
        throw new Error("formato inválido (tipo de campo " + tipo + ")");
      }
      if (pos > bytes.length) {
        throw new Error("dados truncados (o link parece estar cortado)");
      }
    }
    return campos;
  }

  // ---------------------------------------------------------------------------
  // paraInt32: converte um varint (BigInt) em número inteiro de 32 bits com
  // sinal, do mesmo jeito que o protobuf faz com campos "int32".
  // ---------------------------------------------------------------------------
  function paraInt32(valorBigInt) {
    return Number(BigInt.asIntN(32, valorBigInt));
  }

  // ---------------------------------------------------------------------------
  // decodificarConta: transforma os bytes de um "OtpParameters" em objeto.
  // Os valores padrão (0, "", bytes vazios) seguem a regra do protobuf:
  // campos ausentes valem zero/vazio.
  // ---------------------------------------------------------------------------
  function decodificarConta(bytes) {
    const conta = {
      secret: new Uint8Array(0),
      name: "",
      issuer: "",
      algorithm: 0,
      digits: 0,
      type: 0,
      counter: 0n,
    };
    for (const campo of lerCampos(bytes)) {
      if (campo.numero === 1 && campo.tipo === TIPO_TAMANHO) conta.secret = campo.valor;
      if (campo.numero === 2 && campo.tipo === TIPO_TAMANHO) conta.name = decodificadorUTF8.decode(campo.valor);
      if (campo.numero === 3 && campo.tipo === TIPO_TAMANHO) conta.issuer = decodificadorUTF8.decode(campo.valor);
      if (campo.numero === 4 && campo.tipo === TIPO_VARINT) conta.algorithm = paraInt32(campo.valor);
      if (campo.numero === 5 && campo.tipo === TIPO_VARINT) conta.digits = paraInt32(campo.valor);
      if (campo.numero === 6 && campo.tipo === TIPO_VARINT) conta.type = paraInt32(campo.valor);
      if (campo.numero === 7 && campo.tipo === TIPO_VARINT) conta.counter = BigInt.asIntN(64, campo.valor);
    }
    return conta;
  }

  // ---------------------------------------------------------------------------
  // decodificarPayload: função principal deste arquivo. Recebe os bytes do
  // parâmetro "data" (já sem Base64) e devolve o conteúdo do QR code.
  // ---------------------------------------------------------------------------
  function decodificarPayload(bytes) {
    const payload = {
      contas: [],
      versao: 0,
      loteTamanho: 0,
      loteIndice: 0,
      loteId: 0,
    };
    for (const campo of lerCampos(bytes)) {
      if (campo.numero === 1 && campo.tipo === TIPO_TAMANHO) payload.contas.push(decodificarConta(campo.valor));
      if (campo.numero === 2 && campo.tipo === TIPO_VARINT) payload.versao = paraInt32(campo.valor);
      if (campo.numero === 3 && campo.tipo === TIPO_VARINT) payload.loteTamanho = paraInt32(campo.valor);
      if (campo.numero === 4 && campo.tipo === TIPO_VARINT) payload.loteIndice = paraInt32(campo.valor);
      if (campo.numero === 5 && campo.tipo === TIPO_VARINT) payload.loteId = paraInt32(campo.valor);
    }
    return payload;
  }

  globalThis.Protobuf = { decodificarPayload: decodificarPayload };
})();
