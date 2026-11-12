/* =========================================================================
 * Relatório de Situação Especial HCC — processamento 100% no navegador.
 * Fluxo: upload PDF -> render de páginas (pdf.js) -> OCR (tesseract.js)
 *        -> detecção do tipo de documento -> extração de campos
 *        -> formulário editável -> geração do relatório.
 * Nenhum dado é enviado para servidores. As bibliotecas vêm de CDN, mas
 * os PDFs são lidos/convertidos localmente.
 * ========================================================================= */

// --- Configurar worker do pdf.js ---
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// --- Estado da aplicação ---
const state = {
  files: [],        // { file, name, type, pages: [text], fullText, detected }
  data: {},         // campos extraídos/consolidados
};

// --- Atalhos de DOM ---
const $ = (sel) => document.querySelector(sel);
const fileInput = $("#fileInput");
const dropzone = $("#dropzone");
const fileListEl = $("#fileList");
const analyzeBtn = $("#analyzeBtn");
const clearBtn = $("#clearBtn");
const progress = $("#progress");
const progressFill = $("#progressFill");
const progressText = $("#progressText");

/* ---------------------------------------------------------------------------
 * 1) Upload de arquivos
 * ------------------------------------------------------------------------- */
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  addFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener("change", () => addFiles([...fileInput.files]));

function addFiles(files) {
  files
    .filter((f) => f.type === "application/pdf")
    .forEach((f) => {
      if (!state.files.some((x) => x.name === f.name && x.file.size === f.size)) {
        state.files.push({ file: f, name: f.name, type: null, pages: [], fullText: "", detected: "—" });
      }
    });
  renderFileList();
}

function renderFileList() {
  fileListEl.innerHTML = "";
  state.files.forEach((entry, i) => {
    const li = document.createElement("li");
    const detected = entry.detected && entry.detected !== "—";
    li.innerHTML = `
      <span class="fi-name">${escapeHtml(entry.name)}</span>
      <span class="fi-type ${detected ? "detected" : ""}">${escapeHtml(entry.detected)}</span>
      <button class="fi-remove" title="Remover" data-i="${i}">✕</button>`;
    fileListEl.appendChild(li);
  });
  fileListEl.querySelectorAll(".fi-remove").forEach((b) =>
    b.addEventListener("click", () => {
      state.files.splice(Number(b.dataset.i), 1);
      renderFileList();
    })
  );
  const has = state.files.length > 0;
  analyzeBtn.disabled = !has;
  clearBtn.disabled = !has;
}

clearBtn.addEventListener("click", () => {
  state.files = [];
  renderFileList();
});

/* ---------------------------------------------------------------------------
 * 2) Analisar: renderizar páginas + OCR + extração
 * ------------------------------------------------------------------------- */
analyzeBtn.addEventListener("click", runAnalysis);

async function runAnalysis() {
  analyzeBtn.disabled = true;
  clearBtn.disabled = true;
  progress.classList.remove("hidden");

  const worker = await Tesseract.createWorker("por", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        setProgress(m.progress, `Reconhecendo texto… ${Math.round(m.progress * 100)}%`);
      }
    },
  });

  try {
    for (let fi = 0; fi < state.files.length; fi++) {
      const entry = state.files[fi];
      setProgress(0, `Lendo "${entry.name}" (${fi + 1}/${state.files.length})…`);

      const images = await pdfToImages(entry.file, (p) =>
        setProgress(p * 0.3, `Convertendo páginas de "${entry.name}"…`)
      );

      entry.pages = [];
      for (let p = 0; p < images.length; p++) {
        setProgress(0, `OCR "${entry.name}" — página ${p + 1}/${images.length}…`);
        // Tenta extrair texto digital primeiro; se vazio, usa OCR da imagem.
        const { data } = await worker.recognize(images[p]);
        entry.pages.push(data.text || "");
      }
      entry.fullText = entry.pages.join("\n");
      entry.detected = detectDocType(entry.fullText);
      entry.type = entry.detected;
      renderFileList();
    }

    await worker.terminate();
    setProgress(1, "Consolidando dados…");

    state.data = consolidate(state.files);
    fillReviewForm(state.data);
    renderRawOcr(state.files);

    $("#step-review").classList.remove("hidden");
    $("#step-review").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error(err);
    alert("Ocorreu um erro ao processar os documentos: " + err.message);
  } finally {
    progress.classList.add("hidden");
    analyzeBtn.disabled = false;
    clearBtn.disabled = false;
  }
}

function setProgress(ratio, text) {
  progressFill.style.width = Math.round(ratio * 100) + "%";
  if (text) progressText.textContent = text;
}

/** Converte cada página do PDF em uma imagem (dataURL) via canvas. */
async function pdfToImages(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 }); // escala maior = OCR melhor
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push(canvas.toDataURL("image/png"));
    if (onProgress) onProgress(i / pdf.numPages);
  }
  return images;
}

/* ---------------------------------------------------------------------------
 * 3) Detecção do tipo de documento (por palavras-chave)
 * ------------------------------------------------------------------------- */
function detectDocType(text) {
  const t = norm(text);
  if (/situacao especial/.test(t) && /carcinoma hepatocelular|hcc/.test(t)) return "Formulário HCC (destino)";
  if (/central de transplantes|camara tecnica|inclusao situacao especial/.test(t)) return "Carta à Central";
  if (/valor do meld|meld\/na|situacao especial.*sem/.test(t) && /creatinina/.test(t)) return "Tela MELD (receptor)";
  if (/alfa\s*fetoprote/.test(t)) return "Alfa-fetoproteína";
  if (/escala meld|meld-na/.test(t) && /bilirrubina/.test(t)) return "Laudo laboratorial (MELD)";
  if (/quimioembolizacao transarterial|doxorrubicina|lipiodol|radiologia intervencionista/.test(t)) return "Quimioembolização (TACE)";
  // Imagem — TC (tomografia)
  if (/tomografia computadorizada do torax|tc do torax|tc torax/.test(t)) return "TC de tórax";
  if (/tomografia computadorizada|tc (?:de )?abdome/.test(t)) return "TC (abdome/outros)";
  // Imagem — RM/RNM (ressonância)
  if (/ressonancia magnetica|\brm abdome|\brm pelve|\bnm abdome|rnm abdome/.test(t)) return "RM/RNM (ressonância)";
  if (/\bli-?rads\b|\blr tr\b/.test(t) && /segmento|lesoes hepaticas|figado/.test(t)) return "RM/RNM (ressonância)";
  // Imagem — USG (ultrassonografia diagnóstica)
  if (/ultrassonografia|ultrassom|\busg\b|ecografia/.test(t) && !/orientada por ultrassonografia/.test(t)) return "USG (ultrassom)";
  return "Documento não identificado";
}

/* ---------------------------------------------------------------------------
 * 4) Extração de campos por tipo + consolidação
 * ------------------------------------------------------------------------- */
function consolidate(files) {
  const d = {
    paciente: "", dataNasc: "", idade: "", cpf: "", rgct: "",
    equipe: "", hospital: "",
    meldNa: "", meldData: "", creatinina: "", bilirrubina: "", inr: "", sodio: "",
    afp: [], // {data, valor}
    imaging: [], // {tipo, nome, data, impressao, achados:[...]}
    imagemData: "", tcToraxData: "", afpExameData: "", tcToraxResultado: "",
    taceDatas: "", irressecabilidade: "", criterioBarcelona: "",
    rnmAchados: "", indicacao: "",
    medico: "", crm: "", dataRelatorio: "",
  };

  for (const f of files) {
    const t = f.fullText;
    const n = norm(t);

    // Nome do paciente
    takeFirst(d, "paciente", matchName(t));
    // Data de nascimento
    takeFirst(d, "dataNasc", grab(t, /(?:data\s*nasc\.?|dt\.?\s*nasc\.?|dn)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i));
    // Idade
    takeFirst(d, "idade", grab(t, /(\d{2})\s*anos/i));
    // CPF
    takeFirst(d, "cpf", grab(t, /cpf\s*:?\s*([\d.\-]{11,14})/i));
    // RGCT
    takeFirst(d, "rgct", grab(t, /rg\s*ct\s*:?\s*([\d-]+)/i) || grab(t, /rgct\s*:?\s*([\d-]+)/i));
    // Equipe / Hospital
    takeFirst(d, "equipe", grab(t, /equipe\s*:?\s*([A-Za-zÀ-ÿ ]+)/i));
    takeFirst(d, "hospital", grab(t, /hospital\s*:?\s*(s[aã]o\s*paulo[^\n]*)/i) || (/\bhospital s[aã]o paulo\b/i.test(t) ? "HOSPITAL SÃO PAULO" : ""));

    // MELD
    takeFirst(d, "meldNa", grab(t, /meld[-\s]?na[^0-9]*?(\d{1,2})/i) || grab(t, /valor\s*meld\/?na\s*:?\s*(\d{1,2})/i));
    takeFirst(d, "meldData", grab(t, /data\s*do\s*exame\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i));
    takeFirst(d, "creatinina", grab(t, /creatinina[^0-9]*?(\d[.,]\d{1,2})/i));
    takeFirst(d, "bilirrubina", grab(t, /bilirrubina[^0-9]*?(\d[.,]\d{1,2})/i));
    takeFirst(d, "inr", grab(t, /\binr\b[^0-9]*?(\d[.,]\d{1,2})/i));
    takeFirst(d, "sodio", grab(t, /s[oó]dio[^0-9]*?(\d{2,3}[.,]?\d{0,2})/i));

    // Alfa-fetoproteína: valores com data no próprio laudo ou "Resultados Anteriores"
    if (/alfa\s*fetoprote/i.test(n) || /fetoprote/i.test(n)) {
      extractAfp(t).forEach((a) => pushAfp(d, a));
    }
    // Carta final: "Alfa-fetoproteína: 24/05/2024: 13,8 ng/mL; ..."
    extractAfpInline(t).forEach((a) => pushAfp(d, a));

    // Exames de imagem (TC / RM-RNM / USG) — extração dedicada
    const exam = extractImaging(t, f.detected);
    if (exam) d.imaging.push(exam);

    // Carta: "TC tórax (09/06/2025): sem metástase pulmonar."
    const tcLinha = t.match(/tc\s*t[oó]rax\s*\((\d{2}\/\d{2}\/\d{4})\)\s*:?\s*([^\n.]+)/i);
    if (tcLinha) { takeFirst(d, "tcToraxData", tcLinha[1]); takeFirst(d, "tcToraxResultado", tcLinha[2].trim()); }
    // Carta: "RNM Abdome (28/09/24): ..." / "RNM ABDOME (20/05/2025): ..."
    [...t.matchAll(/rnm?\s*abdome?\s*\((\d{2}\/\d{2}\/\d{2,4})\)\s*:?\s*([^\n]+(?:\n(?!\s*[•\-]|\s*tc\s|\s*alfa|\s*meld)[^\n]+)*)/gi)]
      .forEach((m) => d.imaging.push({
        tipo: "RM/RNM (ressonância)", nome: "RNM Abdome", data: expandYear(m[1]),
        impressao: "", achados: [m[2].replace(/\s+/g, " ").trim()], fromLetter: true,
      }));

    // Quimioembolização (TACE) — datas
    if (/quimioembolizacao|tace/i.test(n)) {
      const datas = [...t.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)].map((m) => m[1]);
      const procData = grab(t, /em\s*(\d{2}\/\d{2}\/\d{4})\s*e\s*(\d{2}\/\d{2}\/\d{4})/i);
      const pair = t.match(/em\s*(\d{2}\/\d{2}\/\d{4})\s*e\s*(\d{2}\/\d{2}\/\d{4})/i);
      if (pair) takeFirst(d, "taceDatas", `${pair[1]} e ${pair[2]}`);
    }

    // Irressecabilidade / critério
    const irr = grab(t, /irresse\w*\s*:?\s*(meld\s*>?\s*\d+)/i) || (/meld\s*>\s*10/i.test(t) ? "MELD > 10" : "");
    if (irr) takeFirst(d, "irressecabilidade", irr);

    // Indicação / motivo (carta)
    const motivo = grab(t, /devido\s*([^.\n]+)/i) || grab(t, /ref\.?\s*:?\s*inclus[aã]o[^\n]*-\s*([^\n]+)/i);
    if (motivo) takeFirst(d, "indicacao", motivo.replace(/\s+/g, " ").trim());

    // Médico / CRM
    takeFirst(d, "medico", grab(t, /assinado por\s*:?\s*([A-Za-zÀ-ÿ ]+?)\s*(?:crbm|crm|$)/i)
      || (/adriano miziara gonzalez/i.test(t) ? "Adriano Miziara Gonzalez" : ""));
    takeFirst(d, "crm", grab(t, /crm\s*:?\s*([\d.]+)/i));
  }

  // Normalizações / defaults
  d.equipe = cleanTrailing(d.equipe);
  d.criterioBarcelona = d.criterioBarcelona || "critério radiológico (1 exame de imagem trifásico)";
  d.dataRelatorio = d.dataRelatorio || today();

  // Preencher AFP (datas/valores) nos campos do formulário
  const sortedAfp = dedupeAfp(d.afp).sort((a, b) => parseDate(a.data) - parseDate(b.data));
  d.afp = sortedAfp.slice(0, 3);
  if (!d.afpExameData && d.afp.length) d.afpExameData = d.afp[d.afp.length - 1].data;

  // --- Consolidar exames de imagem ---
  d.imaging = dedupeImaging(d.imaging).sort((a, b) => parseDate(a.data) - parseDate(b.data));

  // TC de tórax: data + impressão (preferir laudo de verdade; senão a carta)
  const tcTorax = d.imaging.filter((e) => /t[oó]rax/i.test(e.nome) || (/tc/i.test(e.tipo || "") && /t[oó]rax/i.test(e.nome || "")));
  const tc = d.imaging.find((e) => /tomografia.*t[oó]rax|tc.*t[oó]rax|t[oó]rax/i.test(e.nome) && !e.fromLetter)
    || d.imaging.find((e) => /t[oó]rax/i.test(e.nome));
  if (tc) {
    takeFirst(d, "tcToraxData", tc.data);
    takeFirst(d, "tcToraxResultado", tc.impressao || (tc.achados && tc.achados[0]) || "");
  }

  // Exame de imagem (estadiamento): data da RM/RNM/USG mais recente
  const rmExams = d.imaging.filter((e) => /ress|rm\/rnm|rnm|\brm\b/i.test(e.tipo || "") || /abdome|pelve|ressonancia|rnm/i.test(e.nome || ""));
  const latestRm = rmExams.length ? rmExams[rmExams.length - 1] : null;
  if (latestRm) takeFirst(d, "imagemData", latestRm.data);

  // Montar o texto de achados da RNM para a carta (usa achados estruturados)
  if (!d.rnmAchados) {
    const lines = [];
    rmExams.forEach((e) => {
      const head = `${e.nome || "RNM Abdome"}${e.data ? " (" + e.data + ")" : ""}:`;
      const body = (e.achados && e.achados.length) ? e.achados.join(" ") : (e.impressao || "");
      if (body) lines.push(`${head} ${body}`);
    });
    d.rnmAchados = lines.join("\n");
  }

  return d;
}

/* --- Extração de um laudo de imagem (TC / RM-RNM / USG) --- */
function extractImaging(t, detected) {
  const n = norm(t);
  const isImaging = /tomografia|ressonancia magnetica|\brm\b|rnm|ultrassonografia|ultrassom|\busg\b/.test(n)
    && !/quimioembolizacao transarterial|radiologia intervencionista|biopsia de linfonodo/.test(n);
  if (!isImaging) return null;

  // Nome do exame: campo "Exame:" ou o título do laudo
  let nome = grab(t, /exame\s*:?\s*([A-Za-zÀ-ÿ .\/]+?)(?:\n|n[uú]mero|data|c[oó]digo)/i);
  if (!nome) {
    nome = grab(t, /\n\s*(tomografia computadorizada[^\n]*|ressonancia magnetica[^\n]*|ultrassonografia[^\n]*)/i);
  }
  nome = (nome || "").replace(/\s+/g, " ").trim();

  // Tipo
  let tipo = "Imagem";
  if (/tomografia|tc\b/i.test(nome) || /tomografia computadorizada/i.test(n)) tipo = "TC (tomografia)";
  if (/ressonancia|\brm\b|rnm/i.test(nome) || /ressonancia magnetica/i.test(n)) tipo = "RM/RNM (ressonância)";
  if (/ultrass|usg|ecografia/i.test(nome)) tipo = "USG (ultrassom)";

  // Data do exame: tenta vários rótulos (Data Exame / Data do Exame / Data do Pedido / Coleta)
  const data =
    grab(t, /data\s*(?:do\s*)?exame\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    grab(t, /data\s*(?:do\s*)?pedido\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    grab(t, /data\s*(?:de\s*)?coleta\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    grab(t, /coleta\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || "";

  // Impressão / Opinião / Impressão diagnóstica
  const impressao =
    grabBlock(t, /impress[aã]o\s*diagn[oó]stica\s*:?/i) ||
    grabBlock(t, /\bopini[aã]o\s*:?/i) ||
    grabBlock(t, /conclus[aã]o\s*:?/i) || "";

  // Achados estruturados (segmentos / LI-RADS) — captura linhas com "Segmento ... LI-RADS"
  const achados = [];
  [...t.matchAll(/segmento\s+[^\n]*?(?:li-?rads|lr\s*tr)[^\n]*/gi)]
    .forEach((m) => achados.push(m[0].replace(/\s+/g, " ").trim()));
  // Se não há segmentos, usa o bloco ANÁLISE como achado principal
  if (!achados.length) {
    const analise = grabBlock(t, /an[aá]lise\s*:?/i) || grabBlock(t, /descri[cç][aã]o\s*:?/i);
    if (analise) achados.push(firstSentences(analise, 2));
  }

  return { tipo, nome: nome || tipo, data, impressao: impressao.replace(/\s+/g, " ").trim(), achados };
}

/** Captura o bloco de texto após um rótulo até o próximo rótulo em MAIÚSCULAS ou dupla quebra. */
function grabBlock(t, labelRe) {
  const m = t.match(labelRe);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = t.slice(start);
  // para no próximo rótulo: título em MAIÚSCULAS com ":" OU rótulos conhecidos de seção
  const stopUpper = rest.search(/\n\s*[A-ZÀ-Ý][A-ZÀ-Ý \-]{3,}\s*:/);
  const stopLabel = rest.search(/\n?\s*(impress[aã]o\s*diagn[oó]stica|an[aá]lise|opini[aã]o|conclus[aã]o|t[eé]cnica|metodologia)\s*:/i);
  const stops = [stopUpper, stopLabel].filter((x) => x > -1);
  const stop = stops.length ? Math.min(...stops) : -1;
  const block = stop > -1 ? rest.slice(0, stop) : rest;
  return block.replace(/\s+/g, " ").trim();
}

function firstSentences(s, n) {
  const parts = s.split(/(?<=[.;])\s+/).slice(0, n);
  return parts.join(" ").trim();
}

function dedupeImaging(arr) {
  const seen = new Map();
  for (const e of arr) {
    const key = (e.tipo || "") + "|" + (e.data || "") + "|" + (e.nome || "").slice(0, 20);
    const existing = seen.get(key);
    // prefere a versão com achados/impressão mais ricos (laudo real) sobre a da carta
    if (!existing || ((e.achados?.join("").length || 0) + (e.impressao?.length || 0)) >
                     ((existing.achados?.join("").length || 0) + (existing.impressao?.length || 0))) {
      seen.set(key, e);
    }
  }
  return [...seen.values()];
}

/* --- Helpers de extração --- */
function matchName(t) {
  const patterns = [
    /paciente\s*:?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/,
    /nome\s*:?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/,
    /sr\s*\(a\)\s*:?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/i,
    /ra\s*:\s*\S+\s*-\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return titleCase(m[1].split("\n")[0].trim());
  }
  return "";
}

function extractAfp(t) {
  const out = [];
  // Resultado atual: "RESULTADO 6.9 ng/mL" + data de coleta
  const result = grab(t, /resultado\s*:?\s*(\d{1,3}[.,]\d)/i);
  const coleta = grab(t, /coleta\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)
    || grab(t, /data\s*(?:de\s*)?cadastro\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (result) out.push({ data: coleta || "", valor: result.replace(".", ",") });
  // "Resultados Anteriores: 16/12/24 (6.7) 04/10/24 (6.2) ... 24/05/24 (13.8)"
  const ant = grab(t, /resultados anteriores\s*:?\s*([^\n]+)/i);
  if (ant) {
    [...ant.matchAll(/(\d{2}\/\d{2}\/\d{2,4})\s*\((\d{1,3}[.,]\d)\)/g)].forEach((m) =>
      out.push({ data: expandYear(m[1]), valor: m[2].replace(".", ",") })
    );
  }
  return out;
}

function extractAfpInline(t) {
  const out = [];
  const block = grab(t, /alfa[-\s]?fetoprote[ií]na\s*:?\s*([^\n]+(?:\n[^\n]+)?)/i);
  if (block) {
    [...block.matchAll(/(\d{2}\/\d{2}\/\d{4})\s*:?\s*(\d{1,3}[.,]\d{1,2})/g)].forEach((m) =>
      out.push({ data: m[1], valor: m[2] })
    );
  }
  return out;
}

function pushAfp(d, a) {
  if (!a.valor) return;
  d.afp.push({ data: a.data || "", valor: a.valor });
}
function dedupeAfp(arr) {
  const seen = new Map();
  for (const a of arr) {
    const key = (a.data || "") + "|" + a.valor;
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()];
}

/* --- Utilidades --- */
function grab(text, re) { const m = text.match(re); return m ? m[1].trim() : ""; }
function takeFirst(obj, key, val) { if (!obj[key] && val) obj[key] = val; }
function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function cleanTrailing(s) { return (s || "").replace(/\s*(hospital|cpf|rgct).*/i, "").trim(); }
function expandYear(dmy) {
  const parts = dmy.split("/");
  if (parts[2] && parts[2].length === 2) parts[2] = "20" + parts[2];
  return parts.join("/");
}
function parseDate(dmy) {
  if (!dmy) return 0;
  const [d, m, y] = expandYear(dmy).split("/").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}
function today() {
  const d = new Date();
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}
function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-zà-ÿ])/g, (c) => c.toUpperCase()).replace(/\b(De|Da|Do|Dos|Das|E)\b/g, (w) => w.toLowerCase());
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------------------------
 * 5) Preencher formulário editável
 * ------------------------------------------------------------------------- */
function fillReviewForm(d) {
  const form = $("#reviewForm");
  const set = (name, val) => {
    const el = form.elements[name];
    if (!el) return;
    el.value = val || "";
    if (!val) el.classList.add("missing"); else el.classList.remove("missing");
    el.addEventListener("input", () => el.classList.remove("missing"));
  };

  set("paciente", d.paciente); set("dataNasc", d.dataNasc); set("idade", d.idade);
  set("cpf", d.cpf); set("rgct", d.rgct); set("equipe", d.equipe); set("hospital", d.hospital);
  set("meldNa", d.meldNa); set("meldData", d.meldData);
  set("creatinina", d.creatinina); set("bilirrubina", d.bilirrubina);
  set("inr", d.inr); set("sodio", d.sodio);

  set("afp1Data", d.afp[0]?.data); set("afp1Valor", d.afp[0]?.valor);
  set("afp2Data", d.afp[1]?.data); set("afp2Valor", d.afp[1]?.valor);
  set("afp3Data", d.afp[2]?.data); set("afp3Valor", d.afp[2]?.valor);

  set("imagemData", d.imagemData); set("tcToraxData", d.tcToraxData);
  set("afpExameData", d.afpExameData); set("tcToraxResultado", d.tcToraxResultado);
  set("taceDatas", d.taceDatas); set("irressecabilidade", d.irressecabilidade);
  set("criterioBarcelona", d.criterioBarcelona);
  set("rnmAchados", d.rnmAchados); set("indicacao", d.indicacao);
  set("medico", d.medico); set("crm", d.crm); set("dataRelatorio", d.dataRelatorio);
}

function renderRawOcr(files) {
  const box = $("#rawOcr");
  box.innerHTML = "";
  files.forEach((f) => {
    const h = document.createElement("h4");
    h.textContent = `${f.name} — ${f.detected}`;
    const pre = document.createElement("pre");
    pre.textContent = f.fullText || "(sem texto)";
    box.appendChild(h);
    box.appendChild(pre);
  });
}

/* ---------------------------------------------------------------------------
 * 6) Navegação entre etapas
 * ------------------------------------------------------------------------- */
$("#backBtn").addEventListener("click", () => {
  $("#step-review").classList.add("hidden");
  $("#step-upload").scrollIntoView({ behavior: "smooth" });
});
$("#editBtn").addEventListener("click", () => {
  $("#step-report").classList.add("hidden");
  $("#step-review").classList.remove("hidden");
  $("#step-review").scrollIntoView({ behavior: "smooth" });
});
$("#printBtn").addEventListener("click", () => window.print());

/* ---------------------------------------------------------------------------
 * 7) Gerar o relatório (formulário HCC + carta)
 * ------------------------------------------------------------------------- */
$("#generateBtn").addEventListener("click", () => {
  const d = readForm();
  $("#reportOutput").innerHTML = buildReportHtml(d);
  $("#step-report").classList.remove("hidden");
  $("#step-report").scrollIntoView({ behavior: "smooth" });
});

function readForm() {
  const form = $("#reviewForm");
  const g = (n) => (form.elements[n]?.value || "").trim();
  return {
    paciente: g("paciente"), dataNasc: g("dataNasc"), idade: g("idade"),
    cpf: g("cpf"), rgct: g("rgct"), equipe: g("equipe"), hospital: g("hospital"),
    meldNa: g("meldNa"), meldData: g("meldData"), creatinina: g("creatinina"),
    bilirrubina: g("bilirrubina"), inr: g("inr"), sodio: g("sodio"),
    afp: [
      { data: g("afp1Data"), valor: g("afp1Valor") },
      { data: g("afp2Data"), valor: g("afp2Valor") },
      { data: g("afp3Data"), valor: g("afp3Valor") },
    ].filter((a) => a.valor),
    imagemData: g("imagemData"), tcToraxData: g("tcToraxData"),
    afpExameData: g("afpExameData"), tcToraxResultado: g("tcToraxResultado"),
    taceDatas: g("taceDatas"), irressecabilidade: g("irressecabilidade"),
    criterioBarcelona: g("criterioBarcelona"), rnmAchados: g("rnmAchados"),
    indicacao: g("indicacao"), medico: g("medico"), crm: g("crm"),
    dataRelatorio: g("dataRelatorio"),
  };
}

function check(on) { return on ? "☒" : "☐"; }
function val(v, fallback = "_______") { return v ? escapeHtml(v) : fallback; }

function buildReportHtml(d) {
  const afpStr = d.afp.map((a) => `${val(a.data, "")}: ${a.valor} ng/mL`).join("; ");
  const meldGt10 = /meld\s*>?\s*1[0-9]|meld\s*>\s*10/i.test(d.irressecabilidade) || Number(d.meldNa) > 10;

  // Marcações dos checkboxes do Diagnóstico (Critério de Barcelona)
  const cb = d.criterioBarcelona || "";
  const cbAnatomo = /anatomopatol/i.test(cb);
  const cbRadio2  = /2\s*exames|radiol[oó]gico\s*\(?\s*2/i.test(cb);
  const cbTrifasico = /trif[aá]sico|1\s*exame\s*(?:de\s*)?imagem/i.test(cb) && !cbRadio2;
  const cbCombinado = /combinado|alfa\s*feto/i.test(cb);
  const yesTrat = !!d.taceDatas;

  // --- Documento 1: formulário oficial (reprodução fiel) ---
  const form = `
  <div class="doc-sheet form-sheet">

    <!-- Cabeçalho oficial -->
    <div class="gov-header">
      <div class="gov-seal">SES</div>
      <div class="gov-title">
        <h3 class="gov">SECRETARIA DE ESTADO DA SAÚDE</h3>
        <p class="gov-line">SISTEMA ESTADUAL DE TRANSPLANTES</p>
        <p class="gov-contact">Home page: http://ctxses.saude.sp.gov.br  /  http://www.saude.sp.gov.br</p>
        <p class="gov-contact">E-mail: ctrans1@saude.sp.gov.br</p>
      </div>
      <div class="gov-versao">VERSÃO 3</div>
    </div>

    <p class="form-title">SITUAÇÃO ESPECIAL HCC<br>CARCINOMA HEPATOCELULAR</p>

    <!-- Identificação -->
    <table class="form ident">
      <tr><td class="lbl">Paciente:</td><td class="fill">${val(d.paciente)}</td></tr>
      <tr><td class="lbl">RGCT:</td><td class="fill">${val(d.rgct)} <span class="note">(n.º do registro na Central de Transplantes)</span></td></tr>
      <tr><td class="lbl">Equipe:</td><td class="fill">${val(d.equipe)}</td></tr>
      <tr><td class="lbl">Hospital:</td><td class="fill">${val(d.hospital)}</td></tr>
    </table>

    <!-- Critérios de inclusão (texto fixo) -->
    <div class="criterios">
      <p><strong>Critério para inclusão em lista de espera:</strong> Paciente portador de carcinoma hepatocelular, como
      complicação da doença hepática crônica, sem metástase, restrito ao fígado com nódulo único de até 5 cm ou até três
      nódulos de 3 cm e a ausência de metástases, com estadiamento obrigatório por mapeamento ósseo e tomografia de tórax.</p>
      <p><strong>Critério para inclusão em situação especial:</strong> Carcinoma hepatocelular maior ou igual a 2cm dentro
      dos critérios de Milão (fígado cirrótico com nódulo único de até 5 cm ou até 3 nódulos de até 3 cm de diâmetro cada,
      ausência de trombose neoplásica do sistema porta), com diagnóstico baseado nos critérios de Barcelona e sem indicação
      de ressecção.</p>
    </div>

    <!-- Diagnóstico (duas colunas) -->
    <table class="form twocol">
      <tr>
        <td class="col-left">
          <h4>Diagnóstico (Critério de Barcelona)</h4>
          <p class="check">${check(cbAnatomo)} critério anatomopatológico</p>
          <p class="check">${check(cbRadio2)} critério radiológico ( 2 exames )</p>
          <p class="check">${check(cbTrifasico)} critério radiológico ( 1 exame de imagem trifásico )</p>
          <p class="check">${check(cbCombinado)} critério combinado ( 1 exame + Alfa fetoproteína )</p>
        </td>
        <td class="col-right">
          Anatomopatológico ou duas (2) imagens coincidentes entre 4 técnicas (ultrassonografia com Doppler ou contraste
          por microbolhas, ressonância, tomografia e arteriografia) que mostre lesão focal ≥ 2 cm com hipervascularização
          arterial ou 1 exame de imagem trifásico (tomografia computadorizada helicoidal multislice, ressonância magnética,
          ultrassonografia com contraste por microbolhas) demonstrando lesão focal ≥ 2cm com padrão hemodinâmico de
          hipervascularização arterial e depuração rápida do contraste nas fases portal ou de equilíbrio (<em>washout</em>)
          ou 1 imagem com tumor hipervascular +AFP &gt; 200 ng/ml. Encaminhar relatório médico e laudo dos exames.
        </td>
      </tr>
    </table>

    <!-- Estadiamento (duas colunas) -->
    <table class="form twocol">
      <tr>
        <td class="col-left">
          <h4>Estadiamento</h4>
          <p class="check stage">${check(!!d.imagemData)} Exame de imagem <span class="data">Data: ${val(d.imagemData, "____/____/____")}</span></p>
          <p class="check stage">${check(!!d.tcToraxData)} Tomografia de tórax <span class="data">Data: ${val(d.tcToraxData, "____/____/____")}</span></p>
          <p class="check stage">${check(!!d.afpExameData)} Exame de alfa-fetoproteína <span class="data">Data: ${val(d.afpExameData, "____/____/____")}</span></p>
        </td>
        <td class="col-right">
          Para fins de estadiamento nódulos com diâmetro inferior a 2 cm são considerados de natureza indeterminada.
          Tumor dentro do critério de Milão: exame de imagem de até 06 meses, tomografia de tórax de até 1 ano e exame de
          alfa-fetoproteína de até 06 meses. Downstaging – exame de imagem de até 04 meses, tomografia de tórax de até 06
          meses e exame de alfa-fetoproteína de até 04 meses.
        </td>
      </tr>
    </table>

    <!-- Tratamento prévio (duas colunas) -->
    <table class="form twocol">
      <tr>
        <td class="col-left">
          <h4>Tratamento prévio: sim ${check(yesTrat)} &nbsp; não ${check(!yesTrat)} &nbsp; se sim:</h4>
          <p class="check">☐ ressecção &nbsp;&nbsp; ☐ quimioterapia &nbsp;&nbsp; ☐ ablação</p>
          <p class="check">${check(yesTrat)} quimioembolização &nbsp;&nbsp; ☐ alcoolização</p>
        </td>
        <td class="col-right">
          Relatório médico explicitando se houve ou não tratamento prévio. Caso tenha tratamento prévio, encaminhar laudo
          do(s) exame(s) prévio ao tratamento.
        </td>
      </tr>
    </table>

    <!-- Irressecabilidade -->
    <div class="irresec">
      <p>☐ Relatório médico com a justificativa da <strong>Irressecabilidade</strong>. Indique pelo menos um dos motivos abaixo:</p>
      <table class="irresec-grid">
        <tr>
          <td class="check">${check(meldGt10)} MELD&gt;10</td>
          <td class="check">☐ Child B ou C</td>
          <td class="check">☐ Na⁺ &lt; 135</td>
        </tr>
        <tr>
          <td class="check">☐ Ressecções de mais de 2 segmentos</td>
          <td class="check" colspan="2">☐ Tumores múltiplos (mais de 1 nódulo em segmentos distintos)</td>
        </tr>
      </table>
    </div>

    <!-- Assinatura -->
    <table class="form sign">
      <tr>
        <td class="lbl">Assinatura e Carimbo do Médico:</td>
        <td class="fill">${val(d.medico, "")}${d.crm ? "<br><span class='note'>CRM " + escapeHtml(d.crm) + "</span>" : ""}</td>
        <td class="lbl data-lbl">Data:</td>
        <td class="fill">${val(d.dataRelatorio)}</td>
      </tr>
    </table>
  </div>`;

  // --- Documento 2: carta à Central ---
  const idade = d.idade ? `, ${escapeHtml(d.idade)} anos` : "";
  const letter = `
  <hr class="page-break">
  <div class="doc-sheet letter">
    <p style="text-align:right">São Paulo, ${val(d.dataRelatorio)}</p>
    <p><strong>À Central de Transplantes — Câmara Técnica</strong></p>
    <p><strong>Ref.:</strong> Inclusão situação especial — CHC${/downstaging/i.test(d.indicacao) ? " Downstaging" : ""}</p>

    <p>Solicito situação especial — <strong>CHC</strong> para o(a) receptor(a)
       <strong>${val(d.paciente)}</strong>${idade}, RGCT: <strong>${val(d.rgct)}</strong>,
       devido <strong>${val(d.indicacao, "cirrose + CHC")}</strong>.</p>

    <ul class="findings">
      ${d.rnmAchados ? d.rnmAchados.split("\n").filter(Boolean).map((l) => `<li>${escapeHtml(l)}</li>`).join("") : "<li>RNM Abdome: _______</li>"}
      <li><strong>TC tórax${d.tcToraxData ? " (" + escapeHtml(d.tcToraxData) + ")" : ""}:</strong> ${val(d.tcToraxResultado, "_______")}.</li>
      <li><strong>Alfa-fetoproteína:</strong> ${afpStr || "_______"}.</li>
      <li><strong>MELD-Na${d.meldData ? " (" + escapeHtml(d.meldData) + ")" : ""}:</strong> ${val(d.meldNa)}.</li>
      ${d.taceDatas ? `<li>Paciente realizou quimioembolização hepática em ${escapeHtml(d.taceDatas)}.</li>` : ""}
      <li><strong>Critério de Irressecabilidade:</strong> ${val(d.irressecabilidade, "MELD > 10")}.</li>
    </ul>

    ${(d.creatinina || d.bilirrubina || d.inr || d.sodio) ? `
    <p style="font-size:.85rem;color:#555">
      Laboratório (base MELD): creatinina ${val(d.creatinina, "—")} mg/dL ·
      bilirrubina ${val(d.bilirrubina, "—")} mg/dL · INR ${val(d.inr, "—")} ·
      sódio ${val(d.sodio, "—")} mEq/L.
    </p>` : ""}

    <p>Atenciosamente,</p>
    <div class="sig">
      <div class="line">${val(d.medico)}${d.crm ? "<br>CRM " + escapeHtml(d.crm) : ""}</div>
    </div>
  </div>`;

  return form + letter;
}
