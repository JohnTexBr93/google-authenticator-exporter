// =============================================================================
// app.js — Controla a tela (botões, lista de imagens, verificação e tabela)
// -----------------------------------------------------------------------------
// Fluxo geral:
//   1) O usuário adiciona imagens/textos (arrastar, escolher, Ctrl+V, colar links).
//   2) Cada item entra numa fila e é processado um por vez:
//        imagem -> LeitorQR.lerQRCodes -> textos -> Migracao.analisarLink
//        texto  -> Migracao.extrairLinks -> Migracao.analisarLink
//   3) Os links válidos ficam guardados em "estado.links" (sem repetir).
//   4) A tela é redesenhada: verificação dos lotes ("QR 2 de 4") e tabela.
//   5) A cada segundo, os códigos atuais (TOTP) são recalculados.
// Os dados ficam SOMENTE na memória desta aba; fechar/recarregar apaga tudo.
// Depende de: protobuf.js, migracao.js, totp.js, leitor-qr.js e das bibliotecas em vendor/.
// =============================================================================

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------------------
  // Estado da aplicação (tudo o que foi lido até agora). Só existe na memória.
  // ---------------------------------------------------------------------------
  const estado = {
    arquivos: [],
    links: new Map(),
    erros: [],
    mostrarTodos: false,
    revelados: new Set(),
  };
  let contas = [];
  let proximoId = 0;
  const fila = [];
  let processando = false;
  const ultimoContador = new Map();

  // ===========================================================================
  // 1) ENTRADA DE ARQUIVOS E TEXTOS
  // ===========================================================================

  const areaSoltar = $("soltar");
  const seletorArquivo = $("arquivo");

  areaSoltar.addEventListener("click", function () { seletorArquivo.click(); });
  areaSoltar.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); seletorArquivo.click(); }
  });
  seletorArquivo.addEventListener("change", function () {
    enfileirarArquivos(Array.from(seletorArquivo.files));
    seletorArquivo.value = "";
  });

  ["dragenter", "dragover"].forEach(function (evento) {
    window.addEventListener(evento, function (e) { e.preventDefault(); areaSoltar.classList.add("arrastando"); });
  });
  window.addEventListener("dragleave", function (e) {
    if (e.relatedTarget === null) areaSoltar.classList.remove("arrastando");
  });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    areaSoltar.classList.remove("arrastando");
    if (e.dataTransfer && e.dataTransfer.files.length) enfileirarArquivos(Array.from(e.dataTransfer.files));
  });

  document.addEventListener("paste", function (e) {
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    const itens = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const imagens = itens
      .filter(function (item) { return item.kind === "file"; })
      .map(function (item) { return item.getAsFile(); })
      .filter(Boolean)
      .map(function (arq) { return new File([arq], "colado-" + horaCompacta() + ".png", { type: arq.type }); });
    if (imagens.length) { e.preventDefault(); enfileirarArquivos(imagens); return; }
    const texto = (e.clipboardData && e.clipboardData.getData("text")) || "";
    if (/otpauth/i.test(texto)) { e.preventDefault(); enfileirarTexto(texto, "texto colado"); }
  });

  $("btnTexto").addEventListener("click", function () {
    const texto = $("caixaLinks").value.trim();
    if (!texto) return;
    enfileirarTexto(texto, "texto colado");
    $("caixaLinks").value = "";
  });

  // ---------------------------------------------------------------------------
  // enfileirarArquivos: registra cada arquivo na tela e o coloca na fila.
  // ---------------------------------------------------------------------------
  function enfileirarArquivos(lista) {
    for (const arq of lista) {
      const ehTexto = arq.type.indexOf("text/") === 0 || /\.txt$/i.test(arq.name);
      const ehImagem = arq.type.indexOf("image/") === 0 || /\.(png|jpe?g|gif|webp|bmp)$/i.test(arq.name);
      if (!ehTexto && !ehImagem) { avisar("Arquivo ignorado: " + arq.name); continue; }
      const item = {
        id: ++proximoId,
        nome: arq.name,
        tipo: ehTexto ? "texto" : "imagem",
        url: ehTexto ? null : URL.createObjectURL(arq),
        situacao: "carregando",
        mensagem: "Na fila…",
      };
      estado.arquivos.push(item);
      fila.push({ item: item, arquivo: arq });
    }
    desenharArquivos();
    processarFila();
  }

  // ---------------------------------------------------------------------------
  // enfileirarTexto: registra um texto colado e o coloca na fila.
  // ---------------------------------------------------------------------------
  function enfileirarTexto(texto, nome) {
    const item = { id: ++proximoId, nome: nome, tipo: "texto", url: null, situacao: "carregando", mensagem: "Na fila…" };
    estado.arquivos.push(item);
    fila.push({ item: item, texto: texto });
    desenharArquivos();
    processarFila();
  }

  // ---------------------------------------------------------------------------
  // processarFila: processa os itens da fila, um de cada vez.
  // ---------------------------------------------------------------------------
  async function processarFila() {
    if (processando) return;
    processando = true;
    while (fila.length) {
      const tarefa = fila.shift();
      tarefa.item.mensagem = "Lendo…";
      desenharArquivos();
      try {
        let textos;
        if (tarefa.item.tipo === "imagem") {
          textos = await LeitorQR.lerQRCodes(tarefa.arquivo);
          if (!textos.length) throw new Error("nenhum QR code encontrado. Tente um print mais nítido, com o QR inteiro visível.");
        } else {
          const conteudo = tarefa.texto !== undefined ? tarefa.texto : await tarefa.arquivo.text();
          textos = [conteudo];
        }
        aplicarTextos(tarefa.item, textos);
      } catch (e) {
        tarefa.item.situacao = "erro";
        tarefa.item.mensagem = e.message || String(e);
        estado.erros.push({ origem: tarefa.item.nome, mensagem: tarefa.item.mensagem });
      }
      desenharTudo();
    }
    processando = false;
    desenharTudo();
  }

  // ---------------------------------------------------------------------------
  // aplicarTextos: extrai os links dos textos, analisa e guarda cada um.
  // Atualiza a mensagem do item (ex.: "QR 2/4 · 1 já lido").
  // ---------------------------------------------------------------------------
  function aplicarTextos(item, textos) {
    let novos = 0;
    let repetidos = 0;
    let comErro = 0;
    const rotulos = [];
    for (const texto of textos) {
      let links = Migracao.extrairLinks(texto);
      if (!links.length) links = [texto];
      for (const link of links) {
        const r = Migracao.analisarLink(link);
        if (r.erro) {
          comErro++;
          estado.erros.push({ origem: item.nome, mensagem: r.erro });
          continue;
        }
        const existente = estado.links.get(r.texto);
        if (existente) {
          existente.origens.add(item.nome);
          repetidos++;
        } else {
          r.origens = new Set([item.nome]);
          estado.links.set(r.texto, r);
          novos++;
        }
        rotulos.push(r.tipo === "migracao" ? "QR " + (r.loteIndice + 1) + "/" + r.loteTamanho : "otpauth");
      }
    }
    const partes = [];
    if (rotulos.length) partes.push(rotulos.join(", "));
    if (repetidos) partes.push(repetidos + " já lido(s)");
    if (comErro) partes.push(comErro + " com erro");
    item.mensagem = partes.join(" · ") || "Sem conteúdo";
    if (comErro && !novos && !repetidos) item.situacao = "erro";
    else if (comErro || !novos) item.situacao = "aviso";
    else item.situacao = "ok";
  }

  // ===========================================================================
  // 2) CÁLCULOS (contas sem repetição e situação de cada exportação)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // calcularContas: junta as contas de todos os links, sem repetir.
  // Duas contas são iguais se emissor, nome e secret forem iguais.
  // ---------------------------------------------------------------------------
  function calcularContas() {
    const mapa = new Map();
    for (const link of estado.links.values()) {
      const origem = link.tipo === "migracao" ? "QR " + (link.loteIndice + 1) + "/" + link.loteTamanho : "otpauth";
      for (const c of link.contas) {
        const chave = c.emissor + "|" + c.nome + "|" + c.secret;
        if (mapa.has(chave)) { mapa.get(chave).origens.add(origem); continue; }
        mapa.set(chave, Object.assign({}, c, { numero: mapa.size + 1, origens: new Set([origem]) }));
      }
    }
    return Array.from(mapa.values());
  }

  // ---------------------------------------------------------------------------
  // calcularLotes: agrupa os QR codes por exportação (loteId) e indica quais
  // posições já foram lidas — é assim que sabemos o que está faltando.
  // ---------------------------------------------------------------------------
  function calcularLotes() {
    const lotes = new Map();
    for (const link of estado.links.values()) {
      if (link.tipo !== "migracao") continue;
      if (!lotes.has(link.loteId)) lotes.set(link.loteId, { id: link.loteId, tamanho: 0, lidos: new Map() });
      const lote = lotes.get(link.loteId);
      lote.tamanho = Math.max(lote.tamanho, link.loteTamanho);
      lote.lidos.set(link.loteIndice, link);
    }
    return Array.from(lotes.values());
  }

  // ===========================================================================
  // 3) DESENHO DA TELA
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // escapar: torna um texto seguro para inserir no HTML (evita que um nome de
  // conta com "<script>" seja interpretado como código).
  // ---------------------------------------------------------------------------
  function escapar(texto) {
    const trocas = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(texto === undefined || texto === null ? "" : texto).replace(/[&<>"']/g, function (c) { return trocas[c]; }); // Troca cada um.
  }

  // ---------------------------------------------------------------------------
  // desenharArquivos: atualiza a lista de miniaturas dos arquivos enviados.
  // ---------------------------------------------------------------------------
  function desenharArquivos() {
    const icones = { ok: "✓ ", erro: "✗ ", aviso: "! ", carregando: "" };
    $("arquivos").innerHTML = estado.arquivos.map(function (a) {
      const miniatura = a.tipo === "imagem" ? '<img src="' + a.url + '" alt="">' : "TXT";
      return '<div class="cartao">' +
        '<div class="miniatura ' + (a.tipo === "texto" ? "texto" : "") + '">' + miniatura + "</div>" +
        '<div class="info"><div class="nome" title="' + escapar(a.nome) + '">' + escapar(a.nome) + "</div>" +
        '<div class="sit-' + a.situacao + '">' + icones[a.situacao] + escapar(a.mensagem) + "</div></div>" +
        "</div>";
    }).join("");
  }

  // ---------------------------------------------------------------------------
  // desenharTudo: recalcula contas e lotes e redesenha verificação e tabela.
  // ---------------------------------------------------------------------------
  function desenharTudo() {
    desenharArquivos();
    contas = calcularContas();
    const lotes = calcularLotes();

    $("nArquivos").textContent = estado.arquivos.length;
    $("nQR").textContent = estado.links.size;
    $("nContas").textContent = contas.length;
    $("nErros").textContent = estado.erros.length;

    let faltando = 0;
    $("lotes").innerHTML = lotes.map(function (lote) {
      const chips = [];
      for (let i = 0; i < lote.tamanho; i++) {
        const lido = lote.lidos.get(i);
        if (lido) chips.push('<span class="chip lido" title="' + escapar(Array.from(lido.origens).join(", ")) + '">✓ QR ' + (i + 1) + "</span>");
        else { faltando++; chips.push('<span class="chip falta">✗ QR ' + (i + 1) + "</span>"); }
      }
      const titulo = lotes.length > 1 ? "Exportação " + lote.id : "Exportação";
      return '<div class="lote"><div class="lote-titulo"><b>' + titulo + "</b>: " + lote.lidos.size + " de " + lote.tamanho + " QR codes lidos</div>" +
        '<div class="chips">' + chips.join("") + "</div></div>";
    }).join("") + (lotes.length > 1
      ? '<p class="meta">Foram encontradas exportações diferentes. Cada vez que você exporta no app é gerado um novo conjunto de QR codes; complete cada uma ou use apenas uma.</p>'
      : "");

    $("erros").innerHTML = estado.erros.map(function (e) {
      return "<li><b>" + escapar(e.origem) + ":</b> " + escapar(e.mensagem) + "</li>";
    }).join("");

    const faixa = $("faixa");
    if (!estado.links.size && !estado.erros.length) {
      faixa.className = "faixa neutra"; faixa.textContent = "Nenhum QR code lido ainda.";
    } else if (processando) {
      faixa.className = "faixa neutra"; faixa.textContent = "Processando… (" + (fila.length + 1) + " restante(s))";
    } else if (faltando) {
      faixa.className = "faixa aviso";
      faixa.textContent = "Incompleto: falta(m) " + faltando + " QR code(s). Adicione os QR codes marcados em vermelho para obter todas as contas.";
    } else if (estado.erros.length) {
      faixa.className = "faixa erro";
      faixa.textContent = contas.length + " conta(s) lida(s), mas houve " + estado.erros.length + " problema(s). Veja a lista abaixo e reenvie as imagens com erro.";
    } else {
      faixa.className = "faixa ok";
      faixa.textContent = "✓ Completo: todos os QR codes foram lidos — " + contas.length + " conta(s) encontrada(s).";
    }

    const temContas = contas.length > 0;
    ["btnCSV", "btnJSON", "btnURI", "btnBackup"].forEach(function (id) { $(id).disabled = !temContas; });
    $("btnLimpar").disabled = !estado.arquivos.length;
    desenharTabela();
  }

  // ---------------------------------------------------------------------------
  // contasVisiveis: aplica o filtro de busca e a ordenação escolhida.
  // ---------------------------------------------------------------------------
  function contasVisiveis() {
    const busca = $("busca").value.trim().toLowerCase();
    let lista = contas.filter(function (c) {
      return !busca || c.emissor.toLowerCase().includes(busca) || c.nome.toLowerCase().includes(busca);
    });
    const comparar = function (a, b) { return a.localeCompare(b, "pt-BR", { sensitivity: "base" }); };
    const modo = $("ordem").value;
    if (modo === "emissor") lista = lista.slice().sort(function (a, b) { return comparar(a.emissor, b.emissor) || comparar(a.nome, b.nome); });
    if (modo === "nome") lista = lista.slice().sort(function (a, b) { return comparar(a.nome, b.nome); });
    return lista;
  }

  // ---------------------------------------------------------------------------
  // desenharTabela: monta as linhas da tabela de contas.
  // ---------------------------------------------------------------------------
  function desenharTabela() {
    const lista = contasVisiveis();
    $("totalContas").textContent = contas.length
      ? "(" + lista.length + (lista.length !== contas.length ? " de " + contas.length : "") + ")"
      : "";
    $("btnMostrar").textContent = estado.mostrarTodos ? "🙈 Ocultar secrets" : "👁 Mostrar secrets";
    if (!lista.length) {
      $("corpoTabela").innerHTML = '<tr><td colspan="8" class="vazio">' +
        (contas.length ? "Nenhuma conta corresponde ao filtro." : "As contas aparecem aqui depois de ler os QR codes.") +
        "</td></tr>";
      return;
    }
    $("corpoTabela").innerHTML = lista.map(function (c) {
      const visivel = estado.mostrarTodos || estado.revelados.has(c.numero);
      const detalhes = c.tipo.toUpperCase() + " · " + c.algoritmo + " · " + c.digitos + " díg." +
        (c.tipo === "totp" ? " · " + c.periodo + "s" : " · contador " + c.contador);
      return '<tr data-numero="' + c.numero + '">' +
        '<td class="num">' + c.numero + "</td>" +
        '<td class="emissor">' + (escapar(c.emissor) || '<span class="meta">—</span>') + "</td>" +
        '<td class="conta">' + escapar(c.nome) + "</td>" +
        '<td><span class="codigo" data-acao="copiar-codigo" title="Clique para copiar">······</span>' +
        (c.tipo === "totp" ? '<div class="tempo"><i></i></div>' : "") + "</td>" +
        '<td><span class="secret">' + (visivel ? escapar(c.secret) : "••••••••••••") + "</span></td>" +
        '<td class="meta">' + detalhes + "</td>" +
        '<td class="meta">' + escapar(Array.from(c.origens).join(", ")) + "</td>" +
        '<td class="acoes">' +
        '<button class="pequeno" data-acao="alternar" title="' + (visivel ? "Ocultar" : "Mostrar") + ' secret">' + (visivel ? "🙈" : "👁") + "</button> " +
        '<button class="pequeno" data-acao="copiar-secret" title="Copiar secret">📋 Secret</button> ' +
        '<button class="pequeno" data-acao="qr" title="QR code para importar em outro app">▦ QR</button>' +
        "</td></tr>";
    }).join("");
    ultimoContador.clear();
    atualizarCodigos();
  }

  // ===========================================================================
  // 4) AÇÕES DA TABELA E DA BARRA DE FERRAMENTAS
  // ===========================================================================

  $("corpoTabela").addEventListener("click", function (e) {
    const alvo = e.target.closest("[data-acao]");
    if (!alvo) return;
    const numero = Number(alvo.closest("tr").dataset.numero);
    const conta = contas.find(function (c) { return c.numero === numero; });
    if (!conta) return;
    const acao = alvo.dataset.acao;
    if (acao === "alternar") {
      if (estado.revelados.has(numero)) estado.revelados.delete(numero); else estado.revelados.add(numero);
      desenharTabela();
    } else if (acao === "copiar-secret") {
      copiar(conta.secret, "Secret copiado");
    } else if (acao === "copiar-codigo") {
      if (/^\d+$/.test(alvo.textContent)) copiar(alvo.textContent, "Código copiado");
    } else if (acao === "qr") {
      abrirQR(conta);
    }
  });

  $("busca").addEventListener("input", desenharTabela);
  $("ordem").addEventListener("change", desenharTabela);
  $("btnMostrar").addEventListener("click", function () {
    estado.mostrarTodos = !estado.mostrarTodos;
    estado.revelados.clear();
    desenharTabela();
  });

  // ===========================================================================
  // 5) CÓDIGOS ATUAIS (recalculados a cada segundo)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // atualizarCodigos: atualiza o código e a barra de tempo de cada linha.
  // ---------------------------------------------------------------------------
  function atualizarCodigos() {
    const agora = Date.now() / 1000;
    document.querySelectorAll("#corpoTabela tr[data-numero]").forEach(function (linha) {
      const conta = contas.find(function (c) { return c.numero === Number(linha.dataset.numero); });
      if (!conta) return;
      const elCodigo = linha.querySelector(".codigo");
      const contador = Totp.contadorAtual(conta, agora);
      if (ultimoContador.get(conta.numero) !== contador) {
        ultimoContador.set(conta.numero, contador);
        Totp.gerarCodigo(conta, contador).then(function (codigo) {
          elCodigo.textContent = codigo || "n/d";
          if (!codigo) elCodigo.title = "Algoritmo não suportado pelo navegador";
        }).catch(function () {
          elCodigo.textContent = "erro";
          elCodigo.title = "Secret inválido";
        });
      }
      if (conta.tipo === "totp") {
        const restante = conta.periodo - (agora % conta.periodo);
        const barra = linha.querySelector(".tempo");
        barra.classList.toggle("acabando", restante < 6);
        barra.firstElementChild.style.width = (restante / conta.periodo) * 100 + "%";
        barra.title = Math.ceil(restante) + "s restantes";
      }
    });
  }
  setInterval(atualizarCodigos, 1000);

  // ===========================================================================
  // 6) JANELA DO QR CODE DE IMPORTAÇÃO
  // ===========================================================================

  let contaNaJanela = null;

  // ---------------------------------------------------------------------------
  // abrirQR: mostra a janela com o QR code e o link otpauth:// da conta.
  // ---------------------------------------------------------------------------
  function abrirQR(conta) {
    contaNaJanela = conta;
    $("jTitulo").textContent = conta.emissor || conta.nome;
    $("jSubtitulo").textContent = conta.emissor ? conta.nome : "";
    $("jLink").textContent = conta.uri;
    try {
      $("jImagem").src = LeitorQR.gerarQRImagem(conta.uri);
    } catch (e) {
      avisar("Erro ao gerar QR: " + e.message);
    }
    $("janela").classList.add("aberta");
  }

  // ---------------------------------------------------------------------------
  // fecharQR: esconde a janela e apaga a imagem do QR.
  // ---------------------------------------------------------------------------
  function fecharQR() {
    $("janela").classList.remove("aberta");
    $("jImagem").removeAttribute("src");
    contaNaJanela = null;
  }

  $("jFechar").addEventListener("click", fecharQR);
  $("janela").addEventListener("click", function (e) { if (e.target === $("janela")) fecharQR(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") fecharQR(); });
  $("jCopiar").addEventListener("click", function () { if (contaNaJanela) copiar(contaNaJanela.uri, "Link copiado"); });

  // ===========================================================================
  // 7) EXPORTAÇÃO DE ARQUIVOS
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // dataHora: texto com data e hora para nomes de arquivo (ex.: 2026-11-03-14-05-00).
  // ---------------------------------------------------------------------------
  function dataHora() {
    const d = new Date();
    const dois = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + dois(d.getMonth() + 1) + "-" + dois(d.getDate()) + "-" + dois(d.getHours()) + "-" + dois(d.getMinutes()) + "-" + dois(d.getSeconds());
  }

  // ---------------------------------------------------------------------------
  // horaCompacta: hora no formato HHMMSS (usada no nome de imagens coladas).
  // ---------------------------------------------------------------------------
  function horaCompacta() {
    return new Date().toLocaleTimeString("pt-BR").replace(/:/g, "");
  }

  // ---------------------------------------------------------------------------
  // baixar: faz o navegador baixar um arquivo com o conteúdo informado.
  // ---------------------------------------------------------------------------
  function baixar(nomeArquivo, conteudo, tipo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    const link = document.createElement("a");
    link.href = url;
    link.download = nomeArquivo;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function dadosConta(c) {
    return { servico: c.emissor, conta: c.nome, secret: c.secret, tipo: c.tipo, algoritmo: c.algoritmo, digitos: c.digitos, periodo: c.periodo, contador: c.contador, uri: c.uri };
  }

  $("btnCSV").addEventListener("click", function () {
    const celula = function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }; // Coloca o valor entre aspas (padrão CSV).
    const cabecalho = ["Servico", "Conta", "Secret", "Tipo", "Algoritmo", "Digitos", "Periodo", "Contador", "URI"].map(celula).join(";");
    const linhas = contas.map(function (c) { return Object.values(dadosConta(c)).map(celula).join(";"); });
    baixar("contas-2fa-" + dataHora() + ".csv", "﻿" + [cabecalho].concat(linhas).join("\r\n"), "text/csv;charset=utf-8");
  });
  $("btnJSON").addEventListener("click", function () {
    baixar("contas-2fa-" + dataHora() + ".json", JSON.stringify(contas.map(dadosConta), null, 2), "application/json");
  });
  $("btnURI").addEventListener("click", function () {
    baixar("contas-2fa-otpauth-" + dataHora() + ".txt", contas.map(function (c) { return c.uri; }).join("\r\n") + "\r\n", "text/plain");
  });
  $("btnBackup").addEventListener("click", function () {
    const links = Array.from(estado.links.values())
      .filter(function (l) { return l.tipo === "migracao"; })
      .sort(function (a, b) { return a.loteId - b.loteId || a.loteIndice - b.loteIndice; })
      .map(function (l) { return l.texto; });
    if (!links.length) { avisar("Nenhum link de migração lido"); return; }
    baixar("backup-migracao-" + dataHora() + ".txt", links.join("\r\n") + "\r\n", "text/plain");
  });
  $("btnLimpar").addEventListener("click", function () {
    if (!confirm("Apagar todas as imagens e contas lidas desta página?")) return;
    estado.arquivos.forEach(function (a) { if (a.url) URL.revokeObjectURL(a.url); });
    estado.arquivos = [];
    estado.links.clear();
    estado.erros = [];
    estado.revelados.clear();
    estado.mostrarTodos = false;
    Totp.limparCache();
    ultimoContador.clear();
    desenharTudo();
  });

  // ===========================================================================
  // 8) UTILIDADES
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // copiar: copia um texto para a área de transferência e avisa o usuário.
  // ---------------------------------------------------------------------------
  function copiar(texto, mensagem) {
    navigator.clipboard.writeText(texto)
      .then(function () { avisar(mensagem); })
      .catch(function () { avisar("Não foi possível copiar"); });
  }

  let temporizadorAviso;
  // ---------------------------------------------------------------------------
  // avisar: mostra uma mensagem curta na parte de baixo da tela por ~2 segundos.
  // ---------------------------------------------------------------------------
  function avisar(mensagem) {
    const el = $("aviso");
    el.textContent = mensagem;
    el.classList.add("visivel");
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(function () { el.classList.remove("visivel"); }, 1800);
  }

  window.addEventListener("beforeunload", function (e) {
    if (estado.links.size) { e.preventDefault(); e.returnValue = ""; }
  });

  desenharTudo();
})();
