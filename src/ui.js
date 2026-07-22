"use strict";

const elZona = document.getElementById("zona-arquivo");
const elInput = document.getElementById("input-arquivo");
const elStatus = document.getElementById("status");
const elResultado = document.getElementById("resultado");
const elBotaoNovo = document.getElementById("botao-novo");
const elBancoSelect = document.getElementById("banco-select");

for (const banco of BANCOS_SUPORTADOS) {
  const opcao = document.createElement("option");
  opcao.value = banco.id;
  opcao.textContent = banco.nome;
  elBancoSelect.appendChild(opcao);
}

function nomeBase(nomeArquivo) {
  const ponto = nomeArquivo.lastIndexOf(".");
  return ponto === -1 ? nomeArquivo : nomeArquivo.slice(0, ponto);
}

function extensao(nomeArquivo) {
  const ponto = nomeArquivo.lastIndexOf(".");
  return ponto === -1 ? "" : nomeArquivo.slice(ponto + 1).toLowerCase();
}

// Dentro de um Artifact do Claude (claude.ai), a página roda num ambiente
// restrito onde o download "clássico" (link com blob + click()) é bloqueado
// sem aviso — é preciso usar a API window.claude.downloads.save(), que só
// aceita algumas extensões (nenhuma delas .xlsx/.ofx). Por isso, dentro do
// Artifact, os arquivos gerados por este app não podem ser baixados — só dá
// para ver a pré-visualização. Fora do Artifact (arquivo local aberto no
// navegador), o download funciona normalmente.
async function baixarArquivo(bytesOuTexto, nomeArquivo, mimeType) {
  if (window.claude && window.claude.downloads) {
    try {
      await window.claude.downloads.save({ filename: nomeArquivo, data: bytesOuTexto });
      return { ok: true };
    } catch (erro) {
      const codigo = erro && erro.code;
      if (codigo === "declined") {
        return { ok: false, cancelado: true };
      }
      if (codigo === "rejected_extension") {
        return {
          ok: false,
          mensagem:
            `Não é possível baixar arquivos ".${extensao(nomeArquivo)}" a partir deste link (Artifact do ` +
            "Claude só permite baixar imagens, vídeos, texto simples, JSON ou Markdown). Copie o arquivo " +
            "ConversorFinanceiro.html para o seu computador e abra-o direto no navegador para converter e " +
            "baixar o resultado normalmente.",
        };
      }
      return {
        ok: false,
        mensagem: "Não foi possível baixar o arquivo (" + (codigo || (erro && erro.message) || "erro desconhecido") + ").",
      };
    }
  }

  const blob = new Blob([bytesOuTexto], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { ok: true };
}

function mostrarStatus(mensagem, tipo) {
  elStatus.textContent = mensagem;
  elStatus.className = "status " + (tipo || "");
  elStatus.style.display = mensagem ? "block" : "none";
}

function mostrarResultado(html) {
  elResultado.innerHTML = html;
  elResultado.style.display = html ? "block" : "none";
  elBotaoNovo.style.display = html ? "inline-flex" : "none";
}

function htmlPreview(transacoes) {
  const ordenadas = [...transacoes].sort((a, b) => compararData(a.data, b.data));
  const preview = ordenadas.slice(0, 8).map(linhaPreview).join("");
  return (
    `<div class="tabela-scroll"><table><thead><tr><th>Data</th><th>Descrição</th><th>Valor</th><th>Tipo</th></tr></thead>` +
    `<tbody>${preview}</tbody></table></div>` +
    (transacoes.length > 8 ? `<p class="obs">Mostrando 8 de ${transacoes.length} transações. O arquivo baixado contém todas.</p>` : "")
  );
}

function linhaPreview(t) {
  const valorFmt = t.valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const dataFmt = dataParaDDMMAAAA(t.data);
  return `<tr><td class="mono">${dataFmt}</td><td>${escaparHtml(t.descricao)}</td><td class="num mono">${valorFmt}</td><td>${escaparHtml(t.tipo)}</td></tr>`;
}

function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}

const AVISO_PDF =
  '<p class="obs aviso-pdf">⚠ Leitura de PDF é heurística (o PDF não tem estrutura de dados como o ' +
  "OFX). Confira a pré-visualização abaixo com atenção, principalmente as colunas Valor e Tipo, antes " +
  "de confiar no arquivo gerado.</p>";

async function finalizarConversao(transacoes, dados, nomeSaida, mimeType, prefixoSucesso, htmlExtra) {
  const resultado = await baixarArquivo(dados, nomeSaida, mimeType);
  if (resultado.ok) {
    mostrarStatus(`${prefixoSucesso} Baixando '${nomeSaida}'…`, "ok");
  } else if (resultado.cancelado) {
    mostrarStatus(`${prefixoSucesso} O download foi cancelado.`, "processando");
  } else {
    mostrarStatus(resultado.mensagem, "erro");
  }
  mostrarResultado((htmlExtra || "") + htmlPreview(transacoes));
}

async function processarArquivo(file) {
  mostrarResultado("");
  const ext = extensao(file.name);

  if (!["ofx", "xlsx", "pdf"].includes(ext)) {
    mostrarStatus(`Formato não reconhecido: '.${ext}'. Envie um arquivo .ofx, .xlsx ou .pdf.`, "erro");
    return;
  }

  mostrarStatus("Processando " + file.name + "…", "processando");

  try {
    const buffer = await file.arrayBuffer();

    if (ext === "ofx") {
      const texto = decodificarArrayBuffer(buffer);
      const transacoes = ofxParaTransacoes(texto);
      const bytesXlsx = transacoesParaXlsxBytes(transacoes);
      const nomeSaida = nomeBase(file.name) + ".xlsx";

      await finalizarConversao(
        transacoes, bytesXlsx, nomeSaida,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        `Conversão concluída: ${transacoes.length} transação(ões).`
      );
    } else if (ext === "xlsx") {
      const transacoes = xlsxParaTransacoes(buffer);
      const textoOfx = transacoesParaOfxTexto(transacoes);
      const nomeSaida = nomeBase(file.name) + ".ofx";

      await finalizarConversao(
        transacoes, textoOfx, nomeSaida, "application/x-ofx",
        `Conversão concluída: ${transacoes.length} transação(ões).`
      );
    } else {
      const transacoes = await pdfParaTransacoes(buffer, elBancoSelect.value);
      const bytesXlsx = transacoesParaXlsxBytes(transacoes);
      const nomeSaida = nomeBase(file.name) + ".xlsx";

      await finalizarConversao(
        transacoes, bytesXlsx, nomeSaida,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        `Conversão concluída (perfil: ${ultimoBancoDetectado}): ${transacoes.length} transação(ões) identificadas.`,
        AVISO_PDF
      );
    }
  } catch (e) {
    mostrarStatus("Erro: " + e.message, "erro");
  }
}

elZona.addEventListener("click", () => elInput.click());

elZona.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    elInput.click();
  }
});

elZona.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  elZona.classList.add("arrastando");
});

elZona.addEventListener("dragleave", () => {
  elZona.classList.remove("arrastando");
});

elZona.addEventListener("drop", (ev) => {
  ev.preventDefault();
  elZona.classList.remove("arrastando");
  const arquivos = ev.dataTransfer.files;
  if (arquivos.length > 0) processarArquivo(arquivos[0]);
});

elInput.addEventListener("change", () => {
  if (elInput.files.length > 0) processarArquivo(elInput.files[0]);
  elInput.value = "";
});

elBotaoNovo.addEventListener("click", () => {
  mostrarStatus("", "");
  mostrarResultado("");
});
