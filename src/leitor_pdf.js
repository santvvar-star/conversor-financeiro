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
 * também por Sicredi/Efí/Bradesco) assume o layout mais comum e exige data
 * com ano: Data | Descrição | Valor [| Saldo]. Safra, Nubank, OuriBank, C6,
 * Sicoob e Itaú têm formatos bem diferentes e têm parsers dedicados.
 *
 * O do Itaú é o único que decide pela POSIÇÃO do texto na página, e não pelo
 * texto da linha já montada — o extrato mensal dele tem duas colunas que se
 * fundem quando as linhas são reconstruídas só por Y.
 *
 * Perfil dedicado que não reconhece nada cai de volta no genérico, porque
 * cada banco publica mais de um modelo de extrato.
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
  { id: "bradesco", nome: "Bradesco" },
  { id: "itau", nome: "Itaú" },
  { id: "bb", nome: "Banco do Brasil" },
  { id: "caixa", nome: "Caixa" },
  { id: "sicredi", nome: "Sicredi" },
  { id: "sicoob", nome: "Sicoob" },
  { id: "asaas", nome: "Asaas / Imobia" },
  { id: "pagbank", nome: "PagBank" },
  { id: "efi", nome: "Efí" },
  { id: "nubank", nome: "Nubank" },
  { id: "inter", nome: "Banco Inter" },
  { id: "ouribank", nome: "OuriBank" },
  { id: "c6", nome: "C6 Bank" },
  { id: "pinbank", nome: "Pinbank (CSV)" },
];

let ultimoBancoDetectado = "";
let ultimoBancoIdDetectado = "";

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
    // `itens` acompanha a linha porque o perfil do Itaú precisa da posição X
    // de cada pedaço para separar as colunas; os demais perfis usam só o texto.
    return { texto, y: grupo.y, itens: ordenadosPorX };
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
/* Perfil SICOOB — data dd/mm (sem ano) e sinal no sufixo C/D do valor.    */
/*                                                                         */
/* Duas variantes de extrato foram vistas, e as duas passam por aqui:      */
/*   A) "05/01 PIX RECEB.OUTRA IF 450,00C"                                 */
/*   B) "30/01 Pix PIX RECEBIDO - OUTRA IF R$ 547,60C"  (tem uma coluna    */
/*      "Documento" a mais e prefixo R$; sai em ordem cronológica inversa) */
/* ---------------------------------------------------------------------- */

function extrairAnoPeriodoSicoob(textoCompleto) {
  const m = textoCompleto.match(
    /per[íi]odo:?\s*(\d{2})\/(\d{2})\/(\d{4})\s*[-a]\s*(\d{2})\/(\d{2})\/(\d{4})/i
  );
  if (!m) return null;
  return {
    mesInicio: parseInt(m[2], 10),
    anoInicio: parseInt(m[3], 10),
    mesFim: parseInt(m[5], 10),
    anoFim: parseInt(m[6], 10),
  };
}

function parseLinhasSicoob(unidades, textoCompleto) {
  const periodo = extrairAnoPeriodoSicoob(textoCompleto);
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

    // O valor da transação é o último da linha; o sufixo C/D é quem diz o
    // sinal (o SICOOB nunca usa "-"). Sem sufixo não dá para saber a direção,
    // e chutar erraria o lado da conta no Questor — melhor ignorar a linha.
    const escolhido = valores[valores.length - 1];
    if (escolhido.sufixo !== "C" && escolhido.sufixo !== "D") continue;

    const descricao = resto
      .slice(0, escolhido.inicioTexto)
      .replace(/\s*R\$\s*$/i, "")
      .replace(/[-(+]\s*$/, "")
      .trim();
    if (!descricao || linhaEhResumoSaldo(descricao)) continue;

    const tipo = escolhido.sufixo === "C" ? "Crédito" : "Débito";
    const valorFinal = tipo === "Crédito"
      ? Math.abs(escolhido.valor)
      : -Math.abs(escolhido.valor);

    const ano = escolherAnoParaMes(mes, periodo);
    const descricaoFinal = combinarDescricaoComExtras(descricao, unidade);

    transacoes.push(novaTransacao({ dia, mes, ano }, descricaoFinal, valorFinal, tipo));
  }

  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Perfil Itaú "extrato mensal" — o único que trabalha por coordenada.     */
/*                                                                         */
/* Este extrato tem DUAS colunas na página: legendas ("C = crédito a       */
/* compensar") à esquerda e a tabela de movimentação à direita. Como as    */
/* linhas são reconstruídas agrupando por Y, as duas colunas se fundem     */
/* num texto sem sentido ("Explicativas no final do extrato 03/02 IOF      */
/* 49,85-"). Por isso aqui se olha o X de cada pedaço em vez do texto já   */
/* montado. As faixas abaixo foram medidas em páginas A4 (largura 595) de  */
/* extratos de 2026; se o Itaú mudar o layout, o parser devolve 0 e o      */
/* chamador cai no perfil genérico.                                        */
/*                                                                         */
/* Outra particularidade: a data aparece só na PRIMEIRA transação do dia;  */
/* as seguintes vêm sem data e herdam a que estiver valendo.               */
/* ---------------------------------------------------------------------- */

// Depois da movimentação vêm seções de resumo ("totalizador de aplicações
// automáticas", "resumo - mês 01/2026") com tabelas nas MESMAS colunas. A do
// totalizador tem uma linha ("na conta corrente (1) 17.401,12 14.193,27-")
// que passaria por transação e sozinha inflava o total de créditos. Ao bater
// numa dessas marcas, para de ler.
const ITAU_REGEX_FIM_TABELA = /totalizador de aplica[çc][õo]es|^\s*saldo final\b/i;

const ITAU_X_DATA = { min: 140, max: 175 };
const ITAU_X_DESCRICAO = { min: 175, max: 355 };
const ITAU_X_ENTRADA = { min: 355, max: 415 };
const ITAU_X_SAIDA = { min: 415, max: 480 };
// Saldo acumulado (x ≈ 525) fica fora das duas faixas acima e é ignorado.

const MESES_ABREVIADOS = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

// O cabeçalho traz "extrato mensal ag 3613 cc 99812-3 jan 2026" — é de lá que
// sai o ano, já que as linhas só têm dia/mês.
function extrairMesAnoItau(textoCompleto) {
  const m = textoCompleto.match(
    /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s+(\d{4})\b/i
  );
  if (!m) return null;
  return { mes: MESES_ABREVIADOS[m[1].toLowerCase()], ano: parseInt(m[2], 10) };
}

// Um extrato de janeiro/2026 começa com o saldo de 31/12 — mês maior que o do
// extrato significa que a data é do ano anterior.
function anoParaMesItau(mes, referencia) {
  if (!referencia) return new Date().getFullYear();
  return mes > referencia.mes ? referencia.ano - 1 : referencia.ano;
}

function dentro(x, faixa) {
  return x >= faixa.min && x < faixa.max;
}

function parseLinhasItau(paginas, textoCompleto) {
  // As faixas de X abaixo valem para o "extrato mensal". O Itaú também emite
  // extrato por período e pelo app, com outro desenho de página — esses já
  // eram lidos pelo perfil genérico e devem continuar sendo, senão cadastrar
  // este perfil quebraria o que funcionava.
  if (!/extrato mensal/i.test(textoCompleto)) return [];

  const referencia = extrairMesAnoItau(textoCompleto);
  const transacoes = [];
  let dataCorrente = null;

  for (const linhas of paginas) {
    for (const linha of linhas) {
      if (ITAU_REGEX_FIM_TABELA.test(linha.texto)) return transacoes;

      const itens = linha.itens || [];

      // A data do dia fica numa coluna própria, à esquerda da descrição.
      const itemData = itens.find(
        (it) => dentro(it.x, ITAU_X_DATA) && /^\d{2}\/\d{2}$/.test(it.str.trim())
      );
      if (itemData) {
        const [dia, mes] = itemData.str.trim().split("/").map((n) => parseInt(n, 10));
        if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
          dataCorrente = { dia, mes, ano: anoParaMesItau(mes, referencia) };
        }
      }

      // Sem data ainda válida, estamos no cabeçalho/resumo da página — os
      // números de lá não são movimentação.
      if (!dataCorrente) continue;

      const entrada = itens.find(
        (it) => dentro(it.x, ITAU_X_ENTRADA) && ehValorItau(it.str)
      );
      const saida = itens.find(
        (it) => dentro(it.x, ITAU_X_SAIDA) && ehValorItau(it.str)
      );
      // Numa transação o valor cai numa coluna OU na outra. Linha com as duas
      // preenchidas é totalizador de resumo, não movimentação — descarta.
      if (entrada && saida) continue;

      const escolhido = entrada || saida;
      if (!escolhido) continue;

      const descricao = itens
        .filter((it) => dentro(it.x, ITAU_X_DESCRICAO))
        .map((it) => it.str.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!descricao || linhaEhResumoSaldo(descricao)) continue;

      const bruto = Math.abs(
        parseFloat(escolhido.str.trim().replace(/\./g, "").replace(",", ".").replace(/-$/, ""))
      );
      if (!Number.isFinite(bruto) || bruto === 0) continue;

      const tipo = entrada ? "Crédito" : "Débito";
      transacoes.push(
        novaTransacao(dataCorrente, descricao, tipo === "Crédito" ? bruto : -bruto, tipo)
      );
    }
  }

  return transacoes;
}

function ehValorItau(texto) {
  return /^\d{1,3}(?:\.\d{3})*,\d{2}-?$/.test(texto.trim());
}

/* ---------------------------------------------------------------------- */
/* Perfis Banco do Brasil, Caixa e Asaas/Imobia                            */
/*                                                                         */
/* Os três quebram uma transação em VÁRIAS linhas visuais: a data e o      */
/* histórico ficam numa, o valor noutra, o detalhe (hora, contraparte) em  */
/* mais outra. O perfil genérico exige data e valor na MESMA linha, então  */
/* não lê nenhum deles. Como as colunas são fixas, cada perfil remonta o   */
/* bloco pelo X de cada pedaço, como já é feito no Itaú.                   */
/*                                                                         */
/* Só a linha com data de 4 dígitos abre transação: as linhas de detalhe   */
/* começam com "dd/mm hh:mm", que passaria por data se o ano fosse         */
/* opcional.                                                               */
/* ---------------------------------------------------------------------- */

// Junta as páginas numa lista só. O risco de colar rodapé de uma página no
// cabeçalho da outra é coberto pela regra de que só data abre transação.
function linhasDeTodasAsPaginas(paginas) {
  const todas = [];
  for (const linhas of paginas) todas.push(...linhas);
  return todas;
}

function textoNaFaixa(itens, faixa) {
  return itens
    .filter((it) => dentro(it.x, faixa))
    .map((it) => it.str.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function temDataNaFaixa(itens, faixa) {
  return itens.some(
    (it) => dentro(it.x, faixa) && /^\d{2}\/\d{2}\/\d{4}$/.test(it.str.trim())
  );
}

function dataDeQuatroDigitos(itens, faixa) {
  const item = itens.find(
    (it) => dentro(it.x, faixa) && /^\d{2}\/\d{2}\/\d{4}$/.test(it.str.trim())
  );
  return item ? parsearDataPdf(item.str.trim()) : null;
}

/* --- Banco do Brasil: Dia | Lote | Documento | Histórico | Valor ------- */
/* O sinal vem como sufixo "(+)" / "(-)" na coluna de valor.               */

const BB_X_DATA = { min: 0, max: 70 };
const BB_X_HISTORICO = { min: 240, max: 500 };
const BB_X_VALOR = { min: 500, max: 620 };
const BB_REGEX_VALOR = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*\(([+-])\)/;

function parseLinhasBB(paginas) {
  const transacoes = [];
  let atual = null;

  const fechar = () => {
    if (
      atual && atual.valor !== null && atual.descricao &&
      !linhaEhResumoSaldo(atual.descricao)
    ) {
      transacoes.push(novaTransacao(
        atual.data, atual.descricao,
        atual.valor, atual.valor < 0 ? "Débito" : "Crédito"
      ));
    }
    atual = null;
  };

  for (const linha of linhasDeTodasAsPaginas(paginas)) {
    const itens = linha.itens || [];
    const data = dataDeQuatroDigitos(itens, BB_X_DATA);
    const historico = textoNaFaixa(itens, BB_X_HISTORICO);
    const mValor = textoNaFaixa(itens, BB_X_VALOR).match(BB_REGEX_VALOR);

    if (data) {
      fechar();
      atual = { data, descricao: historico, valor: null };
    } else if (temDataNaFaixa(itens, BB_X_DATA)) {
      fechar(); // o extrato usa "00/00/0000" como separador de bloco
    } else if (atual && historico) {
      atual.descricao = (atual.descricao + " " + historico).trim();
    }

    if (atual && mValor && atual.valor === null) {
      const bruto = Math.abs(parseFloat(mValor[1].replace(/\./g, "").replace(",", ".")));
      if (Number.isFinite(bruto)) atual.valor = mValor[2] === "-" ? -bruto : bruto;
    }
  }

  fechar();
  return transacoes;
}

/* --- Caixa: Data | Documento | Histórico | Valor | Saldo --------------- */
/* O histórico às vezes aparece na linha ANTERIOR à da data. E o débito é  */
/* marcado de DUAS formas diferentes no mesmo extrato: um "-" solto logo à */
/* direita da coluna de valor ("DEB PIX CHAVE | - "), ou o sinal colado no */
/* próprio valor ("- R$ 520,00"). As duas precisam ser reconhecidas — ler  */
/* só a primeira invertia o sinal de parte dos débitos, o que passava      */
/* despercebido porque a planilha saía com o valor certo e o lado errado.  */

const CAIXA_X_DATA = { min: 0, max: 70 };
const CAIXA_X_HISTORICO = { min: 150, max: 360 };
const CAIXA_X_VALOR = { min: 360, max: 415 };
const CAIXA_X_SINAL = { min: 415, max: 450 };

function parseLinhasCaixa(paginas) {
  const linhas = linhasDeTodasAsPaginas(paginas);
  const transacoes = [];
  let atual = null;
  let historicoAdiantado = "";

  const fechar = () => {
    if (
      atual && atual.valor !== null && atual.descricao &&
      !linhaEhResumoSaldo(atual.descricao)
    ) {
      const valor = atual.negativo ? -Math.abs(atual.valor) : Math.abs(atual.valor);
      transacoes.push(novaTransacao(
        atual.data, atual.descricao, valor, valor < 0 ? "Débito" : "Crédito"
      ));
    }
    atual = null;
  };

  const soHistorico = (itens) =>
    itens.length > 0 && itens.every((it) => dentro(it.x, CAIXA_X_HISTORICO));

  for (let i = 0; i < linhas.length; i++) {
    const itens = linhas[i].itens || [];
    const data = dataDeQuatroDigitos(itens, CAIXA_X_DATA);
    const historico = textoNaFaixa(itens, CAIXA_X_HISTORICO);
    const itemValor = itens.find(
      (it) => dentro(it.x, CAIXA_X_VALOR) && /\d{1,3}(?:\.\d{3})*,\d{2}/.test(it.str)
    );
    const temSinal = itens.some(
      (it) => dentro(it.x, CAIXA_X_SINAL) && it.str.trim() === "-"
    );

    if (data) {
      fechar();
      atual = {
        data,
        descricao: [historicoAdiantado, historico].filter(Boolean).join(" ").trim(),
        valor: null,
        negativo: temSinal,
      };
      historicoAdiantado = "";
    } else {
      // Linha só de histórico logo antes de uma data pertence à transação
      // SEGUINTE (ex.: "ENVIO DE TED"), não à anterior.
      const proxima = linhas[i + 1];
      if (soHistorico(itens) && proxima && temDataNaFaixa(proxima.itens || [], CAIXA_X_DATA)) {
        historicoAdiantado = historico;
        continue;
      }
      if (atual) {
        if (historico) atual.descricao = (atual.descricao + " " + historico).trim();
        if (temSinal) atual.negativo = true;
      }
    }

    if (atual && itemValor && atual.valor === null) {
      const m = itemValor.str.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
      if (m) {
        const bruto = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
        if (Number.isFinite(bruto)) {
          atual.valor = bruto;
          if (/-\s*(r\$)?\s*$/i.test(itemValor.str.slice(0, m.index))) atual.negativo = true;
        }
      }
    }
  }

  fechar();
  return transacoes;
}

/* --- Asaas / Imobia: Data | Descrição | Valor -------------------------- */
/* O valor fica numa linha LOGO ACIMA da linha da data, com sinal          */
/* explícito ("R$ -20,89"). A mesma coluna também traz "Saldo: R$ ...",    */
/* que é saldo acumulado e não pode ser confundido com o valor.            */
/*                                                                         */
/* Uma linha visual deste extrato é montada com deslocamentos de 6-7px     */
/* entre data, descrição e valor — mais do que a tolerância de agrupamento */
/* por Y. Quando a descrição é longa e quebra em duas, a data fica sozinha */
/* no meio dos dois pedaços. Por isso a descrição é juntada por            */
/* PROXIMIDADE VERTICAL da data, e não por estar na mesma linha.           */

const ASAAS_X_DATA = { min: 0, max: 80 };
const ASAAS_X_DESCRICAO = { min: 90, max: 480 };
const ASAAS_X_VALOR = { min: 480, max: 620 };
const ASAAS_REGEX_VALOR = /^R\$\s*(-?\d{1,3}(?:\.\d{3})*,\d{2})$/;
// Folga em pontos: cobre os 6-7px de deslocamento dentro da mesma linha
// visual, sem alcançar a transação vizinha (que fica a 30px ou mais).
const ASAAS_FOLGA_Y = 10;

function parseLinhasAsaas(paginas) {
  const linhas = linhasDeTodasAsPaginas(paginas);
  const transacoes = [];

  for (let i = 0; i < linhas.length; i++) {
    const itens = linhas[i].itens || [];
    const data = dataDeQuatroDigitos(itens, ASAAS_X_DATA);
    if (!data) continue;

    const partes = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(linhas.length - 1, i + 2); j++) {
      if (Math.abs(linhas[j].y - linhas[i].y) > ASAAS_FOLGA_Y) continue;
      const pedaco = textoNaFaixa(linhas[j].itens || [], ASAAS_X_DESCRICAO);
      if (pedaco) partes.push(pedaco);
    }
    const descricao = partes
      .join(" ")
      .replace(/\s*Saldo:\s*R\$\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!descricao || linhaEhResumoSaldo(descricao)) continue;

    // O valor está logo acima; linhas de saldo no caminho são puladas.
    let valor = null;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      const texto = textoNaFaixa(linhas[j].itens || [], ASAAS_X_VALOR);
      if (!texto || /saldo/i.test(texto)) continue;
      const m = texto.match(ASAAS_REGEX_VALOR);
      if (m) {
        const bruto = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
        if (Number.isFinite(bruto)) valor = bruto;
      }
      break;
    }
    if (valor === null || valor === 0) continue;

    transacoes.push(novaTransacao(
      data, descricao, valor, valor < 0 ? "Débito" : "Crédito"
    ));
  }

  return transacoes;
}

/* --- PagBank / PagSeguro: Data | Descrição | Valor --------------------- */
/*                                                                         */
/* Layout simples, mas o perfil genérico erra o SINAL aqui — e erra feio.  */
/* Neste extrato o valor só traz "-" quando é saída; entrada vem sem sinal */
/* nenhum. Sem sinal, o genérico chuta a direção por palavra-chave, e a    */
/* descrição de toda venda no cartão de débito diz "DEBITO"                */
/* ("Vendas - Disponivel DEBITO VISA"). Resultado: 146 vendas do mês       */
/* viravam saída, R$ 5.814,33 de receita lançada como despesa.             */
/*                                                                         */
/* "DEBITO"/"CREDITO" aqui é a bandeira do cartão do cliente, não a        */
/* direção do lançamento. Por isso este perfil usa SÓ o sinal impresso e   */
/* nunca infere por palavra.                                               */

const PAGBANK_X_DATA = { min: 0, max: 90 };
const PAGBANK_X_DESCRICAO = { min: 90, max: 500 };
const PAGBANK_X_VALOR = { min: 500, max: 620 };
const PAGBANK_REGEX_VALOR = /^(-?)\s*R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/;
// Descrição comprida quebra em duas linhas visuais, uma ACIMA e outra ABAIXO
// da linha da data — e as três ficam a 4-5px umas das outras, mais do que a
// tolerância de agrupamento por Y. A folga cobre esse deslocamento sem
// alcançar a transação vizinha, que fica a 22px. Sem juntar por proximidade,
// a linha da data ficava sem descrição e a transação era descartada: era
// exatamente o que acontecia com a única saída do mês (a tarifa de R$ 4,90).
const PAGBANK_FOLGA_Y = 10;

function parseLinhasPagbank(paginas) {
  const transacoes = [];

  // Página a página: o Y se repete de uma folha para a outra, então juntar
  // por proximidade na lista achatada colaria o rodapé de uma página no
  // cabeçalho da seguinte.
  for (const linhas of paginas) {
    for (let i = 0; i < linhas.length; i++) {
      const itens = linhas[i].itens || [];
      const data = dataDeQuatroDigitos(itens, PAGBANK_X_DATA);
      if (!data) continue;

      const m = textoNaFaixa(itens, PAGBANK_X_VALOR).match(PAGBANK_REGEX_VALOR);
      if (!m) continue;
      if (linhaEhResumoSaldo(textoNaFaixa(itens, PAGBANK_X_DESCRICAO))) continue;

      const partes = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(linhas.length - 1, i + 2); j++) {
        if (Math.abs(linhas[j].y - linhas[i].y) > PAGBANK_FOLGA_Y) continue;
        // Linha com data própria é outra transação, não continuação desta.
        if (j !== i && dataDeQuatroDigitos(linhas[j].itens || [], PAGBANK_X_DATA)) continue;
        const pedaco = textoNaFaixa(linhas[j].itens || [], PAGBANK_X_DESCRICAO);
        if (pedaco) partes.push(pedaco);
      }
      const descricao = partes.join(" ").replace(/\s+/g, " ").trim();
      if (!descricao || linhaEhResumoSaldo(descricao)) continue;

      const bruto = parseFloat(m[2].replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(bruto) || bruto === 0) continue;
      const valor = m[1] === "-" ? -bruto : bruto;

      transacoes.push(novaTransacao(
        data, descricao, valor, valor < 0 ? "Débito" : "Crédito"
      ));
    }
  }

  return transacoes;
}

/* --- Inter: a data não fica na linha, fica no cabeçalho do dia --------- */
/*                                                                         */
/* O extrato do Inter agrupa os lançamentos por dia. O dia aparece uma vez */
/* só, num cabeçalho escrito por extenso, e as linhas abaixo dele trazem   */
/* apenas descrição, valor e saldo corrido:                                */
/*                                                                         */
/*   28 de Julho de 2026    Saldo do dia: R$ 7.517,82                      */
/*   Pix enviado: "Cp :90400888-SHPP..."      -R$ 47,00     R$ 7.610,06    */
/*   Pix recebido: "Cp :60701190-N.P. VIEIRA..." R$ 9.000,00 R$ 16.517,82  */
/*                                                                         */
/* É por isso que ele precisa de perfil próprio: sem data no começo da     */
/* linha, o perfil genérico não reconhece transação nenhuma.               */
/*                                                                         */
/* As colunas são separadas pelo X, e não pela ordem dos valores no texto, */
/* porque o histórico de um PIX é texto livre e pode trazer um número no   */
/* formato de dinheiro — que passaria a ser lido como o valor lançado.     */
/*                                                                         */
/* O sinal é explícito no documento ("-R$" no débito, "R$" no crédito),    */
/* então o tipo vem dele, e não de palavra-chave na descrição.             */

const INTER_X_DESCRICAO = { min: 0, max: 400 };
// A coluna de valor é alinhada à direita e termina por volta de x=462; a de
// saldo começa em x=508. O corte em 485 cai na folga entre as duas.
const INTER_X_VALOR = { min: 400, max: 485 };
const INTER_REGEX_VALOR = /^(-?)\s*R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/;
const INTER_MESES = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const INTER_REGEX_DIA = /^(\d{1,2})\s+de\s+([a-zà-ú]+)\s+de\s+(\d{4})\b/i;
// Descrição comprida pode quebrar em duas linhas visuais, e a continuação
// vem logo abaixo, sem valor nenhum. O limite de distância é o que separa
// essa quebra do rodapé da página ("Fale com a gente", "SAC: 0800..."), que
// também é linha solta — só que a 42px da última transação, contra os 18-20px
// de espaçamento normal entre linhas.
const INTER_FOLGA_CONTINUACAO = 24;

function dataDeCabecalhoInter(texto) {
  const m = texto.trim().match(INTER_REGEX_DIA);
  if (!m) return null;
  const mes = INTER_MESES[m[2].toLowerCase()];
  if (!mes) return null;
  const dia = parseInt(m[1], 10);
  if (dia < 1 || dia > 31) return null;
  return { dia, mes, ano: parseInt(m[3], 10) };
}

function parseLinhasInter(paginas) {
  const transacoes = [];
  // O cabeçalho de dia vale para tudo que vem depois dele, inclusive quando
  // o mesmo dia continua na página seguinte — por isso a data fica fora do
  // laço de páginas.
  let dataAtual = null;

  for (const linhas of paginas) {
    for (let i = 0; i < linhas.length; i++) {
      const itens = linhas[i].itens || [];
      const texto = linhas[i].texto.trim();
      if (!texto) continue;

      const cabecalho = dataDeCabecalhoInter(texto);
      if (cabecalho) {
        dataAtual = cabecalho;
        continue;
      }
      if (!dataAtual) continue; // ainda no cabeçalho do documento

      const m = textoNaFaixa(itens, INTER_X_VALOR).match(INTER_REGEX_VALOR);
      if (!m) continue;

      const bruto = parseFloat(m[2].replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(bruto) || bruto === 0) continue;
      const valor = m[1] === "-" ? -bruto : bruto;

      let descricao = textoNaFaixa(itens, INTER_X_DESCRICAO);
      let yAnterior = linhas[i].y;
      for (let j = i + 1; j < linhas.length; j++) {
        if (Math.abs(yAnterior - linhas[j].y) > INTER_FOLGA_CONTINUACAO) break;
        const seguintes = linhas[j].itens || [];
        // Linha com valor próprio é outra transação, não continuação desta.
        if (INTER_REGEX_VALOR.test(textoNaFaixa(seguintes, INTER_X_VALOR))) break;
        if (dataDeCabecalhoInter(linhas[j].texto)) break;
        const pedaco = textoNaFaixa(seguintes, INTER_X_DESCRICAO);
        if (!pedaco) break;
        descricao = (descricao + " " + pedaco).trim();
        yAnterior = linhas[j].y;
        i = j;
      }

      if (!descricao || linhaEhResumoSaldo(descricao)) continue;

      transacoes.push(novaTransacao(
        dataAtual, descricao, valor, valor < 0 ? "Débito" : "Crédito"
      ));
    }
  }

  return transacoes;
}

/* --- Planilha "Lançamentos" de outro sistema, impressa em PDF ---------- */
/*                                                                         */
/* Mesmo layout que o leitor de .xlsx já trata (`Data | Lançamento | Razão */
/* Social | CPF/CNPJ | Valor (R$) | Saldo (R$)` + NOTA), só que exportado  */
/* como PDF em paisagem. Não é banco nenhum: o arquivo não diz de qual     */
/* conta veio, então o código do Questor continua vindo da escolha manual, */
/* como acontece com a versão em planilha.                                 */
/*                                                                         */
/* Reconhecê-lo importa por um motivo além de ler certo: sem isso o        */
/* arquivo caía no perfil genérico E era identificado como Itaú, porque    */
/* uma das transações se chama "SEGURO ITAUEMPRESA". Isso lançaria o       */
/* código 11 (Itaú) numa conta que não é do Itaú, em silêncio.             */

const LANC_X_DATA = { min: 0, max: 80 };
const LANC_X_LANCAMENTO = { min: 80, max: 250 };
const LANC_X_RAZAO = { min: 250, max: 365 };
const LANC_X_CPF = { min: 365, max: 450 };
const LANC_X_VALOR = { min: 450, max: 505 };
const LANC_X_NOTA = { min: 545, max: 1200 };
// A planilha vem do Excel com formato "geral": o mesmo arquivo traz
// "1402,06", "-633,2" e "696". Casas decimais são opcionais.
const LANC_REGEX_VALOR = /^-?[\d.]+(?:,\d{1,2})?$/;

function parseLinhasLancamentos(paginas) {
  const linhas = linhasDeTodasAsPaginas(paginas);
  const transacoes = [];

  for (let i = 0; i < linhas.length; i++) {
    const itens = linhas[i].itens || [];
    const data = dataDeQuatroDigitos(itens, LANC_X_DATA);
    if (!data) continue;

    const lancamento = textoNaFaixa(itens, LANC_X_LANCAMENTO);
    if (!lancamento || linhaEhResumoSaldo(lancamento)) continue;

    const bruto = textoNaFaixa(itens, LANC_X_VALOR);
    if (!LANC_REGEX_VALOR.test(bruto)) continue;
    const valor = parseFloat(bruto.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(valor) || valor === 0) continue;

    // A coluna NOTA cai numa linha própria, logo abaixo da transação.
    let nota = textoNaFaixa(itens, LANC_X_NOTA);
    const proxima = linhas[i + 1];
    if (!nota && proxima && !dataDeQuatroDigitos(proxima.itens || [], LANC_X_DATA)) {
      nota = textoNaFaixa(proxima.itens || [], LANC_X_NOTA);
    }

    // Mesmo histórico da versão em planilha: junta as colunas descartando
    // palavra repetida (a razão social costuma repetir o lançamento).
    const descricao = montarHistoricoSemRepeticao([
      lancamento,
      textoNaFaixa(itens, LANC_X_RAZAO),
      textoNaFaixa(itens, LANC_X_CPF),
      nota,
    ]);

    transacoes.push(novaTransacao(
      data, descricao, valor, valor < 0 ? "Débito" : "Crédito"
    ));
  }

  return transacoes;
}

/* ---------------------------------------------------------------------- */
/* Detecção de banco e ponto de entrada                                    */
/* ---------------------------------------------------------------------- */

// O relatório "Lançamentos" não diz de qual banco veio, mas o texto que o
// PRÓPRIO banco escreve na coluna Lançamento denuncia a origem. Só entram
// aqui frases e produtos que o banco emite em todo extrato — no arquivo do
// usuário, "SALDO TOTAL DISPONÍVEL" aparece uma vez por dia. Nome de
// terceiro nunca entra: o mesmo relatório traz um "SEGURO ITAUEMPRESA", que
// é produto contratado e não prova de onde é a conta. Sem origem
// reconhecida, o banco continua vindo da escolha manual.
function bancoDeOrigemLancamentos(textoCompleto) {
  if (/saldo\s+total\s+dispon[íi]vel|aplic\s*aut\s*mais/i.test(textoCompleto)) {
    return "itau";
  }
  return "";
}

function detectarBanco(textoCompleto) {
  // Vem primeiro de todos: é um layout, não um banco, e o arquivo está cheio
  // de nome de terceiro no histórico ("SEGURO ITAUEMPRESA") que dispara as
  // regras de banco abaixo. A marca é o cabeçalho de colunas do relatório.
  if (/\blan[çc]amento\b[\s\S]{0,40}\braz[ãa]o\s+social\b[\s\S]{0,40}\bcpf\/cnpj\b/i.test(textoCompleto)) {
    return "lancamentos";
  }
  // O Sicoob vem primeiro e é reconhecido por frases do cabeçalho do próprio
  // documento, não pelo nome solto: "Sicoob" aparece com frequência no
  // histórico de PIX de extratos de OUTROS bancos ("TRANSF.RECEBIDA - PIX
  // SICOOB FULANO"), e o contrário também — um extrato do Sicoob pode citar
  // "Sicredi" num histórico e cair na regra de baixo.
  if (
    /sistema de cooperativas de cr[ée]dito do brasil/i.test(textoCompleto) ||
    /plataforma de servi[çc]os financeiros do sicoob/i.test(textoCompleto) ||
    /sicoob\s*\|\s*internet banking/i.test(textoCompleto) ||
    // Razão social da instituição, como vem no campo <ORG> de um OFX do Sicoob.
    /banco cooperativo do brasil/i.test(textoCompleto)
  ) {
    return "sicoob";
  }
  // Asaas antes da Caixa: o extrato dele se chama "Caixa Digital Imobia" e
  // cairia na regra da Caixa. O nome "Asaas" não aparece no documento — a
  // marca é a plataforma (Imobia), que é quem emite o extrato.
  if (/imobia\.app|caixa\s+digital\s+imobia|extrato\s+de\s+caixa\s+digital/i.test(textoCompleto)) {
    return "asaas";
  }
  // Caixa antes do Nubank: "NU PAGAMENTOS" aparece no histórico de PIX de
  // extratos da Caixa, e a regra do Nubank abaixo pegaria o extrato inteiro.
  // A marca é o rodapé de atendimento, que só existe no documento da Caixa.
  if (/sac\s+caixa|al[ôo]\s+caixa|caixa\s+econ[ôo]mica\s+federal/i.test(textoCompleto)) {
    return "caixa";
  }
  // O Inter se identifica no cabeçalho do próprio extrato ("Instituição:
  // Banco Inter") e no telefone do rodapé. Exigir o rótulo junto do nome é o
  // que evita casar com um "PIX BANCO INTER" no histórico de extrato de
  // outro banco. A checagem vem antes das regras de nome solto (Itaú,
  // Sicredi, Bradesco...) porque o caminho inverso também acontece: o
  // histórico do extrato do Inter cita o banco de quem paga e de quem recebe.
  if (/institui[çc][ãa]o:\s*banco\s+inter\b|\b0800\s*940\s*9999\b/i.test(textoCompleto)) {
    return "inter";
  }
  // O extrato do BB não escreve "Banco do Brasil" em lugar nenhum; a marca
  // é o cabeçalho de colunas, que traz "Lote" — coluna que só ele tem.
  if (/\bdia\s+lote\s+documento\s+hist[óo]rico/i.test(textoCompleto)) return "bb";
  // O PagBank se identifica no cabeçalho com o próprio COMPE ("290 -
  // PagSeguro Internet S/A"). Exigir o número junto do nome evita casar com
  // um "PIX PAGSEGURO" no histórico de extrato de outro banco.
  if (/\b290\s*-\s*pagseguro/i.test(textoCompleto)) return "pagbank";
  if (/nu\s*pagamentos|nu\s*financeira|\bnubank\b/i.test(textoCompleto)) return "nubank";
  if (/banco\s+safra/i.test(textoCompleto)) return "safra";
  if (/sicredi/i.test(textoCompleto)) return "sicredi";
  if (/ita[uú]\s*(unibanco|bba)?/i.test(textoCompleto)) return "itau";
  if (/\bef[íi]\s*(bank|s\.?a\.?)\b|banco\s*364/i.test(textoCompleto)) return "efi";
  // O logotipo "ouribank" costuma ser uma imagem (não texto extraível);
  // detecta-se pelo nome do relatório ou pelos rótulos de saldo do rodapé.
  if (/ouribank|extratomov\.rpt|saldo\s*transit[óo]rio/i.test(textoCompleto)) return "ouribank";
  if (/c6\s*bank/i.test(textoCompleto)) return "c6";
  // Por último, para não passar na frente dos bancos com perfil próprio: um
  // extrato de outro banco pode citar "Bradesco" no histórico de uma
  // transferência. Não há perfil de PDF do Bradesco (cai no genérico) — o
  // valor de reconhecê-lo é o código de banco no layout do Questor.
  if (/bradesco/i.test(textoCompleto)) return "bradesco";
  return "generico";
}

// Código COMPE (o "número do banco" do sistema bancário brasileiro), como
// vem no campo <BANKID> de um arquivo OFX. Só os códigos conferidos entram
// aqui: um mapeamento errado colocaria a conta errada na planilha do
// Questor. Serve como segunda tentativa, quando o nome do banco não aparece
// no arquivo — e o resultado sempre é mostrado na prévia antes de gerar.
const COMPE_PARA_BANCO = {
  "341": "itau",
  "237": "bradesco",
  "422": "safra",
  "748": "sicredi",
  "260": "nubank",
  "336": "c6",
  // Conferido em 2026-08-14 num OFX real do usuário: <ORG>Banco Cooperativo
  // do Brasil</ORG>, <FID>756</FID>, <BANKID>756</BANKID>.
  "756": "sicoob",
  // O extrato do PagBank imprime o proprio COMPE no cabecalho:
  // "290 - PagSeguro Internet S/A".
  "290": "pagbank",
  // O extrato do Inter não imprime o COMPE (traz só "Instituição: Banco
  // Inter"); 077 vem da tabela pública do Bacen, onde é o único código do
  // Banco Inter S.A. Ainda não foi visto num OFX real do usuário.
  "077": "inter",
};

function detectarBancoPorCompe(compe) {
  const digitos = String(compe || "").replace(/\D/g, "").replace(/^0+/, "");
  if (!digitos) return "generico";
  return COMPE_PARA_BANCO[digitos.padStart(3, "0")] || "generico";
}

const NOMES_BANCO = {
  nubank: "Nubank", safra: "Banco Safra", sicredi: "Sicredi",
  sicoob: "Sicoob", itau: "Itaú", efi: "Efí", ouribank: "OuriBank",
  c6: "C6 Bank", bradesco: "Bradesco", pinbank: "Pinbank",
  inter: "Banco Inter",
  bb: "Banco do Brasil", caixa: "Caixa", asaas: "Asaas / Imobia",
  pagbank: "PagBank",
  // Não é banco: é o relatório "Lançamentos" de outro sistema. Fica fora de
  // BANCOS_SUPORTADOS e de CODIGOS_BANCO_QUESTOR de propósito, para que o
  // código da conta continue vindo da escolha manual.
  lancamentos: "planilha Lançamentos",
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
  // Guardadas por página e com as coordenadas intactas, para o perfil do Itaú,
  // que precisa separar as colunas pelo X (ver parseLinhasItau).
  const paginasComLinhas = [];
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
    paginasComLinhas.push(linhasComY);
    // A mesclagem de continuação (prefixo/sufixo) é feita por página, para
    // não misturar o fim de uma página com o começo da próxima.
    todasUnidades.push(...prepararLinhasParaPerfil(linhasComY));
  }

  // Para detectar o banco e (no caso do Safra) o período do extrato, usa-se o
  // texto de TODAS as linhas originais — não só as "âncoras" — já que o nome
  // do banco às vezes cai justamente numa linha órfã mesclada como
  // prefixo/sufixo de outra transação.
  const textoCompleto = todasLinhasBrutas.join("\n");
  const detectado = detectarBanco(textoCompleto);

  // O relatório "Lançamentos" é um LAYOUT, não um banco: a leitura dele é
  // decidida pelo documento, nunca pela escolha do seletor. Sem isso,
  // escolher "Itaú" à mão faria o arquivo passar pelo perfil do extrato
  // mensal do Itaú, que não reconhece nada aqui e cairia no genérico — o
  // caminho que já vinha lendo metade das transações errado.
  const ehRelatorioLancamentos = detectado === "lancamentos";

  const bancoId = bancoForcado && bancoForcado !== "auto" ? bancoForcado : detectado;

  // Para o código do Questor vale o banco de ORIGEM do relatório, quando dá
  // para saber; se não der, fica "lancamentos" e a prévia pede a escolha.
  ultimoBancoIdDetectado =
    ehRelatorioLancamentos && (!bancoForcado || bancoForcado === "auto")
      ? bancoDeOrigemLancamentos(textoCompleto) || "lancamentos"
      : bancoId;
  ultimoBancoDetectado = NOMES_BANCO[ultimoBancoIdDetectado] || ultimoBancoIdDetectado;

  let transacoes;
  if (ehRelatorioLancamentos) transacoes = parseLinhasLancamentos(paginasComLinhas);
  else if (bancoId === "nubank") transacoes = parseLinhasNubank(todasLinhasBrutas);
  else if (bancoId === "safra") transacoes = parseLinhasSafra(todasUnidades, textoCompleto);
  else if (bancoId === "ouribank") transacoes = parseLinhasOuribank(todasUnidades);
  else if (bancoId === "c6") transacoes = parseLinhasC6(todasUnidades, textoCompleto);
  else if (bancoId === "sicoob") transacoes = parseLinhasSicoob(todasUnidades, textoCompleto);
  else if (bancoId === "itau") transacoes = parseLinhasItau(paginasComLinhas, textoCompleto);
  else if (bancoId === "bb") transacoes = parseLinhasBB(paginasComLinhas);
  else if (bancoId === "caixa") transacoes = parseLinhasCaixa(paginasComLinhas);
  else if (bancoId === "asaas") transacoes = parseLinhasAsaas(paginasComLinhas);
  else if (bancoId === "pagbank") transacoes = parseLinhasPagbank(paginasComLinhas);
  else if (bancoId === "inter") transacoes = parseLinhasInter(paginasComLinhas);
  else if (bancoId === "lancamentos") transacoes = parseLinhasLancamentos(paginasComLinhas);
  else transacoes = parseLinhasGenerico(todasUnidades);

  // Os perfis do Sicoob e do Itaú são feitos sob medida para um layout
  // específico de extrato. Cada banco publica mais de um (mensal, por
  // período, pelo app...), e os outros já eram lidos pelo perfil genérico —
  // então, quando o perfil dedicado não reconhece nada, tenta-se o genérico
  // antes de desistir. Sem isso, cadastrar um perfil novo quebraria extratos
  // que já funcionavam.
  const COM_PERFIL_POR_LAYOUT = ["sicoob", "itau", "bb", "caixa", "asaas", "pagbank", "inter"];
  if (transacoes.length === 0 && (ehRelatorioLancamentos || COM_PERFIL_POR_LAYOUT.includes(bancoId))) {
    transacoes = parseLinhasGenerico(todasUnidades);
  }

  if (transacoes.length === 0) {
    throw new ErroPdfInvalido(
      `Nenhuma transação foi identificada no PDF (perfil usado: ${ultimoBancoDetectado}). ` +
      "O layout deste extrato pode não ser compatível com o leitor."
    );
  }

  return transacoes;
}
