// =============================================================================
// leitor-qr.js — Encontra e lê QR codes dentro de imagens (prints ou fotos)
// -----------------------------------------------------------------------------
// Usa a biblioteca jsQR (vendor/jsQR.js), que lê UM QR code por vez.
// Para ler vários QR codes na mesma imagem, este arquivo:
//   1) lê um QR code;
//   2) pinta de branco a área onde ele estava;
//   3) procura de novo, até não achar mais nenhum.
// Também tenta a imagem em tamanhos diferentes, porque fotos muito grandes,
// muito pequenas ou tremidas costumam ser lidas melhor em outra escala.
// Também gera QR codes (para importar cada conta em outro app), usando a
// biblioteca qrcode-generator (vendor/qrcode-generator.js).
// =============================================================================

(function () {
  "use strict";

  const MAXIMO_QR_POR_IMAGEM = 12;
  const MAIOR_LADO_PERMITIDO = 2400;

  // ---------------------------------------------------------------------------
  // carregarImagem: abre o arquivo de imagem e devolve uma imagem desenhável.
  // ---------------------------------------------------------------------------
  async function carregarImagem(arquivo) {
    try {
      return await createImageBitmap(arquivo);
    } catch (e) {
      throw new Error(
        "não foi possível abrir a imagem. Use PNG, JPG, WEBP, GIF ou BMP (fotos HEIC do iPhone precisam ser convertidas)."
      );
    }
  }

  // ---------------------------------------------------------------------------
  // tamanhosParaTentar: decide em quais tamanhos (maior lado, em pixels) a
  // imagem será analisada, começando pelos que têm mais chance de funcionar.
  // ---------------------------------------------------------------------------
  function tamanhosParaTentar(maiorLado) {
    let lista;
    if (maiorLado > 2000) {
      lista = [1600, 1000, maiorLado];
    } else if (maiorLado < 500) {
      lista = [maiorLado, maiorLado * 3];
    } else {
      lista = [maiorLado, Math.round(maiorLado * 0.6), maiorLado * 2];
    }
    return lista.map(function (t) { return Math.min(t, MAIOR_LADO_PERMITIDO); })
      .filter(function (t, i, arr) { return arr.indexOf(t) === i; });
  }

  // ---------------------------------------------------------------------------
  // apagarQR: pinta de branco a região de um QR já lido, para que a próxima
  // busca encontre os outros QR codes da imagem.
  // ---------------------------------------------------------------------------
  function apagarQR(contexto, local) {
    const cantos = [local.topLeftCorner, local.topRightCorner, local.bottomRightCorner, local.bottomLeftCorner];
    const centroX = (cantos[0].x + cantos[1].x + cantos[2].x + cantos[3].x) / 4;
    const centroY = (cantos[0].y + cantos[1].y + cantos[2].y + cantos[3].y) / 4;
    contexto.fillStyle = "#ffffff";
    contexto.beginPath();
    cantos.forEach(function (c, i) {
      const x = centroX + (c.x - centroX) * 1.15;
      const y = centroY + (c.y - centroY) * 1.15;
      if (i === 0) contexto.moveTo(x, y);
      else contexto.lineTo(x, y);
    });
    contexto.closePath();
    contexto.fill();
  }

  // ---------------------------------------------------------------------------
  // lerNoTamanho: desenha a imagem em um tamanho específico e lê todos os QR
  // codes que conseguir encontrar nela.
  // ---------------------------------------------------------------------------
  function lerNoTamanho(imagem, maiorLadoDesejado) {
    const escala = maiorLadoDesejado / Math.max(imagem.width, imagem.height);
    const largura = Math.max(1, Math.round(imagem.width * escala));
    const altura = Math.max(1, Math.round(imagem.height * escala));
    const canvas = document.createElement("canvas");
    canvas.width = largura;
    canvas.height = altura;
    const contexto = canvas.getContext("2d", { willReadFrequently: true });
    contexto.fillStyle = "#ffffff";
    contexto.fillRect(0, 0, largura, altura);
    contexto.imageSmoothingQuality = "high";
    contexto.drawImage(imagem, 0, 0, largura, altura);
    const textos = [];
    for (let tentativa = 0; tentativa < MAXIMO_QR_POR_IMAGEM; tentativa++) {
      const pixels = contexto.getImageData(0, 0, largura, altura);
      const achado = jsQR(pixels.data, largura, altura, { inversionAttempts: "attemptBoth" });
      if (!achado || !achado.data) break;
      if (!textos.includes(achado.data)) textos.push(achado.data);
      apagarQR(contexto, achado.location);
    }
    return textos;
  }

  // ---------------------------------------------------------------------------
  // lerQRCodes: função principal. Recebe o arquivo de imagem e devolve a
  // lista de textos de todos os QR codes encontrados (pode ser vazia).
  // ---------------------------------------------------------------------------
  async function lerQRCodes(arquivo) {
    const imagem = await carregarImagem(arquivo);
    try {
      const maiorLado = Math.max(imagem.width, imagem.height);
      for (const tamanho of tamanhosParaTentar(maiorLado)) {
        await new Promise(function (r) { setTimeout(r, 0); });
        const textos = lerNoTamanho(imagem, tamanho);
        if (textos.length > 0) return textos;
      }
      return [];
    } finally {
      if (imagem.close) imagem.close();
    }
  }

  // ---------------------------------------------------------------------------
  // gerarQRImagem: cria a imagem (em formato data: URL) de um QR code com o
  // texto informado. Usada para mostrar o QR de importação de cada conta.
  // ---------------------------------------------------------------------------
  function gerarQRImagem(texto) {
    const qr = qrcode(0, "M");
    qr.addData(texto);
    qr.make();
    return qr.createDataURL(8, 16);
  }

  globalThis.LeitorQR = {
    lerQRCodes: lerQRCodes,
    gerarQRImagem: gerarQRImagem,
  };
})();
