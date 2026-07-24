/* =========================================================================
   CONVERSOR CESS — controlador da interface
   -------------------------------------------------------------------------
   Ligado à lógica real de conversão (conversor.js / leitor_pdf.js):
     1) analyzeFile(file)  -> ler o arquivo e devolver { transactions, period }
     2) convertFile(file, bank, onStep) -> converter e devolver um Blob
     3) o download usa o Blob retornado por convertFile
   ========================================================================= */

const STEP_NAMES = ['Lendo arquivo', 'Detectando transações', 'Gerando planilha', 'Finalizando'];

const els = {
  file: document.getElementById('file'),
  drop: document.getElementById('drop'),
  bank: document.getElementById('bank'),
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
  example: document.getElementById('example'),
};

for (const banco of BANCOS_SUPORTADOS) {
  const opcao = document.createElement('option');
  opcao.value = banco.id;
  opcao.textContent = banco.nome;
  els.bank.appendChild(opcao);
}

let current = null;   // { file, outFmt, outName, blob, transacoes }

function show(view){
  Object.keys(els.views).forEach(k => els.views[k].classList.toggle('hidden', k !== view));
  els.demoLinks.classList.toggle('hidden', view !== 'idle' && view !== 'preview');
}

function outFormatFor(name){
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ext === 'xlsx' ? 'OFX' : 'XLSX';
}

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

/* ---------- leitura real do arquivo (usada tanto na prévia quanto na conversão) ---------- */
async function lerTransacoesDoArquivo(file){
  const ext = extensaoDoArquivo(file.name);
  const buffer = await file.arrayBuffer();

  if (ext === 'ofx') {
    const texto = decodificarArrayBuffer(buffer);
    return ofxParaTransacoes(texto);
  }
  if (ext === 'xlsx') {
    return xlsxParaTransacoes(buffer);
  }
  if (ext === 'pdf') {
    return await pdfParaTransacoes(buffer, els.bank.value);
  }
  throw new Error(`Formato não reconhecido: '.${ext}'. Envie um arquivo .ofx, .xlsx ou .pdf.`);
}

/* ---------- (1) análise/prévia real do arquivo ---------- */
async function analyzeFile(file){
  const transacoes = await lerTransacoesDoArquivo(file);
  if (current) current.transacoes = transacoes; // evita reler o arquivo na conversão
  return { transactions: transacoes.length, period: formatarPeriodo(transacoes) };
}

/* ---------- seleção de arquivo ---------- */
els.drop.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value=''; });
['dragover','dragenter'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.add('drag'); }));
['dragleave','dragend'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.remove('drag'); }));
els.drop.addEventListener('drop', e => { e.preventDefault(); els.drop.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

async function handleFile(file){
  const outFmt = outFormatFor(file.name);
  const base = file.name.replace(/\.[^.]+$/, '');
  current = { file, outFmt, outName: base + '.' + outFmt.toLowerCase(), blob: null, transacoes: null };

  els.pName.textContent = file.name;
  els.pOut.textContent = outFmt;

  let info;
  try {
    info = await analyzeFile(file);
  } catch (err) {
    return showError(err && err.message);
  }

  els.pTxn.textContent = info.transactions + ' transações';
  els.pDetail.textContent = (info.period ? 'Período: ' + info.period + ' · ' : '') + 'Saída: ' + outFmt;
  show('preview');
}

/* ---------- (2) conversão real ---------- */
async function convertFile(file, bank, onStep){
  onStep(0); // Lendo arquivo

  const transacoes = (current && current.transacoes) || await lerTransacoesDoArquivo(file);
  onStep(1); // Detectando transações

  const ext = extensaoDoArquivo(file.name);
  let blob;

  onStep(2); // Gerando planilha
  if (ext === 'xlsx') {
    const textoOfx = transacoesParaOfxTexto(transacoes);
    blob = new Blob([textoOfx], { type: 'application/x-ofx' });
  } else {
    // .ofx e .pdf sempre geram Excel
    const bytesXlsx = transacoesParaXlsxBytes(transacoes);
    blob = new Blob([bytesXlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  onStep(3); // Finalizando
  return blob;
}

async function startConvert(){
  show('converting');
  renderSteps(-1);
  els.bar.style.width = '0%';

  const onStep = (i) => { renderSteps(i); els.bar.style.width = Math.round((i/STEP_NAMES.length)*100) + '%'; };

  try {
    current.blob = await convertFile(current.file, els.bank.value, onStep);
  } catch (err) {
    return showError(err && err.message);
  }

  renderSteps(STEP_NAMES.length);
  els.bar.style.width = '100%';
  els.dDetail.textContent = current.outName + ' · ' + els.pTxn.textContent;
  els.dOut.textContent = current.outFmt;
  setTimeout(() => show('done'), 350);
}

function renderSteps(activeIndex){
  els.steps.innerHTML = STEP_NAMES.map((name,i) => {
    const cls = i < activeIndex ? 'done' : (i === activeIndex ? 'active' : '');
    const mark = i < activeIndex
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>'
      : (i+1);
    return '<div class="step '+cls+'"><div class="dot">'+mark+'</div><span class="lbl">'+name+'</span></div>';
  }).join('');
}

/* ---------- (3) download — já funciona automaticamente com o Blob de convertFile ---------- */
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
  if (msg) els.eMsg.textContent = msg;
  else els.eMsg.textContent = 'Parece um PDF escaneado ou protegido por senha. Tente um PDF gerado pelo próprio banco (com texto selecionável) ou remova a proteção antes de enviar.';
  show('error');
}

/* ---------- reset ---------- */
function reset(){ current = null; show('idle'); }

/* ---------- toast ---------- */
let toastTimer;
function toast(txt){
  let t = document.querySelector('.toast');
  if (!t){ t = document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.textContent = txt;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

/* ---------- delegação de cliques ---------- */
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.getAttribute('data-action');
  if (act !== 'example') e.preventDefault();
  ({
    reset, convert: startConvert, download,
    example: () => els.example.classList.remove('hidden'),
    'close-example': () => els.example.classList.add('hidden'),
  })[act]?.();
});
els.example.addEventListener('click', e => { if (e.target === els.example) els.example.classList.add('hidden'); });

show('idle');
