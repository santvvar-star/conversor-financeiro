"use strict";
/* Conversor Financeiro OFX <-> Excel — lógica de conversão (roda 100% no navegador). */

const CABECALHO = ["Data", "Descrição", "Valor", "Tipo", "Categoria", "Conta", "ID Transação"];
const EPOCA_EXCEL_MS = Date.UTC(1899, 11, 30);

/* ---------------------------------------------------------------------- */
/* Utilidades de data (sempre y/m/d "ingênuo", sem fuso horário)           */
/* ---------------------------------------------------------------------- */

function compararData(a, b) {
  if (a.ano !== b.ano) return a.ano - b.ano;
  if (a.mes !== b.mes) return a.mes - b.mes;
  return a.dia - b.dia;
}

function dataParaSerialExcel(d) {
  return Math.round((Date.UTC(d.ano, d.mes - 1, d.dia) - EPOCA_EXCEL_MS) / 86400000);
}

function serialExcelParaData(serial) {
  const ms = Math.round(serial) * 86400000 + EPOCA_EXCEL_MS;
  const dt = new Date(ms);
  return { ano: dt.getUTCFullYear(), mes: dt.getUTCMonth() + 1, dia: dt.getUTCDate() };
}

function dataParaAAAAMMDD(d) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.ano}${p2(d.mes)}${p2(d.dia)}`;
}

function dataParaDDMMAAAA(d) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.dia)}/${p2(d.mes)}/${d.ano}`;
}

/* ---------------------------------------------------------------------- */
/* Leitura de OFX                                                          */
/* ---------------------------------------------------------------------- */

class ErroOfxInvalido extends Error {}

function decodificarArrayBuffer(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (e) {
    try {
      return new TextDecoder("windows-1252").decode(buffer);
    } catch (e2) {
      return new TextDecoder("iso-8859-1").decode(buffer);
    }
  }
}

function extrairCorpoSgml(texto) {
  const indice = texto.indexOf("<OFX>");
  if (indice === -1) {
    throw new ErroOfxInvalido("Tag <OFX> não encontrada no arquivo. O arquivo pode estar corrompido.");
  }
  return texto.slice(indice);
}

function escaparCaracteresInvalidos(corpo) {
  corpo = corpo.replace(/&(?!(amp|lt|gt|apos|quot);)/g, "&amp;");
  corpo = corpo.replace(/<(?!\/?[A-Za-z0-9._]+>)/g, "&lt;");
  return corpo;
}

function sgmlParaXml(corpo) {
  corpo = corpo.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  corpo = escaparCaracteresInvalidos(corpo);
  corpo = corpo.replace(/<([A-Za-z0-9._]+)>([^<\n]+)\n/g, (_m, tag, valor) => {
    return `<${tag}>${valor.trim()}</${tag}>\n`;
  });
  return corpo;
}

function limparValorMonetario(texto) {
  texto = texto.trim().replace(",", ".");
  const valor = parseFloat(texto);
  if (Number.isNaN(valor)) {
    throw new ErroOfxInvalido(`Valor monetário inválido no OFX: '${texto}'`);
  }
  return valor;
}

function formatarDataOfx(texto) {
  const m = texto.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) {
    throw new ErroOfxInvalido(`Data inválida no OFX: '${texto}'`);
  }
  return { ano: parseInt(m[1], 10), mes: parseInt(m[2], 10), dia: parseInt(m[3], 10) };
}

function textoFilho(elemento, tag) {
  const el = elemento.getElementsByTagName(tag)[0];
  return el && el.textContent ? el.textContent.trim() : "";
}

function ofxParaTransacoes(texto) {
  const corpo = extrairCorpoSgml(texto);
  const xmlTexto = sgmlParaXml(corpo);

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlTexto, "application/xml");
  const erro = doc.getElementsByTagName("parsererror")[0];
  if (erro) {
    throw new ErroOfxInvalido("Falha ao interpretar a estrutura do OFX: " + erro.textContent.split("\n")[0]);
  }

  const transacoes = [];
  const blocos = [
    ...doc.getElementsByTagName("STMTRS"),
    ...doc.getElementsByTagName("CCSTMTRS"),
  ];

  for (const bloco of blocos) {
    let conta = "N/A";
    const bankacct = bloco.getElementsByTagName("BANKACCTFROM")[0];
    const ccacct = bloco.getElementsByTagName("CCACCTFROM")[0];
    if (bankacct) conta = textoFilho(bankacct, "ACCTID") || "N/A";
    else if (ccacct) conta = textoFilho(ccacct, "ACCTID") || "N/A";

    const stmttrns = bloco.getElementsByTagName("STMTTRN");
    for (const stmttrn of stmttrns) {
      const dtpostedTexto = textoFilho(stmttrn, "DTPOSTED");
      const trnamtTexto = textoFilho(stmttrn, "TRNAMT");
      if (!dtpostedTexto || !trnamtTexto) continue;

      const data = formatarDataOfx(dtpostedTexto);
      const valor = limparValorMonetario(trnamtTexto);

      let descricao = textoFilho(stmttrn, "MEMO");
      if (!descricao) descricao = textoFilho(stmttrn, "NAME");

      const tipoTexto = textoFilho(stmttrn, "TRNTYPE").toUpperCase();
      let tipo;
      if (["CREDIT", "DEP", "DIRECTDEP", "INT", "DIV"].includes(tipoTexto)) tipo = "Crédito";
      else if (["DEBIT", "PAYMENT", "FEE", "SRVCHG", "ATM", "POS", "CHECK", "XFER"].includes(tipoTexto)) tipo = "Débito";
      else tipo = valor >= 0 ? "Crédito" : "Débito";

      const idTransacao = textoFilho(stmttrn, "FITID");

      transacoes.push({ data, descricao, valor, tipo, categoria: "", conta, id_transacao: idTransacao });
    }
  }

  if (transacoes.length === 0) {
    throw new ErroOfxInvalido("Nenhuma transação (STMTTRN) foi encontrada no arquivo. Verifique se é um extrato OFX válido.");
  }

  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Escrita de XLSX (gera os bytes de um .xlsx válido, sem libs de planilha) */
/* ---------------------------------------------------------------------- */

function escaparXml(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colunaLetra(indice) {
  // 1 -> A, 2 -> B, ...
  let n = indice, s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function celulaTexto(ref, texto, estilo) {
  const s = estilo ? ` s="${estilo}"` : "";
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escaparXml(texto)}</t></is></c>`;
}

function celulaNumero(ref, valor, estilo) {
  const s = estilo ? ` s="${estilo}"` : "";
  return `<c r="${ref}"${s}><v>${valor}</v></c>`;
}

// Célula existente mas sem conteúdo. Usada nas colunas que o layout do Questor
// exige em branco — declarar a célula (em vez de omitir) deixa a estrutura de
// colunas explícita para quem for importar a planilha.
function celulaVazia(ref) {
  return `<c r="${ref}"/>`;
}

function construirSheetXml(transacoesOrdenadas) {
  const linhas = [];

  const cabecalhoCelulas = CABECALHO.map((titulo, i) => celulaTexto(`${colunaLetra(i + 1)}1`, titulo, 1)).join("");
  linhas.push(`<row r="1">${cabecalhoCelulas}</row>`);

  transacoesOrdenadas.forEach((t, i) => {
    const linha = i + 2;
    const celulas = [
      celulaNumero(`A${linha}`, dataParaSerialExcel(t.data), 2),
      celulaTexto(`B${linha}`, t.descricao || "", 0),
      celulaNumero(`C${linha}`, t.valor, 3),
      celulaTexto(`D${linha}`, t.tipo || "", 0),
      celulaTexto(`E${linha}`, t.categoria || "", 0),
      celulaTexto(`F${linha}`, t.conta || "", 0),
      celulaTexto(`G${linha}`, t.id_transacao || "", 0),
    ].join("");
    linhas.push(`<row r="${linha}">${celulas}</row>`);
  });

  const ultimaLinha = transacoesOrdenadas.length + 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:G${ultimaLinha}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>
<col min="1" max="1" width="12" customWidth="1"/>
<col min="2" max="2" width="40" customWidth="1"/>
<col min="3" max="3" width="15" customWidth="1"/>
<col min="4" max="4" width="10" customWidth="1"/>
<col min="5" max="5" width="18" customWidth="1"/>
<col min="6" max="6" width="16" customWidth="1"/>
<col min="7" max="7" width="22" customWidth="1"/>
</cols>
<sheetData>${linhas.join("")}</sheetData>
</worksheet>`;
}

function construirStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="165" formatCode="&quot;R$&quot; #,##0.00;-&quot;R$&quot; #,##0.00"/>
<numFmt numFmtId="166" formatCode="#,##0.00;-#,##0.00"/>
</numFmts>
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="2">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
</fills>
<borders count="1">
<border><left/><right/><top/><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
</cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1">
<cellStyle name="Normal" xfId="0" builtinId="0"/>
</cellStyles>
</styleSheet>`;
}

function construirWorkbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Transações" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function construirWorkbookRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function construirRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function construirContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

// Monta o arquivo .xlsx (container OOXML) em volta de uma única aba. Só o XML
// da aba muda entre o layout padrão e o do Questor — o resto do pacote
// (estilos, relações, content types) é idêntico.
function montarXlsx(sheetXml) {
  const arquivos = {
    "[Content_Types].xml": fflate.strToU8(construirContentTypes()),
    "_rels/.rels": fflate.strToU8(construirRootRels()),
    "xl/workbook.xml": fflate.strToU8(construirWorkbookXml()),
    "xl/_rels/workbook.xml.rels": fflate.strToU8(construirWorkbookRels()),
    "xl/styles.xml": fflate.strToU8(construirStylesXml()),
    "xl/worksheets/sheet1.xml": fflate.strToU8(sheetXml),
  };

  return fflate.zipSync(arquivos, { level: 6 });
}

function ordenarPorData(transacoes) {
  if (!transacoes || transacoes.length === 0) {
    throw new Error("Não há transações para gravar na planilha.");
  }
  return [...transacoes].sort((a, b) => compararData(a.data, b.data));
}

function transacoesParaXlsxBytes(transacoes) {
  return montarXlsx(construirSheetXml(ordenarPorData(transacoes)));
}

/* ---------------------------------------------------------------------- */
/* Layout do Questor                                                       */
/*                                                                         */
/* O Questor só importa a planilha nesta estrutura fixa de 8 colunas:      */
/*   A Data        -> data da transação                                    */
/*   B Débito      -> sempre em branco                                     */
/*   C Crédito     -> sempre em branco                                     */
/*   D Histórico   -> descrição da transação                               */
/*   E Complemento -> sempre 0                                             */
/*   F Valor       -> valor da transação (negativo = saída/débito, já que   */
/*                    as colunas Débito/Crédito ficam em branco e o sinal   */
/*                    é o que distingue a direção)                         */
/*   G Empresa     -> sempre em branco                                     */
/*   H Filial      -> sempre 1                                             */
/* ---------------------------------------------------------------------- */

const CABECALHO_QUESTOR = [
  "Data", "Débito", "Crédito", "Histórico", "Complemento", "Valor", "Empresa", "Filial",
];
const QUESTOR_COMPLEMENTO = 0;
const QUESTOR_FILIAL = 1;

function construirSheetXmlQuestor(transacoesOrdenadas) {
  const linhas = [];

  const cabecalhoCelulas = CABECALHO_QUESTOR
    .map((titulo, i) => celulaTexto(`${colunaLetra(i + 1)}1`, titulo, 1))
    .join("");
  linhas.push(`<row r="1">${cabecalhoCelulas}</row>`);

  transacoesOrdenadas.forEach((t, i) => {
    const linha = i + 2;
    const celulas = [
      celulaNumero(`A${linha}`, dataParaSerialExcel(t.data), 2),
      celulaVazia(`B${linha}`),
      celulaVazia(`C${linha}`),
      celulaTexto(`D${linha}`, t.descricao || "", 0),
      celulaNumero(`E${linha}`, QUESTOR_COMPLEMENTO, 0),
      celulaNumero(`F${linha}`, t.valor, 4),
      celulaVazia(`G${linha}`),
      celulaNumero(`H${linha}`, QUESTOR_FILIAL, 0),
    ].join("");
    linhas.push(`<row r="${linha}">${celulas}</row>`);
  });

  const ultimaLinha = transacoesOrdenadas.length + 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:H${ultimaLinha}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>
<col min="1" max="1" width="12" customWidth="1"/>
<col min="2" max="2" width="12" customWidth="1"/>
<col min="3" max="3" width="12" customWidth="1"/>
<col min="4" max="4" width="46" customWidth="1"/>
<col min="5" max="5" width="14" customWidth="1"/>
<col min="6" max="6" width="15" customWidth="1"/>
<col min="7" max="7" width="14" customWidth="1"/>
<col min="8" max="8" width="9" customWidth="1"/>
</cols>
<sheetData>${linhas.join("")}</sheetData>
</worksheet>`;
}

function transacoesParaQuestorXlsxBytes(transacoes) {
  return montarXlsx(construirSheetXmlQuestor(ordenarPorData(transacoes)));
}

/* ---------------------------------------------------------------------- */
/* Leitura de XLSX (sem libs de planilha, só fflate para o container zip)  */
/* ---------------------------------------------------------------------- */

class ErroExcelInvalido extends Error {}

function colunaLetraParaIndice(letras) {
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1-based
}

function lerSharedStrings(arquivos) {
  const bytes = arquivos["xl/sharedStrings.xml"];
  if (!bytes) return [];
  const xmlTexto = fflate.strFromU8(bytes);
  const doc = new DOMParser().parseFromString(xmlTexto, "application/xml");
  const itens = doc.getElementsByTagName("si");
  const lista = [];
  for (const item of itens) {
    const textos = item.getElementsByTagName("t");
    let s = "";
    for (const t of textos) s += t.textContent;
    lista.push(s);
  }
  return lista;
}

function resolverPrimeiraPlanilha(arquivos) {
  const workbookXml = fflate.strFromU8(arquivos["xl/workbook.xml"]);
  const doc = new DOMParser().parseFromString(workbookXml, "application/xml");
  const sheet = doc.getElementsByTagName("sheet")[0];
  if (!sheet) throw new ErroExcelInvalido("A planilha não contém nenhuma aba.");

  const rId = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");

  const relsXml = fflate.strFromU8(arquivos["xl/_rels/workbook.xml.rels"]);
  const relsDoc = new DOMParser().parseFromString(relsXml, "application/xml");
  const relacoes = relsDoc.getElementsByTagName("Relationship");
  let alvo = null;
  for (const rel of relacoes) {
    if (rel.getAttribute("Id") === rId) {
      alvo = rel.getAttribute("Target");
      break;
    }
  }
  if (!alvo) throw new ErroExcelInvalido("Não foi possível localizar a primeira aba da planilha.");

  const caminho = alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo}`;
  if (!arquivos[caminho]) throw new ErroExcelInvalido(`Aba da planilha não encontrada: '${caminho}'.`);
  return caminho;
}

function valorCelulaBruto(celula, sharedStrings) {
  if (!celula) return { tipo: "vazio", valor: null };
  const tipo = celula.getAttribute("t");

  if (tipo === "inlineStr") {
    const is = celula.getElementsByTagName("is")[0];
    let texto = "";
    if (is) {
      const textos = is.getElementsByTagName("t");
      for (const t of textos) texto += t.textContent;
    }
    return { tipo: "texto", valor: texto };
  }

  const vEl = celula.getElementsByTagName("v")[0];
  const vTexto = vEl ? vEl.textContent : "";

  if (tipo === "s") {
    const indice = parseInt(vTexto, 10);
    return { tipo: "texto", valor: sharedStrings[indice] ?? "" };
  }
  if (tipo === "str" || tipo === "b") {
    return { tipo: "texto", valor: vTexto };
  }
  if (vTexto === "") return { tipo: "vazio", valor: null };
  return { tipo: "numero", valor: parseFloat(vTexto) };
}

function converterDataCelula(bruto, numeroLinha) {
  if (bruto.tipo === "numero") {
    return serialExcelParaData(bruto.valor);
  }
  if (bruto.tipo === "texto") {
    let m = bruto.valor.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return { dia: parseInt(m[1], 10), mes: parseInt(m[2], 10), ano: parseInt(m[3], 10) };
    m = bruto.valor.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return { ano: parseInt(m[1], 10), mes: parseInt(m[2], 10), dia: parseInt(m[3], 10) };
  }
  throw new ErroExcelInvalido(`Data inválida na linha ${numeroLinha}. Use o formato dd/mm/aaaa.`);
}

function converterValorCelula(bruto, numeroLinha) {
  if (bruto.tipo === "numero") return bruto.valor;
  if (bruto.tipo === "texto") {
    let texto = bruto.valor.trim().replace(/R\$/g, "").replace(/\s/g, "");
    if (texto.includes(",")) texto = texto.replace(/\./g, "").replace(",", ".");
    const valor = parseFloat(texto);
    if (!Number.isNaN(valor)) return valor;
  }
  throw new ErroExcelInvalido(`Valor inválido na linha ${numeroLinha}.`);
}

function textoCelula(bruto) {
  if (bruto.tipo === "vazio") return "";
  return String(bruto.valor);
}

function xlsxParaTransacoes(arrayBuffer) {
  let arquivos;
  try {
    arquivos = fflate.unzipSync(new Uint8Array(arrayBuffer));
  } catch (e) {
    throw new ErroExcelInvalido("Não foi possível abrir o arquivo .xlsx: " + e.message);
  }

  if (!arquivos["xl/workbook.xml"]) {
    throw new ErroExcelInvalido("Este arquivo não parece ser uma planilha .xlsx válida.");
  }

  const sharedStrings = lerSharedStrings(arquivos);
  const caminhoAba = resolverPrimeiraPlanilha(arquivos);
  const sheetXml = fflate.strFromU8(arquivos[caminhoAba]);
  const doc = new DOMParser().parseFromString(sheetXml, "application/xml");

  const linhasXml = doc.getElementsByTagName("row");
  if (linhasXml.length === 0) {
    throw new ErroExcelInvalido("A planilha está vazia.");
  }

  const lerLinha = (rowEl) => {
    const celulasPorColuna = new Array(CABECALHO.length).fill(null);
    const celulas = rowEl.getElementsByTagName("c");
    for (const c of celulas) {
      const ref = c.getAttribute("r") || "";
      const m = ref.match(/^([A-Z]+)(\d+)$/);
      if (!m) continue;
      const indice = colunaLetraParaIndice(m[1]) - 1;
      if (indice >= 0 && indice < CABECALHO.length) {
        celulasPorColuna[indice] = valorCelulaBruto(c, sharedStrings);
      }
    }
    return celulasPorColuna;
  };

  const primeiraLinha = lerLinha(linhasXml[0]);
  const cabecalhoLido = primeiraLinha.map((b) => (b ? textoCelula(b).trim() : ""));
  const cabecalhoEsperado = CABECALHO;
  const bate = cabecalhoEsperado.every((titulo, i) => cabecalhoLido[i] === titulo);
  if (!bate) {
    throw new ErroExcelInvalido(
      "O cabeçalho da planilha não corresponde ao formato esperado.\n" +
      `Esperado: ${cabecalhoEsperado.join(" | ")}\n` +
      `Encontrado: ${cabecalhoLido.join(" | ")}`
    );
  }

  const transacoes = [];
  for (let i = 1; i < linhasXml.length; i++) {
    const numeroLinha = i + 1;
    const colunas = lerLinha(linhasXml[i]);
    const [dataCel, descCel, valorCel, tipoCel, catCel, contaCel, idCel] = colunas;

    const vazio = colunas.every((c) => !c || c.tipo === "vazio");
    if (vazio) continue;

    if (!dataCel || dataCel.tipo === "vazio" || !valorCel || valorCel.tipo === "vazio") {
      throw new ErroExcelInvalido(`Linha ${numeroLinha}: colunas 'Data' e 'Valor' são obrigatórias.`);
    }

    transacoes.push({
      data: converterDataCelula(dataCel, numeroLinha),
      descricao: textoCelula(descCel),
      valor: converterValorCelula(valorCel, numeroLinha),
      tipo: textoCelula(tipoCel),
      categoria: textoCelula(catCel),
      conta: textoCelula(contaCel),
      id_transacao: textoCelula(idCel),
    });
  }

  if (transacoes.length === 0) {
    throw new ErroExcelInvalido("Nenhuma transação válida foi encontrada na planilha.");
  }

  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Escrita de OFX                                                          */
/* ---------------------------------------------------------------------- */

function sanitizarTextoOfx(texto) {
  if (!texto) return "";
  return String(texto).replace(/\r/g, " ").replace(/\n/g, " ").replace(/</g, "(").replace(/>/g, ")").trim();
}

function fnv1aHex(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function gerarFitid(transacao, indice) {
  if (transacao.id_transacao) return sanitizarTextoOfx(transacao.id_transacao);
  const base = `${dataParaAAAAMMDD(transacao.data)}${transacao.valor}${transacao.descricao || ""}${indice}`;
  return fnv1aHex(base) + fnv1aHex(base + "x");
}

function determinarTrntype(transacao) {
  const tipo = (transacao.tipo || "").trim().toLowerCase();
  if (["crédito", "credito", "credit"].includes(tipo)) return "CREDIT";
  if (["débito", "debito", "debit"].includes(tipo)) return "DEBIT";
  return transacao.valor >= 0 ? "CREDIT" : "DEBIT";
}

function blocoStmttrn(transacao, indice) {
  const trntype = determinarTrntype(transacao);
  const dtposted = dataParaAAAAMMDD(transacao.data) + "000000";
  const valor = transacao.valor.toFixed(2);
  const fitid = gerarFitid(transacao, indice);
  const memo = sanitizarTextoOfx(transacao.descricao) || "SEM DESCRICAO";

  return (
    "<STMTTRN>\n" +
    `<TRNTYPE>${trntype}\n` +
    `<DTPOSTED>${dtposted}\n` +
    `<TRNAMT>${valor}\n` +
    `<FITID>${fitid}\n` +
    `<MEMO>${memo}\n` +
    "</STMTTRN>\n"
  );
}

function transacoesParaOfxTexto(transacoes) {
  if (!transacoes || transacoes.length === 0) {
    throw new Error("Não há transações para gravar no arquivo OFX.");
  }

  const porConta = new Map();
  for (const t of transacoes) {
    const conta = t.conta || "0000";
    if (!porConta.has(conta)) porConta.set(conta, []);
    porConta.get(conta).push(t);
  }

  const blocos = [];
  let trnuid = 1;
  for (const [conta, itens] of porConta) {
    const ordenados = [...itens].sort((a, b) => compararData(a.data, b.data));
    const dtstart = dataParaAAAAMMDD(ordenados[0].data) + "000000";
    const dtend = dataParaAAAAMMDD(ordenados[ordenados.length - 1].data) + "000000";
    const transacoesSgml = ordenados.map((t, i) => blocoStmttrn(t, i)).join("");

    blocos.push(
      "<STMTTRNRS>\n" +
      `<TRNUID>${trnuid}\n` +
      "<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n" +
      "<STMTRS>\n<CURDEF>BRL\n" +
      "<BANKACCTFROM>\n<BANKID>0000\n" +
      `<ACCTID>${sanitizarTextoOfx(conta)}\n` +
      "<ACCTTYPE>CHECKING\n</BANKACCTFROM>\n" +
      "<BANKTRANLIST>\n" +
      `<DTSTART>${dtstart}\n<DTEND>${dtend}\n` +
      transacoesSgml +
      "</BANKTRANLIST>\n" +
      "<LEDGERBAL>\n<BALAMT>0.00\n" +
      `<DTASOF>${dtend}\n</LEDGERBAL>\n` +
      "</STMTRS>\n</STMTTRNRS>\n"
    );
    trnuid += 1;
  }

  const agora = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const dtserver = `${agora.getFullYear()}${p2(agora.getMonth() + 1)}${p2(agora.getDate())}${p2(agora.getHours())}${p2(agora.getMinutes())}${p2(agora.getSeconds())}`;

  return (
    "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\n" +
    "ENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n" +
    "<OFX>\n<SIGNONMSGSRSV1>\n<SONRS>\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n" +
    `<DTSERVER>${dtserver}\n<LANGUAGE>POR\n</SONRS>\n</SIGNONMSGSRSV1>\n` +
    "<BANKMSGSRSV1>\n" +
    blocos.join("") +
    "</BANKMSGSRSV1>\n</OFX>\n"
  );
}
