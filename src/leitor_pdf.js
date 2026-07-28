"use strict";
/* Leitura de extratos bancários em PDF.
 *
 * PDF não tem estrutura de dados, só texto posicionado na página. Este leitor:
 * 1) reconstrói linhas de texto agrupando itens por coordenada Y;
 * 2) escolhe um "perfil" de banco (detectado automaticamente pelo texto do PDF,
 *    ou escolhido manualmente na interface) que sabe como interpretar essas linhas;
 * 3) cada perfil aplica suas próprias regras de data/valor/exclusão.
 *
 * O perfil "Genérico" (usado quando nenhum banco específico é reconhecido, e
 * também usado por Itaú/Sicredi/Efí — que já funcionam bem com a heurística
 * padrão) assume o layout mais comum: Data | Descrição | Valor [| Saldo].
 * Banco Safra e Nubank têm formatos bem diferentes e têm parsers dedicados.
 *
 * Isso continua sendo heurística, não um parser garantido — layouts fora do
 * padrão (de bancos ainda não vistos) podem não ser reconhecidos.
 */

class ErroPdfInvalido extends Error {}

const REGEX_DATA_INICIO_LINHA = /^\s*(\d{2}\/\d{2}\/\d{2,4})\s+(.*)$/;
const REGEX_NUMERO_MONETARIO = /\d{1,3}(?:\.\d{3})*,\d{2}/g;
const REGEX_LINHA_PARADA = /lan[çc]amentos futuros/i;

const PALAVRAS_DEBITO = [
  "SAQUE", "PAGAMENTO", "COMPRA", "TARIFA", "DEBITO", "DÉBITO",
  "ENVIADO", "ENVIO", "BOLETO", "TAXA", "JUROS", "IOF", "SAIDA", "SAÍDA",
];
const PALAVRAS_CREDITO = [
  "DEPOSITO", "DEPÓSITO", "CREDITO", "CRÉDITO", "SALARIO", "SALÁRIO",
  "RECEBID", "RENDIMENTO", "ESTORNO", "ENTRADA", "RESGATE",
];

const BANCOS_SUPORTADOS = [
  { id: "auto", nome: "Detectar automaticamente" },
  { id: "generico", nome: "Genérico (outro banco)" },
  { id: "safra", nome: "Banco Safra" },
  { id: "itau", nome: "Itaú" },
  { id: "sicredi", nome: "Sicredi" },
  { id: "efi", nome: "Efí" },
  { id: "nubank", nome: "Nubank" },
  { id: "ouribank", nome: "OuriBank" },
  { id: "c6", nome: "C6 Bank" },
  { id: "pinbank", nome: "Pinbank (CSV)" },
];

let ultimoBancoDetectado = "";

/* ---------------------------------------------------------------------- */
/* Utilidades compartilhadas entre perfis                                  */
/* ---------------------------------------------------------------------- */

function normalizarAno(textoAno) {
  if (textoAno.length === 2) {
    const n = parseInt(textoAno, 10);
    return n <= 68 ? 2000 + n : 1900 + n;
  }
  return parseInt(textoAno, 10);
}

function parsearDataPdf(textoData) {
  const m = textoData.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  const dia = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { dia, mes, ano: normalizarAno(m[3]) };
}

function encontrarValoresMonetarios(texto) {
  const resultados = [];
  for (const m of texto.matchAll(REGEX_NUMERO_MONETARIO)) {
    const inicio = m.index;
    const fimNumero = m.index + m[0].length;
    const antes = texto.slice(Math.max(0, inicio - 6), inicio);
    const depois = texto.slice(fimNumero, fimNumero + 3);

    // Sinal negativo pode vir colado no número ("-150,00") ou antes do "R$"
    // ("-R$ 150,00", comum no C6 e outros bancos).
    const negativo = /-\s*(r\$)?\s*$/i.test(antes) || /\(\s*$/.test(antes);
    const sufixoMatch = depois.match(/^\s*([DC])\b/i);
    const sufixo = sufixoMatch ? sufixoMatch[1].toUpperCase() : "";

    let valor = parseFloat(m[0].replace(/\./g, "").replace(",", "."));
    if (Number.isNaN(valor)) continue;
    if (negativo) valor = -Math.abs(valor);

    resultados.push({ valor, sufixo, inicioTexto: inicio });
  }
  return resultados;
}

function inferirTipoPorPalavraChave(descricao, valor) {
  const upper = descricao.toUpperCase();
  if (PALAVRAS_CREDITO.some((p) => upper.includes(p))) return "Crédito";
  if (PALAVRAS_DEBITO.some((p) => upper.includes(p))) return "Débito";
  return valor >= 0 ? "Crédito" : "Débito";
}

// Linhas como "SALDO ANTERIOR", "SALDO TOTAL", "Saldo do dia", "SALDO TOTAL
// DISPONÍVEL DIA" são saldo acumulado, não uma transação — em todo banco visto
// até agora essas linhas começam com a palavra "Saldo".
function linhaEhResumoSaldo(texto) {
  return /^saldo\b/i.test(texto.trim());
}

function novaTransacao(data, descricao, valorComSinal, tipo) {
  return {
    data,
    descricao,
    valor: valorComSinal,
    tipo,
    categoria: "",
    conta: "",
    id_transacao: "",
  };
}

function agruparItensEmLinhas(itens) {
  const TOLERANCIA_Y = 2;
  const ordenadosPorY = [...itens].sort((a, b) => b.y - a.y);

  const grupos = [];
  for (const item of ordenadosPorY) {
    const grupo = grupos.find((g) => Math.abs(g.y - item.y) <= TOLERANCIA_Y);
    if (grupo) grupo.itens.push(item);
    else grupos.push({ y: item.y, itens: [item] });
  }

  return grupos.map((grupo) => {
    const ordenadosPorX = grupo.itens.slice().sort((a, b) => a.x - b.x);
    let texto = "";
    let anterior = null;
    for (const item of ordenadosPorX) {
      if (anterior) {
        const espacoEntre = item.x - (anterior.x + anterior.width);
        if (espacoEntre > anterior.height * 0.25) texto += " ";
      }
      texto += item.str;
      anterior = item;
    }
    return { texto, y: grupo.y };
  });
}

// Um texto "parece começo de transação" se bate com algum dos formatos de
// data/seção conhecidos — usado só para decidir o que NÃO é uma linha órfã de
// continuação, não para de fato interpretar a linha (isso cada perfil faz).
function pareceComecoDeTransacao(texto) {
  return (
    REGEX_DATA_INICIO_LINHA.test(texto) ||
    /^\s*\d{2}\/\d{2}\s+\S/.test(texto) ||
    REGEX_DATA_NUBANK.test(texto.trim()) ||
    /^total de (entradas|sa[íi]das)/i.test(texto.trim()) ||
    linhaEhResumoSaldo(texto) ||
    REGEX_LINHA_PARADA.test(texto)
  );
}

// Cabeçalhos de coluna ("Data", "Tipo", "Valor"...) se repetem no topo de
// cada página e, como não têm data nem valor monetário, seriam confundidos
// com uma linha de continuação. Como o pdf.js pode juntar duas colunas de
// cabeçalho na mesma linha reconstruída (ex.: "Data Data" ou "lançamento
// contábil Tipo Descrição Valor", quando "Data" aparece duas vezes lado a
// lado), a checagem é palavra a palavra: se TODA palavra da linha for um
// rótulo de cabeçalho conhecido, a linha inteira é descartada (nunca "cola"
// em nenhuma transação).
const PALAVRAS_CABECALHO_TABELA = new Set([
  "data", "efetiva", "lançamento", "lançamentos", "lancamento", "lancamentos",
  "contábil", "contabil", "tipo", "descrição", "descricao", "histórico",
  "historico", "documento", "protocolo", "complemento", "razão", "razao",
  "social", "cnpj/cpf", "valor", "crédito", "credito", "débito", "debito",
  "saldo", "(r$)", "r$", "nº", "no", "n°",
]);

function linhaEhCabecalhoDeTabela(texto) {
  const palavras = texto.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return false;
  return palavras.every((p) => PALAVRAS_CABECALHO_TABELA.has(p));
}

// Quando uma célula de descrição quebra em duas linhas visuais no PDF, o
// pdf.js devolve isso como duas linhas de texto separadas — às vezes a
// continuação vem DEPOIS da linha com data/valor, às vezes vem ANTES dela
// (quando a célula é centralizada verticalmente em relação à linha da
// tabela). Aqui, uma linha "órfã" (sem data no início e sem valor monetário)
// é anexada ao vizinho mais próximo verticalmente — desde que esse vizinho
// esteja visivelmente mais perto do que o espaçamento típico das linhas da
// página (o que distingue uma quebra de célula real de um cabeçalho/rodapé,
// que ficam sempre bem mais distantes).
function prepararLinhasParaPerfil(linhasComY) {
  const gaps = [];
  for (let i = 1; i < linhasComY.length; i++) {
    gaps.push(Math.abs(linhasComY[i - 1].y - linhasComY[i].y));
  }
  const gapsOrdenados = [...gaps].sort((a, b) => a - b);
  const gapMediano = gapsOrdenados.length ? gapsOrdenados[Math.floor(gapsOrdenados.length / 2)] : 14;
  const LIMIAR_CONTINUACAO = gapMediano * 0.65;

  const unidades = [];
  let prefixoPendente = "";

  for (let i = 0; i < linhasComY.length; i++) {
    const linha = linhasComY[i];
    const textoTrim = linha.texto.trim();
    if (!textoTrim) continue;

    if (linhaEhCabecalhoDeTabela(textoTrim)) continue; // nunca mescla cabeçalho de coluna

    const ehOrfa = !pareceComecoDeTransacao(textoTrim) && encontrarValoresMonetarios(textoTrim).length === 0;

    if (ehOrfa) {
      const gapAntes = i > 0 ? Math.abs(linhasComY[i - 1].y - linha.y) : Infinity;
      const gapDepois = i < linhasComY.length - 1 ? Math.abs(linha.y - linhasComY[i + 1].y) : Infinity;
      const maisPertoDoAnterior = gapAntes <= gapDepois;

      if (Math.min(gapAntes, gapDepois) <= LIMIAR_CONTINUACAO) {
        if (maisPertoDoAnterior && unidades.length > 0) {
          const anterior = unidades[unidades.length - 1];
          anterior.sufixo = (anterior.sufixo + " " + textoTrim).trim();
        } else {
          prefixoPendente = (prefixoPendente + " " + textoTrim).trim();
        }
        continue;
      }
      // Órfã sem vizinho próximo o suficiente — provavelmente cabeçalho,
      // rodapé ou outro texto solto da página. Descarta.
      continue;
    }

    unidades.push({ texto: linha.texto, prefixo: prefixoPendente, sufixo: "" });
    prefixoPendente = "";
  }

  return unidades;
}

function combinarDescricaoComExtras(descricao, unidade) {
  let resultado = descricao;
  if (unidade.prefixo) resultado = (unidade.prefixo + " " + resultado).trim();
  if (unidade.sufixo) resultado = (resultado + " " + unidade.sufixo).trim();
  return resultado;
}

/* ---------------------------------------------------------------------- */
/* Perfil Genérico — layout Data | Descrição | Valor [| Saldo]             */
/* Cobre também Itaú, Sicredi e Efí, que seguem esse padrão.               */
/* ---------------------------------------------------------------------- */

function interpretarLinhaGenerica(linhaTexto) {
  const m = linhaTexto.match(REGEX_DATA_INICIO_LINHA);
  if (!m) return null;

  const data = parsearDataPdf(m[1]);
  if (!data) return null;

  const resto = m[2];
  const valores = encontrarValoresMonetarios(resto);
  if (valores.length === 0) return null;

  // Se houver 2+ valores na linha, assume-se Valor seguido de Saldo acumulado
  // (layout mais comum) e usa-se o penúltimo como o valor da transação.
  const escolhido = valores.length >= 2 ? valores[valores.length - 2] : valores[0];

  const descricao = resto.slice(0, escolhido.inicioTexto).replace(/[-(+]\s*$/, "").trim();
  if (!descricao || linhaEhResumoSaldo(descricao)) return null;

  let tipo;
  if (escolhido.sufixo === "D") tipo = "Débito";
  else if (escolhido.sufixo === "C") tipo = "Crédito";
  else if (escolhido.valor < 0) tipo = "Débito";
  else tipo = inferirTipoPorPalavraChave(descricao, escolhido.valor);

  let valorFinal = Math.abs(escolhido.valor);
  if (tipo === "Débito") valorFinal = -valorFinal;

  return novaTransacao(data, descricao, valorFinal, tipo);
}

function parseLinhasGenerico(unidades) {
  const transacoes = [];
  for (const unidade of unidades) {
    if (REGEX_LINHA_PARADA.test(unidade.texto)) break; // ex.: "Lançamentos Futuros" do Sicredi
    const transacao = interpretarLinhaGenerica(unidade.texto);
    if (transacao) {
      transacao.descricao = combinarDescricaoComExtras(transacao.descricao, unidade);
      transacoes.push(transacao);
    }
  }
  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Perfil Banco Safra — datas sem ano (dd/mm) e sem sinal no valor         */
/* ---------------------------------------------------------------------- */

function extrairAnoPeriodoSafra(textoCompleto) {
  const m = textoCompleto.match(
    /per[íi]odo\s+de\s+(\d{2})\/(\d{2})\/(\d{4})\s+a\s+(\d{2})\/(\d{2})\/(\d{4})/i
  );
  if (!m) return null;
  return {
    mesInicio: parseInt(m[2], 10),
    anoInicio: parseInt(m[3], 10),
    mesFim: parseInt(m[5], 10),
    anoFim: parseInt(m[6], 10),
  };
}

function escolherAnoParaMes(mes, periodo) {
  if (!periodo) return new Date().getFullYear();
  if (periodo.anoInicio === periodo.anoFim) return periodo.anoInicio;
  // Período atravessa virada de ano (ex.: dez/2025 a jan/2026)
  return mes >= periodo.mesInicio ? periodo.anoInicio : periodo.anoFim;
}

function parseLinhasSafra(unidades, textoCompleto) {
  const periodo = extrairAnoPeriodoSafra(textoCompleto);
  const transacoes = [];

  for (const unidade of unidades) {
    const m = unidade.texto.match(/^\s*(\d{2})\/(\d{2})\s+(.*)$/);
    if (!m) continue;

    const dia = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) continue;

    const resto = m[3];
    const valores = encontrarValoresMonetarios(resto);
    if (valores.length === 0) continue;

    const escolhido = valores.length >= 2 ? valores[valores.length - 2] : valores[0];
    const descricao = resto.slice(0, escolhido.inicioTexto).replace(/[-(+]\s*$/, "").trim();
    if (!descricao || linhaEhResumoSaldo(descricao)) continue;

    let tipo;
    if (escolhido.sufixo === "D") tipo = "Débito";
    else if (escolhido.sufixo === "C") tipo = "Crédito";
    else if (escolhido.valor < 0) tipo = "Débito";
    else tipo = inferirTipoPorPalavraChave(descricao, escolhido.valor);

    let valorFinal = Math.abs(escolhido.valor);
    if (tipo === "Débito") valorFinal = -valorFinal;

    const ano = escolherAnoParaMes(mes, periodo);
    const descricaoFinal = combinarDescricaoComExtras(descricao, unidade);
    transacoes.push(novaTransacao({ dia, mes, ano }, descricaoFinal, valorFinal, tipo));
  }

  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Perfil Nubank — datas "DD MON AAAA" agrupando várias transações, e      */
/* débito/crédito indicado pela seção ("Total de entradas"/"Total de       */
/* saídas"), não por sinal ou palavra-chave na própria linha.              */
/* ---------------------------------------------------------------------- */

const MESES_PT_ABREV = {
  JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
  JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
};
const REGEX_DATA_NUBANK = /^(\d{2})\s+([A-ZÇ]{3})\s+(\d{4})\b(.*)$/i;

function parseLinhasNubank(linhas) {
  // O Nubank usa espaçamento vertical quase idêntico entre uma transação e a
  // linha de continuação (CNPJ/agência) que vem logo depois dela — bem
  // diferente de bancos como Itaú/Efí, onde a continuação fica visivelmente
  // mais perto. Por isso a mesclagem por distância (prepararLinhasParaPerfil)
  // não é confiável aqui; em vez disso, aproveita-se que no Nubank a
  // continuação SEMPRE vem depois da transação (nunca antes), e anexa-se
  // diretamente na última transação processada.
  const transacoes = [];
  let dataAtual = null;
  let modo = null; // "CREDITO" | "DEBITO" | null
  let ultimaTransacao = null;

  for (const linhaOriginal of linhas) {
    const linha = linhaOriginal.trim();
    if (!linha) continue;

    const mData = linha.match(REGEX_DATA_NUBANK);
    if (mData) {
      const mes = MESES_PT_ABREV[mData[2].toUpperCase()];
      if (mes) {
        dataAtual = { dia: parseInt(mData[1], 10), mes, ano: parseInt(mData[3], 10) };
        const resto = mData[4] || "";
        if (/total de entradas/i.test(resto)) modo = "CREDITO";
        else if (/total de sa[íi]das/i.test(resto)) modo = "DEBITO";
      }
      ultimaTransacao = null;
      continue;
    }

    if (/^total de entradas/i.test(linha)) { modo = "CREDITO"; ultimaTransacao = null; continue; }
    if (/^total de sa[íi]das/i.test(linha)) { modo = "DEBITO"; ultimaTransacao = null; continue; }
    if (
      linhaEhResumoSaldo(linha) ||
      /^rendimento l[íi]quido/i.test(linha) ||
      /^movimenta[çc][õo]es$/i.test(linha)
    ) {
      ultimaTransacao = null;
      continue;
    }

    if (!dataAtual || !modo) continue;

    const valores = encontrarValoresMonetarios(linha);
    if (valores.length === 0) {
      // Linha de continuação (CNPJ/agência) — sempre pertence à transação
      // imediatamente anterior, se houver uma.
      if (ultimaTransacao) {
        ultimaTransacao.descricao = (ultimaTransacao.descricao + " " + linha).trim();
      }
      continue;
    }

    const escolhido = valores[valores.length - 1];
    const descricao = linha.slice(0, escolhido.inicioTexto).replace(/[-(+]\s*$/, "").trim();
    if (!descricao) { ultimaTransacao = null; continue; }

    const tipo = modo === "CREDITO" ? "Crédito" : "Débito";
    const valorFinal = modo === "CREDITO" ? Math.abs(escolhido.valor) : -Math.abs(escolhido.valor);

    const transacao = novaTransacao({ ...dataAtual }, descricao, valorFinal, tipo);
    transacoes.push(transacao);
    ultimaTransacao = transacao;
  }

  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Perfil OuriBank — colunas separadas "Valor Crédito" e "Valor Débito"    */
/* (mais "Saldo") em vez de um valor com sinal.                            */
/* ---------------------------------------------------------------------- */

function interpretarLinhaOuribank(linhaTexto) {
  const m = linhaTexto.match(REGEX_DATA_INICIO_LINHA);
  if (!m) return null;

  const data = parsearDataPdf(m[1]);
  if (!data) return null;

  const resto = m[2];
  const valores = encontrarValoresMonetarios(resto);
  if (valores.length < 2) return null; // precisa de ao menos Crédito e Débito

  const valorCredito = valores[0];
  const valorDebito = valores[1];

  const descricao = resto.slice(0, valorCredito.inicioTexto).replace(/[-(+]\s*$/, "").trim();
  if (!descricao || linhaEhResumoSaldo(descricao)) return null;

  let tipo, valorFinal;
  if (Math.abs(valorCredito.valor) > 0) {
    tipo = "Crédito";
    valorFinal = Math.abs(valorCredito.valor);
  } else if (Math.abs(valorDebito.valor) > 0) {
    tipo = "Débito";
    valorFinal = -Math.abs(valorDebito.valor);
  } else {
    return null; // Crédito e Débito zerados — não é uma movimentação real
  }

  return novaTransacao(data, descricao, valorFinal, tipo);
}

function parseLinhasOuribank(unidades) {
  const transacoes = [];
  for (const unidade of unidades) {
    const transacao = interpretarLinhaOuribank(unidade.texto);
    if (transacao) {
      transacao.descricao = combinarDescricaoComExtras(transacao.descricao, unidade);
      transacoes.push(transacao);
    }
  }
  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Perfil C6 Bank — duas datas por linha (lançamento e contábil, usa-se a  */
/* primeira) sem ano, e valores com "R$"/"-R$" em vez de só o número.      */
/* ---------------------------------------------------------------------- */

function extrairAnoPeriodoC6(textoCompleto) {
  const m = textoCompleto.match(
    /\((\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})\)/
  );
  if (!m) return null;
  return {
    mesInicio: parseInt(m[2], 10),
    anoInicio: parseInt(m[3], 10),
    mesFim: parseInt(m[5], 10),
    anoFim: parseInt(m[6], 10),
  };
}

function parseLinhasC6(unidades, textoCompleto) {
  const periodo = extrairAnoPeriodoC6(textoCompleto);
  const transacoes = [];

  for (const unidade of unidades) {
    const m = unidade.texto.match(/^\s*(\d{2})\/(\d{2})\s+\d{2}\/\d{2}\s+(.*)$/);
    if (!m) continue;

    const dia = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) continue;

    const resto = m[3];
    const valores = encontrarValoresMonetarios(resto);
    if (valores.length === 0) continue;

    const escolhido = valores[valores.length - 1];
    const descricao = resto.slice(0, escolhido.inicioTexto).replace(/[-(+]\s*$/, "").trim();
    if (!descricao || linhaEhResumoSaldo(descricao)) continue;

    const tipo = escolhido.valor < 0 ? "Débito" : "Crédito";
    const ano = escolherAnoParaMes(mes, periodo);
    const descricaoFinal = combinarDescricaoComExtras(descricao, unidade);

    transacoes.push(novaTransacao({ dia, mes, ano }, descricaoFinal, escolhido.valor, tipo));
  }

  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Detecção de banco e ponto de entrada                                    */
/* ---------------------------------------------------------------------- */

function detectarBanco(textoCompleto) {
  if (/nu\s*pagamentos|nu\s*financeira|\bnubank\b/i.test(textoCompleto)) return "nubank";
  if (/banco\s+safra/i.test(textoCompleto)) return "safra";
  if (/sicredi/i.test(textoCompleto)) return "sicredi";
  if (/ita[uú]\s*(unibanco|bba)?/i.test(textoCompleto)) return "itau";
  if (/\bef[íi]\s*(bank|s\.?a\.?)\b|banco\s*364/i.test(textoCompleto)) return "efi";
  // O logotipo "ouribank" costuma ser uma imagem (não texto extraível);
  // detecta-se pelo nome do relatório ou pelos rótulos de saldo do rodapé.
  if (/ouribank|extratomov\.rpt|saldo\s*transit[óo]rio/i.test(textoCompleto)) return "ouribank";
  if (/c6\s*bank/i.test(textoCompleto)) return "c6";
  return "generico";
}

const NOMES_BANCO = {
  nubank: "Nubank", safra: "Banco Safra", sicredi: "Sicredi",
  itau: "Itaú", efi: "Efí", ouribank: "OuriBank", c6: "C6 Bank",
  generico: "Genérico",
};

let promessaWorkerPdf = null;

function inicializarWorkerPdf() {
  if (promessaWorkerPdf) return promessaWorkerPdf;

  promessaWorkerPdf = (async () => {
    const elemento = document.getElementById("pdf-worker-src");
    let codigoWorker = elemento ? elemento.textContent : "";

    if (!codigoWorker.trim()) {
      const caminho = elemento ? elemento.dataset.fallbackSrc : "pdf.worker.min.js";
      codigoWorker = await fetch(caminho).then((r) => r.text());
    }

    const blob = new Blob([codigoWorker], { type: "application/javascript" });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  })();

  return promessaWorkerPdf;
}

async function pdfParaTransacoes(arrayBuffer, bancoForcado) {
  if (typeof pdfjsLib === "undefined") {
    throw new ErroPdfInvalido("A biblioteca de leitura de PDF não carregou corretamente.");
  }

  await inicializarWorkerPdf();

  let documentoPdf;
  try {
    documentoPdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (e) {
    throw new ErroPdfInvalido("Não foi possível abrir o PDF: " + e.message);
  }

  const todasUnidades = [];
  const todasLinhasBrutas = [];
  for (let numPagina = 1; numPagina <= documentoPdf.numPages; numPagina++) {
    const pagina = await documentoPdf.getPage(numPagina);
    const conteudo = await pagina.getTextContent();

    const itens = conteudo.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
        height: it.height || Math.abs(it.transform[3]) || 10,
      }));

    const linhasComY = agruparItensEmLinhas(itens);
    todasLinhasBrutas.push(...linhasComY.map((l) => l.texto));
    // A mesclagem de continuação (prefixo/sufixo) é feita por página, para
    // não misturar o fim de uma página com o começo da próxima.
    todasUnidades.push(...prepararLinhasParaPerfil(linhasComY));
  }

  // Para detectar o banco e (no caso do Safra) o período do extrato, usa-se o
  // texto de TODAS as linhas originais — não só as "âncoras" — já que o nome
  // do banco às vezes cai justamente numa linha órfã mesclada como
  // prefixo/sufixo de outra transação.
  const textoCompleto = todasLinhasBrutas.join("\n");
  const bancoId = bancoForcado && bancoForcado !== "auto" ? bancoForcado : detectarBanco(textoCompleto);
  ultimoBancoDetectado = NOMES_BANCO[bancoId] || bancoId;

  let transacoes;
  if (bancoId === "nubank") transacoes = parseLinhasNubank(todasLinhasBrutas);
  else if (bancoId === "safra") transacoes = parseLinhasSafra(todasUnidades, textoCompleto);
  else if (bancoId === "ouribank") transacoes = parseLinhasOuribank(todasUnidades);
  else if (bancoId === "c6") transacoes = parseLinhasC6(todasUnidades, textoCompleto);
  else transacoes = parseLinhasGenerico(todasUnidades);

  if (transacoes.length === 0) {
    throw new ErroPdfInvalido(
      `Nenhuma transação foi identificada no PDF (perfil usado: ${ultimoBancoDetectado}). ` +
      "O layout deste extrato pode não ser compatível com o leitor."
    );
  }

  return transacoes;
}
