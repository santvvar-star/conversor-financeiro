# Conversor Financeiro OFX ↔ Excel — versão navegador

Versão do conversor que roda **inteiramente no navegador**, sem precisar
instalar Python nem nada — funciona em qualquer computador (Windows, Mac,
Linux), com ou sem internet.

## Como usar

1. Copie o arquivo **[`ConversorFinanceiro.html`](ConversorFinanceiro.html)**
   para o computador que você quiser usar (pendrive, e-mail, nuvem, o que for
   mais fácil).
2. Dê duplo clique nele — ele abre no seu navegador padrão (Chrome, Edge,
   Firefox...).
3. Arraste um arquivo `.ofx`, `.xlsx` ou `.pdf` sobre a área indicada, ou
   clique para escolher o arquivo.
4. O resultado da conversão é baixado automaticamente na mesma pasta de
   downloads do navegador.

Não precisa instalar nada, não precisa de internet, e nenhum arquivo é
enviado para fora do seu computador — toda a conversão acontece localmente,
no próprio navegador.

## O que ele faz

Mesma lógica da versão Python (linha de comando) deste projeto:

- **OFX → Excel**: extrai data, descrição, valor, tipo, conta e ID da
  transação de um extrato `.ofx` e gera uma planilha `.xlsx` com as colunas
  `Data | Descrição | Valor | Tipo | Categoria | Conta | ID Transação`,
  ordenada por data, com datas em `dd/mm/aaaa` e valores em R$.
- **Excel → OFX**: lê uma planilha com essas mesmas colunas e gera um
  arquivo `.ofx` válido (formato SGML 1.02).
- **PDF → Excel**: extrai transações de um extrato em PDF e gera a mesma
  planilha padronizada. Veja a seção **Sobre a leitura de PDF** abaixo —
  essa conversão é heurística, não garantida como as outras duas.

## Estrutura

```
app_navegador/
├── ConversorFinanceiro.html   # arquivo único — é este que você usa/compartilha
└── src/                       # código-fonte, para quem quiser editar
    ├── conversor.js           # lógica de conversão OFX <-> Excel
    ├── leitor_pdf.js          # leitura heurística de extratos em PDF
    ├── ui.js                  # interface (arrastar/soltar, mensagens)
    ├── fflate.umd.js          # biblioteca de compressão ZIP (open source, MIT)
    ├── pdf.min.js             # pdf.js (Mozilla) — leitura de PDF
    ├── pdf.worker.min.js      # worker do pdf.js
    └── dev.html               # versão para desenvolvimento (arquivos separados)
```

`ConversorFinanceiro.html` é gerado juntando o conteúdo de `src/*.js` (e o
worker do pdf.js) dentro de `src/dev.html`. Se for editar a lógica, edite os
arquivos em `src/` e depois regenere o `ConversorFinanceiro.html`
(concatenando os `<script>`).

## Sobre a leitura de PDF

Diferente de OFX e Excel, um PDF não tem estrutura de dados — é só texto
posicionado visualmente na página. O leitor (`leitor_pdf.js`) reconstrói o
texto linha por linha (agrupando pela posição vertical) e depois usa um
**perfil de banco** para interpretar essas linhas.

Na interface, há um seletor **"Banco do extrato"**: em "Detectar
automaticamente" (padrão), o leitor procura o nome do banco no texto do PDF;
você também pode forçar manualmente.

**Bancos com perfil testado contra extrato real** (mais confiáveis):

| Banco | Particularidade tratada |
|---|---|
| Itaú | Genérico (ver abaixo) já cobre bem |
| Sicredi | Genérico + ignora a seção final "Lançamentos Futuros" |
| Efí | Genérico já cobre bem |
| Banco Safra | Data sem ano (`dd/mm`) — o ano é inferido do período do extrato |
| Nubank | Formato bem diferente: datas agrupam várias transações, e o tipo (crédito/débito) é definido pela seção ("Total de entradas"/"Total de saídas"), não por sinal na linha |
| OuriBank | Colunas separadas "Valor Crédito" e "Valor Débito" (em vez de um valor com sinal) — o tipo é definido por qual das duas colunas está preenchida |
| C6 Bank | Duas datas por linha (lançamento e contábil — usa-se a de lançamento) sem ano, e valores no formato `-R$ 150,00` (sinal antes do "R$", não do número) |

**Perfil Genérico** (usado como base por Itaú/Sicredi/Efí, e também para
qualquer banco não reconhecido): procura, em cada linha, uma data no início
(`dd/mm/aaaa`) seguida de uma descrição e um valor monetário. Quando há dois
valores na linha (comum em extratos com coluna de saldo acumulado), assume
que o penúltimo é o valor da transação e o último é o saldo. Linhas cuja
descrição começa com "Saldo" (saldo anterior, saldo do dia, saldo total
etc.) são sempre ignoradas, em qualquer perfil.

**Descrições que quebram em duas linhas no PDF** (comum quando a Razão
Social do pagador/recebedor é longa) são remontadas automaticamente: o
leitor compara a distância vertical entre linhas para diferenciar uma
continuação real (linha bem próxima da transação, seja antes ou depois dela
— alguns bancos centralizam a célula) de um cabeçalho/rodapé de página
(sempre bem mais distante). O Nubank usa uma regra própria para isso, já
que seu espaçamento entre continuação e linha nova é quase idêntico,
inviabilizando a distinção por distância — nesse banco a continuação sempre
vem depois da transação, nunca antes.

Isso funciona bem para o layout mais comum de extrato (`Data | Histórico |
Valor | Saldo`), mas **não é garantido** para bancos fora da lista acima —
layouts com colunas em outra ordem, ou sem data no início de cada linha,
podem não ser reconhecidos. Por isso:

- Depois de converter um PDF, **confira a pré-visualização na tela** antes
  de considerar o Excel gerado como definitivo — a interface mostra um aviso
  para isso.
- Se o leitor não reconhecer nada ("Nenhuma transação foi identificada"),
  ou reconhecer valores/tipos errados, para um banco novo o ajuste é
  adicionar um perfil em `src/leitor_pdf.js`: uma função `detectarBanco`
  (para reconhecer o banco pelo texto) mais uma função `parseLinhasXxx`
  (para interpretar as linhas daquele layout). Os perfis existentes servem
  de exemplo — `parseLinhasSafra` para um caso "data sem ano", e
  `parseLinhasNubank` para um caso com estrutura bem diferente (seções em
  vez de coluna de sinal).

## Limitações

- Testado nos navegadores baseados em Chromium (Chrome, Edge). Deve
  funcionar em Firefox e Safari também, por usar apenas APIs padrão do
  navegador (File, Blob, DOMParser, TextDecoder), mas não foi testado
  neles.
- A leitura de PDF é heurística (ver seção acima) — as conversões OFX ↔
  Excel continuam sendo as únicas com leitura garantida/estrutural.
- Não há conversão de Excel ou OFX para PDF (só PDF → Excel).
