/* =========================================================================
   CONVERSOR CESS — controlador da interface
   -------------------------------------------------------------------------
   Dois fluxos independentes na mesma página, cada um com seu próprio drop
   zone / prévia / progresso / download, montados por criarFluxo():
     1) Conversor (OFX/PDF -> Excel, ou Excel -> OFX) — formato de saída
        decidido automaticamente pela extensão de entrada.
     2) Painel "Estruturar para o Questor" — sempre gera o layout fixo do
        Questor, qualquer que seja a entrada (.ofx, .xlsx ou .pdf).
   ========================================================================= */

const STEP_NAMES = ['Lendo arquivo', 'Detectando transações', 'Gerando planilha', 'Finalizando'];
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SAIDA_EXCEL   = { key: 'xlsx',    short: 'XLSX',    ext: 'xlsx', sufixo: '',         rotulo: 'Planilha Excel (.xlsx)' };
const SAIDA_OFX     = { key: 'ofx',     short: 'OFX',     ext: 'ofx',  sufixo: '',         rotulo: 'Arquivo OFX (.ofx)' };
const SAIDA_QUESTOR = { key: 'questor', short: 'Questor', ext: 'xlsx', sufixo: '_questor', rotulo: 'Layout Questor (.xlsx)' };

function extensaoDoArquivo(name){
  return (name.split('.').pop() || '').toLowerCase();
}

function formatarPeriodo(transacoes){
  if (!transacoes || transacoes.length === 0) return '';
  const ordenadas = [...transacoes].sort((a, b) => compararData(a.data, b.data));
  const inicio = dataParaDDMMAAAA(ordenadas[0].data);
  const fim = dataParaDDMMAAAA(ordenadas[ordenadas.length - 1].data);
  return inicio === fim ? inicio : (inicio + ' – ' + fim);
}

function popularBancos(select){
  for (const banco of BANCOS_SUPORTADOS) {
    const opcao = document.createElement('option');
    opcao.value = banco.id;
    opcao.textContent = banco.nome;
    select.appendChild(opcao);
  }
}

/* =========================================================================
   Aviso de versão nova
   -------------------------------------------------------------------------
   O GitHub Pages manda o navegador guardar a página por 10 minutos, e na
   prática o navegador costuma segurá-la por muito mais. Resultado: depois de
   uma atualização o usuário continua vendo a versão antiga sem perceber.
   Como remédio, a página compara sua própria versão com o `versao.txt`
   publicado ao lado dela (poucos bytes, buscado sem cache) e, se estiver
   defasada, oferece recarregar. Falha em silêncio quando não há como
   verificar — arquivo local aberto direto do disco, sem internet, etc.
   ========================================================================= */
const VERSAO_APP = (document.getElementById('versao-app') || {}).textContent || '';

async function verificarVersaoNova(){
  if (!VERSAO_APP.trim()) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  let publicada;
  try {
    const resp = await fetch('versao.txt?cb=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return;
    publicada = (await resp.text()).trim();
  } catch (e) {
    return; // sem internet ou servido de um lugar sem o versao.txt
  }

  if (!publicada || publicada === VERSAO_APP.trim()) return;

  const aviso = document.createElement('div');
  aviso.className = 'toast';
  aviso.style.cursor = 'pointer';
  aviso.textContent = 'Existe uma versão mais nova. Clique aqui para atualizar.';
  aviso.addEventListener('click', () => {
    location.replace(location.pathname + '?v=' + encodeURIComponent(publicada));
  });
  document.body.appendChild(aviso);
}

verificarVersaoNova();

/* ---------- toast (compartilhado pelos dois fluxos) ---------- */
let toastTimer;
function toast(txt){
  let t = document.querySelector('.toast');
  if (!t){ t = document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.textContent = txt;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

/* =========================================================================
   Fábrica de fluxo: recebe os elementos de um painel e devolve as ações
   (reset/convert/download) para ligar na delegação de cliques.
   - Se `formatoFixo` for informado, a saída é sempre esse formato.
   - Senão, a saída é decidida pela extensão de entrada (.xlsx -> OFX,
     .ofx/.pdf -> Excel padrão).
   ========================================================================= */
function criarFluxo({ el, formatoFixo }){
  let current = null; // { file, inputExt, transacoes, period, format, outName, blob }

  function show(view){
    Object.keys(el.views).forEach(k => el.views[k].classList.toggle('hidden', k !== view));
    if (el.demoLinks) el.demoLinks.classList.toggle('hidden', view !== 'idle' && view !== 'preview');
  }

  function escolherFormato(inputExt){
    if (formatoFixo) return formatoFixo;
    return inputExt === 'xlsx' ? SAIDA_OFX : SAIDA_EXCEL;
  }

  async function lerTransacoesDoArquivo(file){
    const ext = extensaoDoArquivo(file.name);
    const buffer = await file.arrayBuffer();

    if (ext === 'ofx') return ofxParaTransacoes(decodificarArrayBuffer(buffer));
    if (ext === 'xlsx') return xlsxParaTransacoes(buffer);
    if (ext === 'pdf') return await pdfParaTransacoes(buffer, el.bank ? el.bank.value : 'auto');
    if (ext === 'csv') return csvParaTransacoes(decodificarArrayBuffer(buffer));
    throw new Error(`Formato não reconhecido: '.${ext}'. Envie um arquivo .ofx, .xlsx, .pdf ou .csv.`);
  }

  function formatoDetectadoParaExtensao(ext){
    if (ext === 'ofx') return 'Extrato OFX';
    if (ext === 'xlsx') return ultimoLayoutXlsx || 'Planilha Excel';
    if (ext === 'pdf') return 'PDF – ' + (ultimoBancoDetectado || 'banco não identificado');
    if (ext === 'csv') return 'CSV – ' + (ultimoLayoutCsv || 'formato não identificado');
    return '';
  }

  // O OFX identifica a instituição em <ORG> (nome) e <BANKID> (código COMPE).
  // Tenta pelo nome primeiro — mesma lógica usada no PDF — e recorre ao
  // COMPE quando o nome não vem no arquivo.
  function bancoIdDoOfx(){
    const porNome = detectarBanco(ultimoBancoTextoOfx || '');
    if (porNome !== 'generico') return porNome;
    return detectarBancoPorCompe(ultimoCompeOfx);
  }

  // Qual banco vale para o código do Questor: a escolha manual do seletor
  // tem prioridade; em "Detectar automaticamente", vale o que o leitor
  // identificou. Planilhas .xlsx não trazem o banco em lugar nenhum — nelas
  // a escolha manual é o único caminho (e a prévia avisa isso).
  function bancoIdEfetivo(ext){
    const escolhido = el.bank ? el.bank.value : 'auto';
    if (escolhido && escolhido !== 'auto') return escolhido;
    if (ext === 'pdf') return ultimoBancoIdDetectado;
    if (ext === 'csv') return ultimoBancoIdCsv;
    if (ext === 'ofx') return bancoIdDoOfx();
    return '';
  }

  async function analyzeFile(file){
    const transacoes = await lerTransacoesDoArquivo(file);
    const period = formatarPeriodo(transacoes);
    if (current) {
      current.transacoes = transacoes; // evita reler o arquivo na conversão
      current.period = period;
      current.formatoDetectado = formatoDetectadoParaExtensao(extensaoDoArquivo(file.name));
    }
    return { transactions: transacoes.length, period };
  }

  function atualizarDetalhePreview(){
    if (!current) return;
    const partes = [];
    if (current.formatoDetectado) partes.push('Formato: ' + current.formatoDetectado);
    if (current.period) partes.push('Período: ' + current.period);
    if (current.format.key === 'questor') {
      const bancoId = bancoIdEfetivo(current.inputExt);
      const codigo = codigoBancoQuestor(bancoId);
      if (codigo !== null) {
        partes.push('Código do banco: ' + codigo + ' (em Débito/Crédito)');
      } else if (!bancoId || bancoId === 'generico') {
        partes.push('Banco não identificado: escolha o banco na lista acima para lançar o código');
      } else {
        partes.push((NOMES_BANCO[bancoId] || bancoId) + ' ainda não tem código cadastrado: Valor sai com sinal');
      }
    }
    partes.push('Saída: ' + current.format.rotulo);
    el.pDetail.textContent = partes.join(' · ');
  }

  async function handleFile(file){
    const inputExt = extensaoDoArquivo(file.name);
    const format = escolherFormato(inputExt);
    const base = file.name.replace(/\.[^.]+$/, '');

    current = {
      file, inputExt,
      transacoes: null, period: '',
      format, outName: base + format.sufixo + '.' + format.ext,
      blob: null,
    };

    el.pName.textContent = file.name;
    el.pOut.textContent = format.short;
    el.dOut.textContent = format.short;

    let info;
    try {
      info = await analyzeFile(file);
    } catch (err) {
      return showError(err && err.message);
    }

    el.pTxn.textContent = info.transactions + ' transações';
    atualizarDetalhePreview();
    show('preview');
  }

  /* ---------- seleção de arquivo ---------- */
  el.drop.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value=''; });
  ['dragover','dragenter'].forEach(ev => el.drop.addEventListener(ev, e => { e.preventDefault(); el.drop.classList.add('drag'); }));
  ['dragleave','dragend'].forEach(ev => el.drop.addEventListener(ev, e => { e.preventDefault(); el.drop.classList.remove('drag'); }));
  el.drop.addEventListener('drop', e => { e.preventDefault(); el.drop.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  // Trocar o banco depois de escolher o arquivo muda o resultado: num PDF
  // muda o perfil de leitura (relê o arquivo), e em qualquer formato muda o
  // código lançado em Débito/Crédito no layout do Questor.
  if (el.bank) {
    el.bank.addEventListener('change', () => {
      if (!current) return;
      if (current.inputExt === 'pdf') handleFile(current.file);
      else atualizarDetalhePreview();
    });
  }

  /* ---------- conversão real ---------- */
  async function convertFile(file, onStep){
    onStep(0); // Lendo arquivo

    const transacoes = (current && current.transacoes) || await lerTransacoesDoArquivo(file);
    onStep(1); // Detectando transações

    onStep(2); // Gerando planilha
    let blob;
    if (current.format.key === 'ofx') {
      blob = new Blob([transacoesParaOfxTexto(transacoes)], { type: 'application/x-ofx' });
    } else if (current.format.key === 'questor') {
      const codigo = codigoBancoQuestor(bancoIdEfetivo(current.inputExt));
      blob = new Blob([transacoesParaQuestorXlsxBytes(transacoes, codigo)], { type: MIME_XLSX });
    } else {
      blob = new Blob([transacoesParaXlsxBytes(transacoes)], { type: MIME_XLSX });
    }

    onStep(3); // Finalizando
    return blob;
  }

  function renderSteps(activeIndex){
    el.steps.innerHTML = STEP_NAMES.map((name,i) => {
      const cls = i < activeIndex ? 'done' : (i === activeIndex ? 'active' : '');
      const mark = i < activeIndex
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>'
        : (i+1);
      return '<div class="step '+cls+'"><div class="dot">'+mark+'</div><span class="lbl">'+name+'</span></div>';
    }).join('');
  }

  async function startConvert(){
    show('converting');
    renderSteps(-1);
    el.bar.style.width = '0%';

    const onStep = (i) => { renderSteps(i); el.bar.style.width = Math.round((i/STEP_NAMES.length)*100) + '%'; };

    try {
      current.blob = await convertFile(current.file, onStep);
    } catch (err) {
      return showError(err && err.message);
    }

    renderSteps(STEP_NAMES.length);
    el.bar.style.width = '100%';
    el.dDetail.textContent = current.outName + ' · ' + el.pTxn.textContent;
    el.dOut.textContent = current.format.short;
    setTimeout(() => show('done'), 350);
  }

  /* ---------- download ---------- */
  function download(){
    if (current && current.blob){
      const url = URL.createObjectURL(current.blob);
      const a = document.createElement('a');
      a.href = url; a.download = current.outName; a.click();
      URL.revokeObjectURL(url);
    } else {
      toast('Não foi possível gerar o arquivo.');
    }
  }

  /* ---------- erro ---------- */
  function showError(msg){
    if (msg) el.eMsg.textContent = msg;
    else el.eMsg.textContent = 'Parece um PDF escaneado ou protegido por senha. Tente um PDF gerado pelo próprio banco (com texto selecionável) ou remova a proteção antes de enviar.';
    show('error');
  }

  /* ---------- reset ---------- */
  function reset(){ current = null; show('idle'); }

  show('idle');

  return { reset, convert: startConvert, download };
}

/* =========================================================================
   Instâncias: conversor principal + painel Questor
   ========================================================================= */
const bancoConversor = document.getElementById('bank');
const bancoQuestor = document.getElementById('bank-q');
popularBancos(bancoConversor);
popularBancos(bancoQuestor);

const fluxoConversor = criarFluxo({
  el: {
    file: document.getElementById('file'),
    drop: document.getElementById('drop'),
    bank: bancoConversor,
    views: {
      idle: document.getElementById('v-idle'),
      preview: document.getElementById('v-preview'),
      converting: document.getElementById('v-converting'),
      done: document.getElementById('v-done'),
      error: document.getElementById('v-error'),
    },
    pName: document.getElementById('p-name'),
    pTxn: document.getElementById('p-txn'),
    pDetail: document.getElementById('p-detail'),
    pOut: document.getElementById('p-out'),
    dDetail: document.getElementById('d-detail'),
    dOut: document.getElementById('d-out'),
    eMsg: document.getElementById('e-msg'),
    steps: document.getElementById('steps'),
    bar: document.getElementById('bar-fill'),
    demoLinks: document.getElementById('demo-links'),
  },
});

const fluxoQuestor = criarFluxo({
  el: {
    file: document.getElementById('file-q'),
    drop: document.getElementById('drop-q'),
    bank: bancoQuestor,
    views: {
      idle: document.getElementById('vq-idle'),
      preview: document.getElementById('vq-preview'),
      converting: document.getElementById('vq-converting'),
      done: document.getElementById('vq-done'),
      error: document.getElementById('vq-error'),
    },
    pName: document.getElementById('pq-name'),
    pTxn: document.getElementById('pq-txn'),
    pDetail: document.getElementById('pq-detail'),
    pOut: document.getElementById('pq-out'),
    dDetail: document.getElementById('dq-detail'),
    dOut: document.getElementById('dq-out'),
    eMsg: document.getElementById('eq-msg'),
    steps: document.getElementById('steps-q'),
    bar: document.getElementById('bar-fill-q'),
    demoLinks: null,
  },
  formatoFixo: SAIDA_QUESTOR,
});

/* ---------- modal de exemplo (só do conversor principal) ---------- */
const elExample = document.getElementById('example');

/* ---------- delegação de cliques ---------- */
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.getAttribute('data-action');
  if (act !== 'example') e.preventDefault();
  ({
    reset: fluxoConversor.reset, convert: fluxoConversor.convert, download: fluxoConversor.download,
    'reset-q': fluxoQuestor.reset, 'convert-q': fluxoQuestor.convert, 'download-q': fluxoQuestor.download,
    example: () => elExample.classList.remove('hidden'),
    'close-example': () => elExample.classList.add('hidden'),
  })[act]?.();
});
elExample.addEventListener('click', e => { if (e.target === elExample) elExample.classList.add('hidden'); });
