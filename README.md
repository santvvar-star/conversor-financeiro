# Conversor Financeiro OFX ↔ Excel — versão navegador

Versão do conversor que roda **inteiramente no navegador**, sem precisar
instalar Python nem nada — funciona em qualquer computador (Windows, Mac,
Linux), com ou sem internet. Interface com a identidade visual da **CESS
Contabilidade**.

## Como usar

1. Copie o arquivo **[`ConversorFinanceiro.html`](ConversorFinanceiro.html)**
   para o computador que você quiser usar (pendrive, e-mail, nuvem, o que for
   mais fácil) — ou acesse a versão publicada (GitHub Pages).
2. Dê duplo clique nele — ele abre no seu navegador padrão (Chrome, Edge,
   Firefox...).
3. Arraste um arquivo `.ofx`, `.xlsx`, `.pdf` ou `.csv` sobre a área indicada,
   ou clique para escolher o arquivo. A tela mostra quantas transações foram
   encontradas, e qual formato/perfil foi detectado (ex.: "PDF – Itaú",
   "CSV – Pinbank", "Planilha padrão"), antes de converter.
4. Clique em "Converter" — o resultado é baixado automaticamente na pasta de
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
- **CSV → Excel**: lê o extrato em `.csv` do Pinbank (`Data;Descrição;Valor;
  Tipo de transação;Referência;Lançamento futuro`) e gera a mesma planilha
  padronizada. As linhas de "Saldo do dia" são ignoradas automaticamente.

O formato de saída do conversor é decidido automaticamente pela entrada:
`.ofx`/`.pdf`/`.csv` geram Excel padrão, e `.xlsx` gera OFX.

### Estruturar para o Questor

Abaixo do conversor, na mesma página, há um **segundo painel independente**:
"Estruturar para o Questor". Ele não faz parte do fluxo de conversão normal —
é um atalho direto: arraste um extrato (`.ofx`, `.pdf`, `.csv`) ou uma
planilha padrão (`.xlsx`) nele e o arquivo já sai pronto no layout fixo que
o sistema Questor exige, sem passar por nenhuma escolha de formato. Veja a
seção **Layout do Questor** abaixo.

## Layout do Questor

O arquivo gerado tem sempre estas 8 colunas, nesta ordem:

| Coluna | Nome | Conteúdo |
|---|---|---|
| A | Data | data da transação (formatada `dd/mm/aaaa`) |
| B | Débito | código do banco, quando a transação é **entrada** |
| C | Crédito | código do banco, quando a transação é **saída** |
| D | Histórico | descrição da transação |
| E | Complemento | sempre `0` |
| F | Valor | valor da transação — sempre **positivo** quando há código de banco |
| G | Empresa | sempre em branco |
| H | Filial | sempre `1` |

As linhas seguem ordenadas por data (mais antiga primeiro), e o arquivo sai
com o sufixo `_questor` no nome (ex.: `ITAU_questor.xlsx`), para não se
confundir com a planilha padrão. `Complemento` e `Filial` são gravados como
número (`0` e `1`).

### Código do banco em Débito/Crédito

Quando o banco do extrato é conhecido, o **código da conta desse banco no
Questor** é lançado na coluna que indica a direção do movimento: **Débito**
para entradas (valor positivo no extrato) e **Crédito** para saídas (valor
negativo). Nesse caso a coluna **Valor sai sempre positiva**, já que a
direção passa a ser dada pela coluna em que o código aparece.

Códigos cadastrados hoje (em `CODIGOS_BANCO_QUESTOR`, em `src/conversor.js`):

| Banco | Código |
|---|---|
| Nubank | 7 |
| Pinbank | 8 |
| Bradesco | 9 |
| Itaú | 11 |
| Banco Safra | 14 |
| C6 Bank | 16 |
| Sicredi | 23 |

Bancos ainda sem código cadastrado (Efí, OuriBank, genérico) mantêm o
comportamento anterior: Débito/Crédito em branco e o **sinal na coluna
Valor** como único indicador de direção. Para cadastrar um código novo,
acrescente uma linha em `CODIGOS_BANCO_QUESTOR` — e, se o banco ainda não
estiver no seletor, em `BANCOS_SUPORTADOS` (`src/leitor_pdf.js`), com o
código COMPE em `COMPE_PARA_BANCO` e o nome em `detectarBanco`/`NOMES_BANCO`.

O banco usado é o do seletor **"Banco do extrato"** do painel Questor. Em
"Detectar automaticamente", vale o banco identificado na leitura do arquivo:

| Formato | Identificação automática do banco |
|---|---|
| `.pdf` | pelo texto do extrato (mesma detecção dos perfis de leitura) |
| `.ofx` | pelo campo `<ORG>` (nome da instituição) e, se faltar, pelo `<BANKID>` (código COMPE) |
| `.csv` | o layout já é exclusivo do Pinbank |
| `.xlsx` | **não é possível** — planilhas não trazem o banco em lugar nenhum |

Escolher um banco na lista tem prioridade sobre a detecção automática, e é o
único caminho para planilhas `.xlsx` (ou para um `.ofx` que não se
identifique). A prévia sempre informa o que vai acontecer antes de gerar o
arquivo — o código que será usado, ou um aviso de que o banco não foi
identificado / ainda não tem código cadastrado.

Só entram em `COMPE_PARA_BANCO` (em `src/leitor_pdf.js`) códigos COMPE
conferidos: um mapeamento errado colocaria a conta errada na planilha.

### Planilhas Excel "desconfiguradas" (outros sistemas)

Além da planilha padrão do próprio conversor, o painel Questor também
reconhece diretamente uma planilha exportada por outro sistema no formato
"Lançamentos" — cabeçalho `Data | Lançamento | Razão Social | CPF/CNPJ |
Valor (R$) | Saldo (R$) | NOTA` (com linhas de metadado antes do cabeçalho e
linhas de `SALDO ...` intercaladas entre as transações, que são ignoradas
automaticamente). Nesse layout, o **Histórico** é montado juntando
Lançamento + Razão Social + CPF/CNPJ + a coluna "Saldo" (que nesses arquivos
traz um texto de categoria/cliente, não um valor) + Nota — **eliminando
palavras repetidas** entre esses campos (ex.: se a Razão Social já contém
"GRANADAO", a coluna seguinte que repete essa palavra não é duplicada no
Histórico final). Detecção e leitura em `tentarLerLancamentosDetalhados` /
`lerLancamentosDetalhados`, em `src/conversor.js`.

### CSV do Pinbank

Extratos do Pinbank em `.csv` (separado por `;`, cabeçalho `Data;Descrição;
Valor;Tipo de transação;Referência;Lançamento futuro`) também são
reconhecidos direto, tanto no conversor normal quanto no painel Questor. As
linhas de "Saldo do dia" (sem "Tipo de transação" preenchido) são ignoradas
automaticamente, assim como qualquer linha marcada como lançamento futuro.
Detecção e leitura em `csvParaTransacoes` / `pareceCsvPinbank`, em
`src/conversor.js`.

## Estrutura

```
app_navegador/
├── ConversorFinanceiro.html   # arquivo único portátil (imagem embutida em base64)
├── index.html                 # versão publicada no GitHub Pages (imagem como arquivo separado)
├── cess_emblema.png           # logo da CESS Contabilidade (usada pelo index.html)
└── src/                       # código-fonte, para quem quiser editar
    ├── conversor.js           # lógica de conversão OFX <-> Excel
    ├── leitor_pdf.js          # leitura heurística de extratos em PDF
    ├── ui_cess.js             # interface (arrastar/soltar, prévia, progresso, download)
    ├── fflate.umd.js          # biblioteca de compressão ZIP (open source, MIT)
    ├── pdf.min.js             # pdf.js (Mozilla) — leitura de PDF
    ├── pdf.worker.min.js      # worker do pdf.js
    ├── cess_emblema.png       # cópia da logo, usada ao testar dev.html localmente
    └── dev.html               # versão para desenvolvimento (arquivos separados)
```

`index.html` e `ConversorFinanceiro.html` são gerados juntando o conteúdo de
`src/*.js` (e o worker do pdf.js) dentro de `src/dev.html`. A diferença entre
os dois é só a logo: no `index.html` ela fica como arquivo separado
(`cess_emblema.png`, ao lado dele no repositório); no `ConversorFinanceiro.html`
ela é embutida em base64, para o arquivo continuar sendo um único arquivo
portátil, sem depender de mais nada. Se for editar a lógica ou a interface,
edite os arquivos em `src/` e depois regenere os dois HTMLs.

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
