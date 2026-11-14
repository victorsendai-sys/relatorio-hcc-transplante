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

  let worker = null; // criado sob demanda apenas se alguma página precisar de OCR

  try {
    const totalFiles = state.files.length;
    for (let fi = 0; fi < totalFiles; fi++) {
      const entry = state.files[fi];
      const base = fi / totalFiles;
      setProgress(base, `Lendo "${entry.name}" (${fi + 1}/${totalFiles})…`);

      entry.pages = [];
      entry.pageMeta = []; // { source, confidence, image, width, height, words:[{text,x,y,w,h}] }
      entry.minConfidence = 100;
      entry.usedOcr = false;

      const pdf = await pdfjsLib.getDocument({ data: await entry.file.arrayBuffer() }).promise;

      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);

        // Rasteriza a página para exibição lado a lado (sempre).
        const render = await pageToImage(page);

        // (#9) Primeiro tenta a camada de texto digital — rápido, exato e com posições.
        const digital = await extractDigitalText(page, render.scale);
        if (digital.text && digital.text.replace(/\s/g, "").length > 40) {
          entry.pages.push(digital.text);
          entry.pageMeta.push({
            source: "digital", confidence: 100,
            image: render.image, width: render.width, height: render.height,
            words: digital.words,
          });
        } else {
          // (#8) Só então faz OCR da imagem rasterizada — com caixas de palavras.
          entry.usedOcr = true;
          if (!worker) {
            setProgress(base, "Carregando mecanismo de OCR (uma vez)…");
            worker = await Tesseract.createWorker("por", 1, {
              logger: (m) => {
                if (m.status === "recognizing text") {
                  setProgress(base, `OCR "${entry.name}" — pág. ${p}/${pdf.numPages} · ${Math.round(m.progress * 100)}%`);
                }
              },
            });
          }
          setProgress(base, `OCR "${entry.name}" — página ${p}/${pdf.numPages}…`);
          const { data } = await worker.recognize(render.image, {}, { blocks: true, text: true });
          entry.pages.push(data.text || "");
          const conf = typeof data.confidence === "number" ? data.confidence : 60;
          const words = collectWords(data).map((w) => {
            const b = w.bbox || w;
            return { text: w.text || "", x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
          }).filter((w) => w.text && isFinite(w.x) && isFinite(w.y) && w.w > 0 && w.h > 0);
          entry.pageMeta.push({
            source: "ocr", confidence: conf,
            image: render.image, width: render.width, height: render.height, words,
          });
          entry.minConfidence = Math.min(entry.minConfidence, conf);
        }
      }

      entry.fullText = entry.pages.join("\n");
      entry.detected = detectDocType(entry.fullText);
      entry.type = entry.detected;
      renderFileList();
    }

    if (worker) await worker.terminate();
    setProgress(0.97, "Consolidando dados…");

    state.data = consolidate(state.files);
    runValidations(state.data);           // (#3) validações
    computeFieldConfidence(state.data);    // (#2) confiança por campo
    buildSourceMap(state.data);            // mapeia cada campo -> origem no documento
    fillReviewForm(state.data);
    renderRawOcr(state.files);
    renderVerifier();                      // visão lado a lado (campos x documento)
    saveSession();                         // (#6) persiste automaticamente

    setProgress(1, "Concluído.");
    $("#step-review").classList.remove("hidden");
    $("#step-review").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error(err);
    alert("Ocorreu um erro ao processar os documentos: " + err.message);
    if (worker) { try { await worker.terminate(); } catch (_) {} }
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

/** (#9) Extrai a camada de texto digital de uma página + caixas (em pixels da imagem). */
async function extractDigitalText(page, scale) {
  try {
    const content = await page.getTextContent();
    if (!content.items || !content.items.length) return { text: "", words: [] };
    const vp = page.getViewport({ scale });
    const words = [];
    const lines = new Map();
    for (const item of content.items) {
      const tx = item.transform[4], ty = item.transform[5];
      const y = Math.round(ty);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: tx, s: item.str });
      // Converte a posição PDF (origem inferior-esquerda) para pixels da imagem.
      if (item.str && item.str.trim()) {
        const [px, py] = vp.convertToViewportPoint(tx, ty);
        const w = (item.width || item.str.length * 4) * scale;
        const h = (item.height || 8) * scale;
        words.push({ text: item.str.trim(), x: px, y: py - h, w, h });
      }
    }
    const text = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((o) => o.s).join(" "))
      .join("\n")
      .replace(/[ \t]{2,}/g, " ");
    return { text, words };
  } catch (_) {
    return { text: "", words: [] };
  }
}

/** Coleta as palavras do resultado do Tesseract v5 (de data.words ou dos blocks aninhados). */
function collectWords(data) {
  if (data.words && data.words.length) return data.words;
  const out = [];
  const blocks = data.blocks || [];
  for (const b of blocks) {
    for (const par of (b.paragraphs || [])) {
      for (const line of (par.lines || [])) {
        for (const w of (line.words || [])) out.push(w);
      }
    }
  }
  return out;
}

/** (#8) Rasteriza a página em imagem (limitando a largura) e devolve dimensões e escala. */
async function pageToImage(page) {
  let scale = 2.0;
  let viewport = page.getViewport({ scale });
  const MAX_W = 2000; // (#8) downscale de scans gigantes
  if (viewport.width > MAX_W) {
    scale = (2.0 * MAX_W) / viewport.width;
    viewport = page.getViewport({ scale });
  }
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { image: canvas.toDataURL("image/jpeg", 0.8), width: viewport.width, height: viewport.height, scale };
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

  // Preencher AFP (datas/valores): mantém as 3 MAIS RECENTES, exibidas da mais antiga para a mais nova.
  const sortedAfp = dedupeAfp(d.afp).sort((a, b) => parseDate(a.data) - parseDate(b.data));
  const recent3 = sortedAfp.slice(-3); // 3 últimas por data
  d.afp = recent3;
  if (!d.afpExameData && d.afp.length) d.afpExameData = d.afp[d.afp.length - 1].data; // a mais recente

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
    /paciente\s*:?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/i,
    /nome\s*:?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/i,
    /sr\s*\(a\)\s*:?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/i,
    /ra\s*:\s*\S+\s*-\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´` ]{4,})/i,
  ];
  // Palavras que marcam o início de outro campo — cortamos o nome aí.
  const stopWords = /\b(CPF|RGCT|RG|CT|Data|Dt|DN|Sexo|Idade|C[oó]digo|Matr[ií]cula|N[uú]mero|Dr|Setor|Unidade|Prontu[aá]rio|RHHSP|RA)\b/i;
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      let name = m[1].split("\n")[0];
      const cut = name.search(stopWords);
      if (cut > 3) name = name.slice(0, cut);
      name = name.replace(/\s{2,}.*/, "").trim(); // corta após espaço duplo (colunas)
      if (name.length >= 4) return titleCase(name);
    }
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
 * VALIDAÇÕES (#3) — CPF, MELD recalculado, AFP > 200
 * ------------------------------------------------------------------------- */
function runValidations(d) {
  d.warnings = {};   // { campo: "mensagem" }  (erros/alertas)
  d.notices = {};    // { campo: "mensagem" }  (informativos)

  // CPF — dígitos verificadores
  if (d.cpf) {
    if (!isValidCpf(d.cpf)) d.warnings.cpf = "CPF inválido — verifique se o OCR leu os dígitos corretamente.";
  }

  // MELD-Na recalculado a partir dos laboratoriais e comparado ao extraído
  const meldCalc = computeMeldNa(d.creatinina, d.bilirrubina, d.inr, d.sodio);
  if (meldCalc != null) {
    d.meldCalculado = String(meldCalc);
    if (d.meldNa && Math.abs(Number(d.meldNa) - meldCalc) > 1) {
      d.warnings.meldNa = `MELD-Na extraído (${d.meldNa}) difere do recalculado (${meldCalc}). Confira os laboratoriais.`;
    } else if (!d.meldNa) {
      d.notices.meldNa = `Sugerido pelo cálculo: MELD-Na ≈ ${meldCalc}.`;
    }
  }

  // AFP > 200 ng/mL → suporta "critério combinado (1 exame + AFP)"
  const afpMax = Math.max(0, ...d.afp.map((a) => parseNum(a.valor)));
  if (afpMax > 200) {
    d.notices.criterioBarcelona = `AFP ${afpMax} ng/mL (> 200) reforça o critério combinado (1 exame + alfa-fetoproteína).`;
  }

  // (#1) Janelas de validade dos exames (estadiamento)
  checkExamWindow(d, "imagemData", 6, "Exame de imagem");       // até ~6 meses (Milão) / 4 (downstaging)
  checkExamWindow(d, "tcToraxData", 12, "Tomografia de tórax");  // até 12 meses
  checkExamWindow(d, "afpExameData", 6, "Alfa-fetoproteína");    // até ~6 meses
}

/** (#1) Marca aviso se a data do exame estiver fora da janela (em meses) a partir de hoje. */
function checkExamWindow(d, field, months, label) {
  const dateStr = d[field];
  if (!dateStr) return;
  const t = parseDate(dateStr);
  if (!t) return;
  const ageDays = (Date.now() - t) / 86400000;
  const limitDays = months * 30.4;
  if (ageDays > limitDays) {
    d.warnings[field] = `${label}: exame de ${dateStr} pode estar fora da validade (~${months} meses). Idade: ${Math.round(ageDays / 30.4)} meses.`;
  }
}

/** Validação de CPF (com dígitos verificadores). */
function isValidCpf(cpf) {
  const s = (cpf || "").replace(/\D/g, "");
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(s[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(s[9]) && calc(10) === Number(s[10]);
}

/** MELD-Na (fórmula OPTN). Retorna inteiro 6–40 ou null se faltar dado. */
function computeMeldNa(creat, bili, inr, na) {
  let c = parseNum(creat), b = parseNum(bili), i = parseNum(inr), n = parseNum(na);
  if (!c || !b || !i) return null;
  c = clamp(c, 1.0, 4.0); b = Math.max(b, 1.0); i = Math.max(i, 1.0);
  let meld = 0.957 * Math.log(c) + 0.378 * Math.log(b) + 1.120 * Math.log(i) + 0.643;
  meld = Math.round(meld * 10); // escala e arredonda (×10)
  if (n != null && n > 0) {
    n = clamp(n, 125, 137);
    if (meld > 11) meld = meld + 1.32 * (137 - n) - (0.033 * meld * (137 - n));
  }
  meld = Math.round(meld);
  return clamp(meld, 6, 40);
}

function parseNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/\./g, "").replace(",", "."));
  return isNaN(n) ? Number(String(v).replace(",", ".")) || null : (String(v).includes(",") ? Number(String(v).replace(",", ".")) : n);
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/* ---------------------------------------------------------------------------
 * CONFIANÇA POR CAMPO (#2) — baseada na fonte (digital x OCR) e confiança OCR
 * ------------------------------------------------------------------------- */
function computeFieldConfidence(d) {
  // Confiança agregada do lote: menor confiança entre páginas que precisaram de OCR.
  let minOcr = 100, anyOcr = false;
  for (const f of state.files) {
    if (f.usedOcr) { anyOcr = true; minOcr = Math.min(minOcr, f.minConfidence); }
  }
  d.ocrUsed = anyOcr;
  d.ocrConfidence = anyOcr ? Math.round(minOcr) : 100;
  // Campos considerados "baixa confiança" se vieram de OCR com confiança < 85.
  d.lowConfidence = anyOcr && minOcr < 85;
}

/* ---------------------------------------------------------------------------
 * MAPA DE ORIGEM — liga cada campo ao local no documento (página + caixa)
 * ------------------------------------------------------------------------- */
// Campos do formulário e o(s) valor(es) a localizar no documento.
function sourceTargets(d) {
  const t = [];
  const add = (field, value) => { if (value) t.push({ field, value: String(value) }); };
  add("paciente", d.paciente); add("dataNasc", d.dataNasc); add("idade", d.idade);
  add("cpf", d.cpf); add("rgct", d.rgct); add("equipe", d.equipe); add("hospital", d.hospital);
  add("meldNa", d.meldNa); add("meldData", d.meldData);
  add("creatinina", d.creatinina); add("bilirrubina", d.bilirrubina); add("inr", d.inr); add("sodio", d.sodio);
  if (d.afp[0]) { add("afp1Data", d.afp[0].data); add("afp1Valor", d.afp[0].valor); }
  if (d.afp[1]) { add("afp2Data", d.afp[1].data); add("afp2Valor", d.afp[1].valor); }
  if (d.afp[2]) { add("afp3Data", d.afp[2].data); add("afp3Valor", d.afp[2].valor); }
  add("imagemData", d.imagemData); add("tcToraxData", d.tcToraxData); add("afpExameData", d.afpExameData);
  add("taceDatas", d.taceDatas); add("medico", d.medico); add("crm", d.crm);
  return t;
}

/** Constrói d.sourceMap: { field: { fileIndex, pageIndex, boxes:[{x,y,w,h}], norm } }. */
function buildSourceMap(d) {
  d.sourceMap = {};
  const targets = sourceTargets(d);
  for (const { field, value } of targets) {
    const hit = locateValue(value);
    if (hit) d.sourceMap[field] = hit;
  }
}

/** Procura o valor nas caixas de palavras de todas as páginas; retorna a melhor correspondência. */
function locateValue(value) {
  const want = tokenize(value);
  if (!want.length) return null;
  let best = null;

  for (let fi = 0; fi < state.files.length; fi++) {
    const f = state.files[fi];
    if (!f.pageMeta) continue;
    for (let pi = 0; pi < f.pageMeta.length; pi++) {
      const meta = f.pageMeta[pi];
      const words = meta.words || [];
      if (!words.length) continue;
      const normWords = words.map((w) => ({ ...w, n: normToken(w.text) }));

      // Caso 1: valor com 1 token — acha a palavra que contém/igual.
      if (want.length === 1) {
        const w0 = want[0];
        const idx = normWords.findIndex((w) => w.n === w0 || (w0.length >= 3 && w.n.includes(w0)));
        if (idx >= 0) {
          const cand = { fileIndex: fi, pageIndex: pi, boxes: [box(normWords[idx])], score: w0.length };
          if (!best || cand.score > best.score) best = cand;
        }
        continue;
      }
      // Caso 2: multi-token — procura janela consecutiva que bata a maioria dos tokens.
      for (let s = 0; s < normWords.length; s++) {
        let matched = 0;
        const boxes = [];
        for (let k = 0; k < want.length && s + k < normWords.length; k++) {
          const w = normWords[s + k];
          if (w.n === want[k] || (want[k].length >= 3 && w.n.includes(want[k]))) {
            matched++; boxes.push(box(w));
          } else break;
        }
        if (matched >= Math.ceil(want.length * 0.6) && matched >= 1) {
          const cand = { fileIndex: fi, pageIndex: pi, boxes, score: matched * 10 };
          if (!best || cand.score > best.score) best = cand;
        }
      }
    }
  }
  return best;
}

function box(w) { return { x: w.x, y: w.y, w: w.w, h: w.h }; }
function tokenize(v) { return normToken(v).split(/\s+/).filter((x) => x.length >= 1); }
function normToken(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w/.,-]/g, " ").replace(/\s+/g, " ").trim();
}

/* ---------------------------------------------------------------------------
 * PERSISTÊNCIA LOCAL (#6) — salvar/recarregar sessão no navegador
 * ------------------------------------------------------------------------- */
const STORAGE_KEY = "hcc_report_session_v1";
function saveSession() {
  try {
    const payload = { data: state.data, savedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    updateSessionBadge();
  } catch (_) {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload || !payload.data) return false;
    state.data = payload.data;
    runValidations(state.data);
    fillReviewForm(state.data);
    $("#step-review").classList.remove("hidden");
    $("#step-review").scrollIntoView({ behavior: "smooth" });
    return true;
  } catch (_) { return false; }
}
function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  updateSessionBadge();
}
function updateSessionBadge() {
  const badge = $("#sessionBadge");
  if (!badge) return;
  const has = !!localStorage.getItem(STORAGE_KEY);
  badge.classList.toggle("hidden", !has);
}

/* ---------------------------------------------------------------------------
 * 5) Preencher formulário editável
 * ------------------------------------------------------------------------- */
function fillReviewForm(d) {
  const form = $("#reviewForm");
  const warnings = d.warnings || {};
  const notices = d.notices || {};
  const lowConf = !!d.lowConfidence;

  const set = (name, value) => {
    const el = form.elements[name];
    if (!el) return;
    el.value = value || "";
    el.classList.remove("missing", "warn", "lowconf");
    if (!value) el.classList.add("missing");
    else if (warnings[name]) el.classList.add("warn");
    else if (lowConf) el.classList.add("lowconf");
    attachFieldMessage(el, name, warnings[name], notices[name]);
    el.addEventListener("input", () => {
      el.classList.remove("missing", "warn", "lowconf");
      clearFieldMessage(el);
    });
    // Ao focar/clicar o campo, destaca a origem no documento.
    const onFocus = () => highlightSource(name);
    el.addEventListener("focus", onFocus);
    el.addEventListener("click", onFocus);
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

  renderConfidenceBanner(d);
  renderImagingList(d);
}

/** Mostra mensagem de alerta/nota logo abaixo do campo. */
function attachFieldMessage(el, name, warn, notice) {
  clearFieldMessage(el);
  const msg = warn || notice;
  if (!msg) return;
  const span = document.createElement("span");
  span.className = "field-msg " + (warn ? "field-warn" : "field-notice");
  span.textContent = (warn ? "⚠ " : "ℹ ") + msg;
  const host = el.closest("label") || el.parentElement;
  host.appendChild(span);
}
function clearFieldMessage(el) {
  const host = el.closest("label") || el.parentElement;
  host.querySelectorAll(".field-msg").forEach((n) => n.remove());
}

/** Banner de confiança do OCR no topo do formulário. */
function renderConfidenceBanner(d) {
  const box = $("#confBanner");
  if (!box) return;
  const warnCount = Object.keys(d.warnings || {}).length;
  let html = "";
  if (d.ocrUsed) {
    const cls = d.ocrConfidence >= 85 ? "ok" : "low";
    html += `<div class="conf ${cls}">Confiança do OCR: <strong>${d.ocrConfidence}%</strong>` +
      (d.ocrConfidence < 85 ? " — campos podem conter erros; confira com atenção os destacados." : " — boa qualidade.") +
      `</div>`;
  } else {
    html += `<div class="conf ok">Texto digital lido diretamente do PDF (sem OCR) — alta precisão.</div>`;
  }
  if (d.meldCalculado) html += `<div class="conf info">MELD-Na recalculado pelos laboratoriais: <strong>${d.meldCalculado}</strong>.</div>`;
  if (warnCount) html += `<div class="conf low">${warnCount} ponto(s) de atenção destacado(s) abaixo.</div>`;
  box.innerHTML = html;
}

/** (#14) Lista os exames de imagem detectados com a fonte. */
function renderImagingList(d) {
  const box = $("#imagingList");
  if (!box) return;
  if (!d.imaging || !d.imaging.length) { box.innerHTML = ""; return; }
  box.innerHTML = "<h4>Exames de imagem detectados</h4>" +
    d.imaging.map((e) => {
      const ach = (e.achados || []).map((a) => `<li>${escapeHtml(a)}</li>`).join("");
      return `<div class="img-card">
        <div class="img-head"><strong>${escapeHtml(e.nome || e.tipo)}</strong>
          <span class="tag">${escapeHtml(e.tipo)}</span>
          <span class="img-date">${escapeHtml(e.data || "sem data")}</span></div>
        ${e.impressao ? `<p class="img-impr"><em>Impressão:</em> ${escapeHtml(e.impressao)}</p>` : ""}
        ${ach ? `<ul class="img-ach">${ach}</ul>` : ""}
      </div>`;
    }).join("");
}

/* ---------------------------------------------------------------------------
 * VISÃO LADO A LADO — documento + destaque da origem de cada campo
 * ------------------------------------------------------------------------- */
const verifierState = { fileIndex: 0, pageIndex: 0, showAll: false };

function renderVerifier() {
  const host = $("#verifier");
  if (!host) return;
  const files = state.files.filter((f) => f.pageMeta && f.pageMeta.length);
  if (!files.length) { host.innerHTML = ""; return; }

  // Mapeia índice filtrado -> índice real em state.files
  const realIdx = state.files.map((f, i) => ({ f, i })).filter((x) => x.f.pageMeta?.length).map((x) => x.i);
  if (!realIdx.includes(verifierState.fileIndex)) verifierState.fileIndex = realIdx[0];

  const f = state.files[verifierState.fileIndex];
  if (verifierState.pageIndex >= f.pageMeta.length) verifierState.pageIndex = 0;

  const docOptions = realIdx.map((ri) => {
    const ff = state.files[ri];
    return `<option value="${ri}" ${ri === verifierState.fileIndex ? "selected" : ""}>${escapeHtml(ff.name)} — ${escapeHtml(ff.detected)}</option>`;
  }).join("");

  const pageTabs = f.pageMeta.map((_, pi) =>
    `<button class="pg-tab ${pi === verifierState.pageIndex ? "active" : ""}" data-pi="${pi}">Pág. ${pi + 1}</button>`
  ).join("");

  host.innerHTML = `
    <div class="verifier-head">
      <h4>Verificação — origem dos dados</h4>
      <div class="verifier-ctrls">
        <select id="verDoc" class="ver-doc">${docOptions}</select>
        <label class="ver-toggle"><input type="checkbox" id="verShowAll" ${verifierState.showAll ? "checked" : ""}> Mostrar todos os destaques</label>
      </div>
    </div>
    <p class="ver-hint">Clique em um campo do formulário para destacar onde ele aparece no documento. ${f.pageMeta[verifierState.pageIndex].source === "ocr" ? "Página lida por OCR." : "Página com texto digital."}</p>
    <div class="ver-pagetabs">${pageTabs}</div>
    <div class="ver-stage" id="verStage"></div>
  `;

  $("#verDoc").addEventListener("change", (e) => {
    verifierState.fileIndex = Number(e.target.value);
    verifierState.pageIndex = 0;
    renderVerifier();
  });
  $("#verShowAll").addEventListener("change", (e) => {
    verifierState.showAll = e.target.checked;
    drawStage();
  });
  host.querySelectorAll(".pg-tab").forEach((b) =>
    b.addEventListener("click", () => { verifierState.pageIndex = Number(b.dataset.pi); renderVerifier(); })
  );

  drawStage();
}

function drawStage(focusField) {
  const stage = $("#verStage");
  if (!stage) return;
  const f = state.files[verifierState.fileIndex];
  if (!f || !f.pageMeta || !f.pageMeta[verifierState.pageIndex]) return;
  const meta = f.pageMeta[verifierState.pageIndex];
  const d = state.data || {};
  const map = d.sourceMap || {};

  // Destaques desta página.
  const marks = [];
  for (const [field, loc] of Object.entries(map)) {
    if (loc.fileIndex !== verifierState.fileIndex || loc.pageIndex !== verifierState.pageIndex) continue;
    const show = verifierState.showAll || field === focusField;
    loc.boxes.forEach((b) => marks.push({ field, b, show, focus: field === focusField }));
  }

  const overlays = marks.map((m) =>
    `<div class="ver-mark ${m.show ? "show" : ""} ${m.focus ? "focus" : ""}"
          data-field="${m.field}"
          style="left:${(m.b.x / meta.width) * 100}%;top:${(m.b.y / meta.height) * 100}%;width:${(m.b.w / meta.width) * 100}%;height:${(m.b.h / meta.height) * 100}%;"
          title="${escapeHtml(m.field)}"></div>`
  ).join("");

  stage.innerHTML = `
    <div class="ver-canvas" style="aspect-ratio:${meta.width}/${meta.height}">
      <img src="${meta.image}" alt="Documento" class="ver-img" />
      ${overlays}
    </div>`;

  // Clicar num destaque foca o campo correspondente.
  stage.querySelectorAll(".ver-mark").forEach((el) =>
    el.addEventListener("click", () => {
      const input = document.querySelector(`#reviewForm [name="${el.dataset.field}"]`);
      if (input) { input.focus(); input.scrollIntoView({ behavior: "smooth", block: "center" }); flashField(input); }
    })
  );
}

/** Chamado quando um campo recebe foco: mostra sua origem no documento. */
function highlightSource(field) {
  if (!state.files.some((f) => f.pageMeta && f.pageMeta.length)) return; // sessão restaurada sem imagens
  const d = state.data || {};
  const loc = (d.sourceMap || {})[field];
  if (!loc) { setVerStatus(field, false); return; }
  // Troca para o documento/página corretos e desenha o destaque.
  if (loc.fileIndex !== verifierState.fileIndex || loc.pageIndex !== verifierState.pageIndex) {
    verifierState.fileIndex = loc.fileIndex;
    verifierState.pageIndex = loc.pageIndex;
    renderVerifier();
  }
  drawStage(field);
  setVerStatus(field, true);
  const mark = document.querySelector(`#verStage .ver-mark[data-field="${field}"]`);
  if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setVerStatus(field, found) {
  const el = document.querySelector(`#reviewForm [name="${field}"]`);
  if (!el) return;
  clearFieldMessage(el);
  if (!found && el.value) attachFieldMessage(el, field, null, "origem não localizada no documento — confira manualmente.");
}

function flashField(input) {
  input.classList.add("flash");
  setTimeout(() => input.classList.remove("flash"), 900);
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

/* --- Exportações e sessão (#5, #6, #10) --- */
document.addEventListener("DOMContentLoaded", () => {
  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  bind("#exportCsvBtn", exportCsv);
  bind("#exportDocxBtn", exportDocx);
  bind("#exportCsvBtn2", exportCsv);
  bind("#exportDocxBtn2", exportDocx);
  bind("#clearAllBtn", () => {
    if (confirm("Apagar todos os documentos e dados desta sessão? Esta ação não pode ser desfeita.")) {
      state.files = []; state.data = {};
      clearSession();
      renderFileList();
      $("#reviewForm")?.reset();
      $("#step-review")?.classList.add("hidden");
      $("#step-report")?.classList.add("hidden");
      $("#step-upload")?.scrollIntoView({ behavior: "smooth" });
    }
  });
  bind("#restoreBtn", () => { if (!loadSession()) alert("Nenhuma sessão salva encontrada."); });
  updateSessionBadge();
});

/* ---------------------------------------------------------------------------
 * 7) Gerar o relatório (formulário HCC + carta)
 * ------------------------------------------------------------------------- */
$("#generateBtn").addEventListener("click", () => {
  const d = readForm();
  state.data = d;
  saveSession();
  $("#reportOutput").innerHTML = buildReportHtml(d);
  $("#step-report").classList.remove("hidden");
  $("#step-report").scrollIntoView({ behavior: "smooth" });
});

function readForm() {
  const form = $("#reviewForm");
  const g = (n) => (form.elements[n]?.value || "").trim();
  // Preserva metadados que não estão no formulário (imaging, confiança…).
  const prev = state.data || {};
  const d = {
    ...prev,
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
  return d;
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

  // (#11) Rodapé de auditoria em cada relatório gerado.
  const audit = `
  <div class="audit-footer">
    Documento gerado automaticamente em ${escapeHtml(today())} a partir de laudos digitalizados.
    <strong>Conferir sempre com os laudos originais antes do envio à Central de Transplantes.</strong>
    Ferramenta de apoio — não substitui a avaliação médica.
  </div>`;

  return form + letter + audit;
}

/* ---------------------------------------------------------------------------
 * EXPORTAÇÕES (#5) — CSV (Excel) e Word (.docx)
 * ------------------------------------------------------------------------- */
function downloadBlob(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  const d = readForm();
  const rows = [
    ["Campo", "Valor"],
    ["Paciente", d.paciente], ["Data de nascimento", d.dataNasc], ["Idade", d.idade],
    ["CPF", d.cpf], ["RGCT", d.rgct], ["Equipe", d.equipe], ["Hospital", d.hospital],
    ["MELD-Na", d.meldNa], ["MELD-Na (recalculado)", d.meldCalculado || ""], ["Data MELD", d.meldData],
    ["Creatinina", d.creatinina], ["Bilirrubina", d.bilirrubina], ["INR", d.inr], ["Sódio", d.sodio],
    ["AFP 1", `${d.afp[0]?.data || ""} ${d.afp[0]?.valor || ""}`.trim()],
    ["AFP 2", `${d.afp[1]?.data || ""} ${d.afp[1]?.valor || ""}`.trim()],
    ["AFP 3", `${d.afp[2]?.data || ""} ${d.afp[2]?.valor || ""}`.trim()],
    ["Exame de imagem (data)", d.imagemData], ["TC tórax (data)", d.tcToraxData],
    ["TC tórax (resultado)", d.tcToraxResultado], ["AFP exame (data)", d.afpExameData],
    ["Quimioembolização (datas)", d.taceDatas], ["Irressecabilidade", d.irressecabilidade],
    ["Critério de Barcelona", d.criterioBarcelona], ["Indicação", d.indicacao],
    ["Achados RNM", (d.rnmAchados || "").replace(/\n/g, " | ")],
    ["Médico", d.medico], ["CRM", d.crm], ["Data do relatório", d.dataRelatorio],
  ];
  const csv = "\uFEFF" + rows.map((r) =>
    r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")
  ).join("\r\n");
  const safe = (d.paciente || "paciente").replace(/[^\w]+/g, "_");
  downloadBlob(`relatorio_hcc_${safe}.csv`, "text/csv;charset=utf-8", csv);
}

/** Gera um .docx mínimo (WordprocessingML) sem bibliotecas externas. */
function exportDocx() {
  const d = readForm();
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const P = (text, opts = {}) => {
    const b = opts.bold ? "<w:b/>" : "";
    const sz = opts.size ? `<w:sz w:val="${opts.size}"/>` : "";
    const jc = opts.center ? '<w:jc w:val="center"/>' : "";
    return `<w:p><w:pPr>${jc}</w:pPr><w:r><w:rPr>${b}${sz}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  };
  const afpStr = d.afp.map((a) => `${a.data || ""}: ${a.valor} ng/mL`).join("; ");

  const body =
    P("SECRETARIA DE ESTADO DA SAÚDE — SISTEMA ESTADUAL DE TRANSPLANTES", { bold: true, center: true, size: 24 }) +
    P("SITUAÇÃO ESPECIAL HCC — CARCINOMA HEPATOCELULAR", { bold: true, center: true, size: 22 }) +
    P("") +
    P(`Paciente: ${d.paciente}`, { bold: true }) +
    P(`RGCT: ${d.rgct}    Equipe: ${d.equipe}    Hospital: ${d.hospital}`) +
    P(`Data de nascimento: ${d.dataNasc}    Idade: ${d.idade}    CPF: ${d.cpf}`) +
    P("") +
    P("Diagnóstico (Critério de Barcelona): " + d.criterioBarcelona) +
    P("Estadiamento:", { bold: true }) +
    P(`• Exame de imagem — ${d.imagemData || "—"}`) +
    P(`• Tomografia de tórax — ${d.tcToraxData || "—"} (${d.tcToraxResultado || "—"})`) +
    P(`• Alfa-fetoproteína — ${d.afpExameData || "—"}`) +
    P("") +
    P("Tratamento prévio: " + (d.taceDatas ? "quimioembolização em " + d.taceDatas : "não informado")) +
    P("Irressecabilidade: " + (d.irressecabilidade || "—")) +
    P("") +
    P("Carta à Central de Transplantes", { bold: true }) +
    P(`Solicito situação especial — CHC para o(a) receptor(a) ${d.paciente}, ${d.idade ? d.idade + " anos, " : ""}RGCT: ${d.rgct}, devido ${d.indicacao || "CIRROSE + CHC"}.`) +
    (d.rnmAchados ? d.rnmAchados.split("\n").filter(Boolean).map((l) => P("• " + l)).join("") : "") +
    P(`• TC tórax${d.tcToraxData ? " (" + d.tcToraxData + ")" : ""}: ${d.tcToraxResultado || "—"}.`) +
    P(`• Alfa-fetoproteína: ${afpStr || "—"}.`) +
    P(`• MELD-Na${d.meldData ? " (" + d.meldData + ")" : ""}: ${d.meldNa || "—"}.`) +
    (d.taceDatas ? P(`• Quimioembolização hepática em ${d.taceDatas}.`) : "") +
    P(`• Critério de Irressecabilidade: ${d.irressecabilidade || "MELD > 10"}.`) +
    P("") +
    P("Atenciosamente,") +
    P(`${d.medico || ""}${d.crm ? " — CRM " + d.crm : ""}`) +
    P("") +
    P(`Documento gerado em ${today()} — conferir com os laudos originais.`, { size: 16 });

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

  const files = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
    "word/document.xml": documentXml,
  };

  const zipBlob = buildZip(files);
  const safe = (d.paciente || "paciente").replace(/[^\w]+/g, "_");
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url; a.download = `relatorio_hcc_${safe}.docx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** ZIP sem compressão (stored) + CRC32 — suficiente para um .docx válido. */
function buildZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  for (const name of Object.keys(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(files[name]);
    const crc = crc32(data);
    const local = [].concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0)
    );
    chunks.push(new Uint8Array(local), nameBytes, data);
    const localSize = local.length + nameBytes.length + data.length;
    central.push({ name: nameBytes, crc, size: data.length, offset });
    offset += localSize;
  }

  const cdParts = [];
  let cdSize = 0;
  for (const c of central) {
    const header = [].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset)
    );
    cdParts.push(new Uint8Array(header), c.name);
    cdSize += header.length + c.name.length;
  }
  const end = [].concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(cdSize), u32(offset), u16(0)
  );
  return new Blob([...chunks, ...cdParts, new Uint8Array(end)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
