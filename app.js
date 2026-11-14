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
  files: [],        // { file, name, type, pages: [text], fullText, detected, pageMeta }
  data: {},         // campos extraídos/consolidados
  reports: [],      // (#1) relatórios individuais segmentados
  ocrWorker: null,  // worker reutilizável p/ "Forçar OCR"
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
      entry.pageMeta = []; // metadados por página (ver processPage)
      entry.minConfidence = 100;
      entry.usedOcr = false;

      const pdf = await pdfjsLib.getDocument({ data: await entry.file.arrayBuffer() }).promise;
      entry.numPages = pdf.numPages;

      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const ensureWorker = async () => {
          if (!worker) {
            setProgress(base, "Carregando mecanismo de OCR (uma vez)…");
            worker = await Tesseract.createWorker("por", 1, {
              logger: (m) => {
                if (m.status === "recognizing text")
                  setProgress(base, `OCR "${entry.name}" — pág. ${p}/${pdf.numPages} · ${Math.round(m.progress * 100)}%`);
              },
            });
          }
          return worker;
        };
        const meta = await processPage(page, p, pdf.numPages, entry, base, ensureWorker, false);
        entry.pages.push(meta.text);
        entry.pageMeta.push(meta);
        if (meta.source === "ocr") { entry.usedOcr = true; entry.minConfidence = Math.min(entry.minConfidence, meta.confidence); }
      }

      entry.fullText = entry.pages.join("\n");
      entry.detected = detectDocType(entry.fullText);
      entry.type = entry.detected;
      renderFileList();
    }

    if (worker) await worker.terminate();
    state.ocrWorker = null;
    setProgress(0.97, "Separando relatórios e consolidando dados…");

    // (#1) Segmenta cada PDF em relatórios individuais.
    state.reports = segmentReports(state.files);

    state.data = consolidate(state.files, state.reports);
    runValidations(state.data);           // (#3) validações
    computeFieldConfidence(state.data);    // (#2) confiança por campo
    buildSourceMap(state.data);            // mapeia cada campo -> origem no documento
    fillReviewForm(state.data);
    renderReportsSummary(state.reports);   // (#1) resumo dos relatórios detectados
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

/**
 * Processa uma página: decide digital x OCR (por cobertura de texto), rasteriza
 * imagem leve p/ exibição e extrai identificadores (p/ segmentação em relatórios).
 * forceOcr=true ignora a heurística e sempre faz OCR (#5 botão "Forçar OCR").
 */
async function processPage(page, pageNo, totalPages, entry, base, ensureWorker, forceOcr, highRes) {
  // Imagem leve (JPEG) para a UI/verificador — mantém tudo responsivo (#B).
  const display = await renderDisplay(page);

  // Avalia a camada de texto digital e sua COBERTURA na página (#5 + #D).
  const digital = await extractDigitalText(page, display.scale);
  const useDigital = !forceOcr && digital.coverage.ok;

  if (useDigital) {
    return {
      source: "digital", confidence: 100,
      image: display.image, width: display.width, height: display.height,
      words: digital.words, text: digital.text,
      coverage: digital.coverage, canForceOcr: true, ocrHighRes: false,
      ...pageIdentifiers(digital.text),
    };
  }

  // (#A/#B) Por padrão, OCR RÁPIDO (~220 dpi, JPEG). Alta resolução só sob demanda.
  const w = await ensureWorker();
  const q = highRes ? "alta resolução" : "rápido";
  setProgress(base, `OCR (${q}) "${entry.name}" — página ${pageNo}/${totalPages}…`);
  const ocrImg = highRes ? await renderForOcr(page) : await renderForOcrFast(page);
  const { data } = await w.recognize(ocrImg.image, {}, { blocks: true, text: true });
  const conf = typeof data.confidence === "number" ? data.confidence : 60;
  // Converte caixas da escala de OCR para a escala de exibição.
  const k = display.scale / ocrImg.scale;
  const words = collectWords(data).map((wd) => {
    const b = wd.bbox || wd;
    return { text: wd.text || "", x: b.x0 * k, y: b.y0 * k, w: (b.x1 - b.x0) * k, h: (b.y1 - b.y0) * k };
  }).filter((wd) => wd.text && isFinite(wd.x) && isFinite(wd.y) && wd.w > 0 && wd.h > 0);
  const text = data.text || "";
  return {
    source: "ocr", confidence: conf,
    image: display.image, width: display.width, height: display.height,
    // canForceOcr: permite reprocessar em alta resolução enquanto ainda não foi feito.
    words, text, coverage: digital.coverage, canForceOcr: !highRes, ocrHighRes: !!highRes,
    ...pageIdentifiers(text),
  };
}

/** (#9) Extrai texto digital + caixas + COBERTURA (área e dispersão vertical). */
async function extractDigitalText(page, scale) {
  try {
    const content = await page.getTextContent();
    const vp = page.getViewport({ scale });
    const pageArea = vp.width * vp.height || 1;
    if (!content.items || !content.items.length) {
      return { text: "", words: [], coverage: { ok: false, ratio: 0, spread: 0, chars: 0 } };
    }
    const words = [];
    const lines = new Map();
    let textArea = 0, minY = Infinity, maxY = -Infinity, chars = 0;
    for (const item of content.items) {
      const tx = item.transform[4], ty = item.transform[5];
      const y = Math.round(ty);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: tx, s: item.str });
      if (item.str && item.str.trim()) {
        const [px, py] = vp.convertToViewportPoint(tx, ty);
        const ww = (item.width || item.str.length * 4) * scale;
        const hh = (item.height || 8) * scale;
        words.push({ text: item.str.trim(), x: px, y: py - hh, w: ww, h: hh });
        textArea += ww * hh; chars += item.str.trim().length;
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
    const text = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((o) => o.s).join(" "))
      .join("\n")
      .replace(/[ \t]{2,}/g, " ");

    // (#5/#D) Cobertura: fração da área coberta por texto E dispersão vertical.
    const ratio = textArea / pageArea;
    const spread = isFinite(minY) ? (maxY - minY) / vp.height : 0;
    // Página claramente digital (muito texto bem distribuído) -> pula OCR (mais rápido).
    // Página com pouco texto OU só no topo (cabeçalho de scan) -> vai para OCR.
    const clearlyDigital = chars > 400 && spread > 0.45;       // laudo/carta digitais
    const ok = clearlyDigital || (chars > 150 && ratio > 0.015 && spread > 0.40);
    return { text, words, coverage: { ok, ratio: +ratio.toFixed(4), spread: +spread.toFixed(2), chars } };
  } catch (_) {
    return { text: "", words: [], coverage: { ok: false, ratio: 0, spread: 0, chars: 0 } };
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

/** Imagem leve (JPEG) para exibição no verificador — mantém a UI responsiva (#B). */
async function renderDisplay(page) {
  let scale = 1.5;
  let viewport = page.getViewport({ scale });
  const MAX_W = 1400;
  if (viewport.width > MAX_W) { scale = (1.5 * MAX_W) / viewport.width; viewport = page.getViewport({ scale }); }
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { image: canvas.toDataURL("image/jpeg", 0.82), width: viewport.width, height: viewport.height, scale };
}

/** (#6) Imagem de alta qualidade (PNG, ~300 dpi) só para o OCR — melhor precisão. */
async function renderForOcr(page) {
  // PDFs usam 72 dpi como base; escala p/ ~300 dpi ≈ 4.17.
  let scale = 300 / 72;
  let viewport = page.getViewport({ scale });
  const MAX_W = 3200; // teto p/ não estourar memória em scans enormes
  if (viewport.width > MAX_W) { scale = scale * (MAX_W / viewport.width); viewport = page.getViewport({ scale }); }
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { image: canvas.toDataURL("image/png"), width: viewport.width, height: viewport.height, scale };
}

/** (#A) OCR RÁPIDO: ~220 dpi em JPEG — bem mais rápido, boa precisão para o 1º passe. */
async function renderForOcrFast(page) {
  let scale = 220 / 72; // ≈ 3.06
  let viewport = page.getViewport({ scale });
  const MAX_W = 2400;
  if (viewport.width > MAX_W) { scale = scale * (MAX_W / viewport.width); viewport = page.getViewport({ scale }); }
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { image: canvas.toDataURL("image/jpeg", 0.85), width: viewport.width, height: viewport.height, scale };
}

/* ---------------------------------------------------------------------------
 * (#4) Reconhecimento de nomes/abreviações de exame — usado na classificação
 *      e na extração (regras consistentes).
 * ------------------------------------------------------------------------- */
// Retorna {tipo, titulo} ou null. Aceita TC, RM, RNM, US/USG com variações.
function recognizeExam(rawText) {
  const t = norm(rawText);
  // Título do exame: prioriza a linha de título do laudo (tomografia/ressonância/US),
  // depois o campo "Exame:" (com fronteira de palavra p/ não casar "Data Exame").
  let titleLine =
    grab(rawText, /\n\s*(tomografia\s+computadorizada[^\n]*|resson[aâ]ncia\s+magn[eé]tica[^\n]*|ultrassonografia[^\n]*|ultrassom[^\n]*)/i) ||
    grab(rawText, /(?:^|\n)\s*exame\s*:\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .\/()\-]{3,}?)(?:\n|n[uú]mero|c[oó]digo|sexo|data)/i) || "";
  // Nunca aceita uma data como título.
  if (/^\s*\d{2}\/\d{2}\/\d{2,4}\s*$/.test(titleLine)) titleLine = "";
  const titulo = (titleLine || "").replace(/\s+/g, " ").trim();
  const hay = norm(titulo) + " " + t;

  // Tomografia computadorizada (TC)
  if (/\btomografia\b|\btc\b(?![a-z])|tomografia computadorizada/.test(hay)) {
    const torax = /t[oó]rax/.test(hay);
    return { tipo: "TC (tomografia)", titulo: titulo || (torax ? "Tomografia computadorizada do tórax" : "Tomografia computadorizada"), torax };
  }
  // Ressonância magnética (RM / RNM / RM abdome / RM pelve)
  if (/\bresson[aâ]ncia\b|resson[aâ]ncia magnetica|\brm\b|\brnm\b|\brm\s*abdome|\brm\s*pelve/.test(hay)) {
    return { tipo: "RM/RNM (ressonância)", titulo: titulo || "Ressonância magnética" };
  }
  // Ultrassonografia (US / USG) — mas NÃO procedimento "orientado por ultrassonografia".
  if ((/\bultrassonografia\b|\bultrassom\b|\bus\b|\busg\b|ecografia/.test(hay)) && !/orientad[ao] por ultrassonografia|biopsia/.test(hay)) {
    return { tipo: "USG (ultrassom)", titulo: titulo || "Ultrassonografia" };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * (#1) Identificadores por página + segmentação em relatórios
 * ------------------------------------------------------------------------- */
// Extrai identificadores de EXAME (não do paciente) e um "header" do laudo.
function pageIdentifiers(text) {
  const t = text || "";
  // Número do pedido = identificador do EXAME.
  const orderNo =
    grab(t, /n[uú]mero\s*(?:do\s*)?pedido\s*:?\s*(\d{4,})/i) ||
    grab(t, /n[uú]mero\s*do\s*pedido\s*:?\s*(\d{4,})/i) || "";
  // "Código Externo": usar APENAS quando identifica o exame (rótulo do pedido),
  // e NÃO quando é código do paciente.
  let externo = grab(t, /c[oó]digo\s*externo\s*:?\s*(\d{4,})/i) || "";
  // Se houver "Código do Paciente" com o mesmo número, não é identificador de exame.
  const patientCode = grab(t, /c[oó]digo\s*(?:do\s*)?paciente\s*:?\s*(\d{3,})/i) || "";
  if (externo && externo === patientCode) externo = "";

  const exam = recognizeExam(t);
  const examTitle = exam ? exam.titulo : "";
  const examDate =
    grab(t, /data\s*(?:do\s*)?exame\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    grab(t, /data\s*(?:do\s*)?pedido\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || "";
  // "Header" institucional (primeiras linhas significativas) — não define sozinho um relatório.
  const header = norm((t.split("\n").find((l) => /hospital|laborat[oó]rio|associa[cç][aã]o|departamento|unifesp|secretaria/i.test(l)) || "").slice(0, 60));

  const hasExamIds = !!(orderNo || externo || examTitle || examDate);
  return {
    ids: { orderNo, externo, examTitle: norm(examTitle), examDate, header, examType: exam ? exam.tipo : "" },
    hasExamIds,
  };
}

/**
 * Agrupa as páginas de todos os PDFs em relatórios individuais.
 * Regras: número do pedido novo => novo relatório; sem pedido, usa (header+título+data);
 * cabeçalho repetido sozinho NÃO inicia relatório; páginas sem ids de exame são
 * continuação do relatório anterior; fronteiras ambíguas ficam marcadas p/ revisão.
 */
function segmentReports(files) {
  const reports = [];
  let current = null;

  const sameOrder = (a, b) => a.orderNo && b.orderNo && a.orderNo === b.orderNo;
  const sameExamTriplet = (a, b) =>
    a.examTitle && b.examTitle && a.examTitle === b.examTitle &&
    (!a.examDate || !b.examDate || a.examDate === b.examDate);

  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    (f.pageMeta || []).forEach((meta, pi) => {
      const ids = meta.ids || {};
      const ref = { fileIndex: fi, pageIndex: pi, fileName: f.name };

      if (!current) { current = startReport(ids, ref, meta); reports.push(current); return; }

      // Página sem identificadores de exame -> continuação do relatório atual.
      if (!meta.hasExamIds) { attachPage(current, ref, meta); return; }

      // Mesmo número de pedido -> mesma (continuação do) relatório.
      if (current.ids.orderNo && ids.orderNo && sameOrder(current.ids, ids)) { attachPage(current, ref, meta); return; }

      // Página com pedido que casa com um relatório anterior (ex.: assinatura) -> anexa lá.
      if (ids.orderNo) {
        const match = reports.find((r) => r.ids.orderNo === ids.orderNo);
        if (match) { attachPage(match, ref, meta); return; }
        // Pedido novo -> novo relatório.
        current = startReport(ids, ref, meta); reports.push(current); return;
      }

      // Sem número de pedido: decide por (título + data) de exame.
      if (sameExamTriplet(current.ids, ids)) { attachPage(current, ref, meta); return; }

      // Título/data de exame diferentes -> novo relatório.
      if (ids.examTitle || ids.examDate) { current = startReport(ids, ref, meta); reports.push(current); return; }

      // Caso indefinido -> anexa ao atual e marca ambíguo.
      attachPage(current, ref, meta); current.ambiguous = true;
    });
  }

  // Pós-processo: título/tipo final e texto consolidado por relatório.
  reports.forEach((r, i) => {
    r.index = i;
    r.text = r.pages.map((p) => p.meta.text).join("\n");
    if (!r.ids.examType) {
      const ex = recognizeExam(r.text);
      if (ex) { r.ids.examType = ex.tipo; if (!r.ids.examTitle) r.ids.examTitle = norm(ex.titulo); }
    }
    r.label = reportLabel(r);
  });
  return reports;
}

function startReport(ids, ref, meta) {
  return { ids: { ...ids }, pages: [{ ...ref, meta }], ambiguous: false };
}
function attachPage(report, ref, meta) {
  report.pages.push({ ...ref, meta });
  // Completa identificadores ausentes a partir da continuação (ex.: data só no corpo).
  const ids = meta.ids || {};
  for (const k of ["orderNo", "externo", "examTitle", "examDate", "examType"]) {
    if (!report.ids[k] && ids[k]) report.ids[k] = ids[k];
  }
}
function reportLabel(r) {
  const title = r.ids.examTitle ? titleCase(r.ids.examTitle) : (r.ids.examType || "Documento");
  const date = r.ids.examDate ? ` — ${r.ids.examDate}` : "";
  const ord = r.ids.orderNo ? ` · pedido ${r.ids.orderNo}` : "";
  const pgs = r.pages.map((p) => `${p.fileName}:${p.pageIndex + 1}`).join(", ");
  return { title: title + date + ord, pages: pgs };
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
function consolidate(files, reports) {
  const d = {
    paciente: "", dataNasc: "", idade: "", cpf: "", rgct: "",
    equipe: "", hospital: "",
    meld: "", meldNa: "", meldData: "", meldScreenDate: "", meldValidade: "",
    creatinina: "", bilirrubina: "", inr: "", sodio: "",
    meldHistory: [],   // [{date, creat, bili, inr, meld, meldNa, validade}]
    meldCandidates: [], // (date, value) de MELD-Na considerados na seleção
    afp: [], // {data, valor}
    imaging: [], // {tipo, nome, data, impressao, achados:[...]}
    imagemData: "", tcToraxData: "", afpExameData: "", tcToraxResultado: "",
    taceDatas: "", irressecabilidade: "", criterioBarcelona: "",
    rnmAchados: "", indicacao: "",
    medico: "", crm: "", dataRelatorio: "",
    fieldSources: {}, // { campo: {fileIndex, pageIndex, bbox, confidence} }
  };

  for (const f of files) {
    const t = f.fullText || (f.pages ? f.pages.join("\n") : "");
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

    // MELD — a extração robusta (tela MELD) acontece abaixo, por página, com caixas.
    // Aqui tratamos apenas o LAUDO LABORATORIAL (texto corrido), de forma restrita.
    const isMeldScreen = /tela meld|valor do meld|data de validade do exame|comprov\. de inscri/.test(n);
    if (!isMeldScreen) {
      // Laudo laboratorial: valores rotulados, "sem diálise" por padrão (Q2=b).
      const labMeldNa = grab(t, /meld[-\s]?na\s*\(?\s*sem\s*di[aá]lise\)?[^0-9]*?(\d{1,2})\b/i)
        || grab(t, /meld[-\s]?na[^0-9]*?(\d{1,2})\b/i);
      if (labMeldNa) collectMeldCandidate(d, labMeldNa,
        grab(t, /coleta\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || grab(t, /data\s*(?:de\s*)?entrada\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i), f, null);
      takeFirst(d, "creatinina", grab(t, /creatinina[^0-9]*?(\d[.,]\d{1,2})/i));
      takeFirst(d, "bilirrubina", grab(t, /bilirrubina[^0-9]*?(\d[.,]\d{1,2})/i));
      takeFirst(d, "inr", grab(t, /\binr\b[^0-9]*?(\d[.,]\d{1,2})/i));
      takeFirst(d, "sodio", grab(t, /s[oó]dio[^0-9]*?(\d{2,3}[.,]?\d{0,2})/i));
    }

    // Alfa-fetoproteína: valores com data no próprio laudo ou "Resultados Anteriores"
    if (/alfa\s*fetoprote/i.test(n) || /fetoprote/i.test(n)) {
      extractAfp(t).forEach((a) => pushAfp(d, a));
    }
    // Carta final: "Alfa-fetoproteína: 24/05/2024: 13,8 ng/mL; ..."
    extractAfpInline(t).forEach((a) => pushAfp(d, a));

    // (Exames de imagem são extraídos POR RELATÓRIO, após este laço — ver abaixo.)

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

  // (#1) Exames de imagem extraídos POR RELATÓRIO — a data de um exame nunca
  // se mistura com os achados de outro.
  if (reports && reports.length) {
    for (const r of reports) {
      const exam = extractImaging(r.text, r.ids.examType, r.ids);
      if (exam) {
        exam.reportIndex = r.index;
        exam.pages = r.pages.map((p) => `${p.fileName}:${p.pageIndex + 1}`).join(", ");
        exam.ambiguous = !!r.ambiguous;
        d.imaging.push(exam);
      }
    }
  }

  // (#3) Extração dedicada da TELA MELD por página (usando caixas de palavras).
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    (f.pageMeta || []).forEach((meta, pi) => {
      if (!/tela meld|valor do meld|data de validade do exame|comprov\. de inscri/.test(norm(meta.text || ""))) return;
      extractMeldScreen(d, meta, fi, pi);
    });
  }

  // Regra de seleção do MELD-Na (Q1=a janela vs. hoje; Q2=b sem diálise; Q3=a fallback).
  selectMeldNa(d);

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

  // Montar o texto de achados da RNM para a carta — preserva achados COMPLETOS (#2).
  if (!d.rnmAchados) {
    const lines = [];
    rmExams.forEach((e) => {
      const head = `${e.nome || "RNM Abdome"}${e.data ? " (" + e.data + ")" : ""}:`;
      // Prioriza bullets de segmento/LI-RADS; adiciona o restante da análise completa
      // e a conclusão/impressão — sem truncar.
      const parts = [];
      if (e.achados && e.achados.length) parts.push(e.achados.join(" "));
      if (e.analiseCompleta && !(e.achados && e.achados.length)) parts.push(e.analiseCompleta);
      if (e.impressao) parts.push("Conclusão: " + e.impressao);
      const body = parts.join(" ").trim();
      if (body) lines.push(`${head} ${body}`);
    });
    d.rnmAchados = lines.join("\n");
  }

  return d;
}

/* --- Extração de um laudo de imagem (TC / RM-RNM / USG) --- */
function extractImaging(t, examType, ids) {
  // (#4) Reconhecimento consistente do exame (TC/RM/RNM/US-USG).
  const exam = recognizeExam(t);
  // (#3) NÃO descartar laudo de imagem por mencionar quimioembolização prévia.
  // Só excluímos quando o DOCUMENTO É o procedimento em si (não um laudo de imagem).
  const isProcedure = /quimioembolizacao transarterial|radiologia intervencionista|biopsia de linfonodo orientada/i.test(norm(t));
  if (!exam && isProcedure) return null;         // é o laudo do procedimento, não imagem
  if (!exam) return null;                          // sem título de exame reconhecível

  const tipo = exam.tipo;
  // Nome: campo "Exame:" ou o título reconhecido.
  let nome = ids && ids.examTitle ? ids.examTitle : "";
  if (!nome) nome = grab(t, /exame\s*:?\s*([A-Za-zÀ-ÿ0-9 .\/()\-]+?)(?:\n|n[uú]mero|data|c[oó]digo|sexo)/i);
  if (!nome) nome = exam.titulo;
  nome = titleOrRaw((nome || "").replace(/\s+/g, " ").trim());

  // Data do exame (vários rótulos).
  const data = (ids && ids.examDate) ||
    grab(t, /data\s*(?:do\s*)?exame\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    grab(t, /data\s*(?:do\s*)?pedido\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    grab(t, /data\s*(?:de\s*)?coleta\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    grab(t, /coleta\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || "";

  // (#2) Conclusão / impressão — bloco COMPLETO (multi-linha).
  const impressao =
    grabBlock(t, /impress[aã]o\s*diagn[oó]stica\s*:?/i) ||
    grabBlock(t, /\bopini[aã]o\s*:?/i) ||
    grabBlock(t, /conclus[aã]o\s*:?/i) || "";

  // (#2) Achados COMPLETOS: todo o bloco ANÁLISE/DESCRIÇÃO (multi-linha), mais os
  // itens de segmento/LI-RADS destacados como bullets — sem truncar em 2 frases.
  const analiseBloco =
    grabBlock(t, /an[aá]lise\s*:?/i) ||
    grabBlock(t, /descri[cç][aã]o\s*:?/i) ||
    grabBlock(t, /achados\s*:?/i) || "";

  const achados = [];
  // Segmentos/LI-RADS podem ocupar mais de uma linha: captura "Segmento ... (LI-RADS n)."
  const segRe = /segmento\s+[\s\S]*?(?:li-?rads|lr\s*tr|lirads)[^.\n]*\.?/gi;
  const segMatches = (analiseBloco + "\n" + t).match(segRe) || [];
  const segSeen = new Set();
  segMatches.forEach((s) => {
    const clean = s.replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (!segSeen.has(key)) { segSeen.add(key); achados.push(clean); }
  });

  // Além dos segmentos, preserva o texto integral da análise (sem truncar),
  // removendo ruído de assinatura/rodapé que possa vir de página de continuação.
  const analiseFull = stripSignatureNoise(analiseBloco).replace(/\s+/g, " ").trim();

  return {
    tipo, nome: nome || tipo, data,
    impressao: impressao.replace(/\s+/g, " ").trim(),
    achados,                       // bullets de segmento/LI-RADS (se houver)
    analiseCompleta: analiseFull,  // (#2) bloco completo preservado
  };
}

/** Captura o bloco após um rótulo até o próximo rótulo de seção conhecido ou título MAIÚSCULO. */
function grabBlock(t, labelRe) {
  const m = t.match(labelRe);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = t.slice(start);
  const stopUpper = rest.search(/\n\s*[A-ZÀ-Ý][A-ZÀ-Ý \-]{4,}\s*:?\s*\n/);
  const stopLabel = rest.search(/\n?\s*(impress[aã]o\s*diagn[oó]stica|an[aá]lise|opini[aã]o|conclus[aã]o|t[eé]cnica|metodologia|respons[aá]veis|assinad|liberado|data da impress)\s*:?/i);
  const stops = [stopUpper, stopLabel].filter((x) => x > -1);
  const stop = stops.length ? Math.min(...stops) : -1;
  const block = stop > 0 ? rest.slice(0, stop) : rest;
  return block.replace(/\s+/g, " ").trim();
}

/** Remove ruído de assinatura/rodapé/ID que vem de páginas de continuação. */
function stripSignatureNoise(s) {
  if (!s) return s;
  const cut = s.search(/\b(patient id|acc#|report date|liberado eletronicamente|assinado por|dra?\.?\s+[a-zç]+\s+[a-zç]+\s+crm|crm\/?sp?\s*\d|responsa[vb]el|data da impress|impresso em)\b/i);
  return cut > 0 ? s.slice(0, cut).trim() : s;
}

/** Mantém títulos reconhecíveis legíveis sem destruir siglas. */
function titleOrRaw(s) {
  if (!s) return s;
  // Se estiver todo em maiúsculas, aplica Title Case; senão mantém.
  return s === s.toUpperCase() ? titleCase(s) : s;
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

/* ===========================================================================
 * TELA MELD — extração por regiões e caixas de palavras (label -> valor ao lado)
 * Requisitos: associar cada rótulo ao valor imediatamente à direita na MESMA
 * linha e região; MELD e MELD-Na separados; datas (exame/tela/validade/histórico)
 * em campos distintos; valores ilegíveis ficam vazios e sinalizados; nunca
 * substituir por vizinho ou por cálculo. Registra fonte (arquivo/página/bbox/conf).
 * ======================================================================== */
function extractMeldScreen(d, meta, fileIndex, pageIndex) {
  const words = (meta.words || []).map((w) => ({ ...w, n: normToken(w.text), cx: w.x + w.w / 2, cy: w.y + w.h / 2 }));
  if (!words.length) return;
  const conf = meta.confidence != null ? meta.confidence : 100;
  const src = (bbox) => ({ fileIndex, pageIndex, bbox, confidence: conf });

  // Agrupa palavras em linhas por proximidade vertical.
  const rows = groupRows(words);

  // Localiza um rótulo (sequência de tokens) e devolve sua caixa + a linha.
  const findLabel = (labelTokens) => {
    for (const row of rows) {
      const idx = findTokenSeq(row, labelTokens);
      if (idx >= 0) return { row, startIdx: idx, endIdx: idx + labelTokens.length - 1 };
    }
    return null;
  };

  // Valor imediatamente à direita do rótulo, na MESMA linha, dentro de um limite horizontal.
  const valueRightOf = (hit, re, maxGap) => {
    if (!hit) return null;
    const after = hit.row.slice(hit.endIdx + 1);
    for (const w of after) {
      const v = (w.text || "").match(re);
      if (v) return { value: v[1] || v[0], bbox: box(w), conf };
    }
    // Permite que o valor esteja na metade direita da mesma linha (colunas).
    return null;
  };

  // Rótulo -> valor (número/decimal/data). Restrito à linha e região.
  const label = {
    dataExame: ["data", "do", "exame"],
    creatinina: ["creatinina"],
    bilirrubina: ["bilirrubina"],
    inr: ["inr"],
    sodio: ["sodio"],
    sodioSerico: ["sodio", "serico"],
    valorMeld: ["valor", "do", "meld"],
    valorMeldNa: ["valor", "meld/na"],
    validade: ["data", "de", "validade", "do", "exame"],
    dataTela: ["data"], // usada só no cabeçalho "Data: dd/mm/aaaa" da tela
  };

  const DATE = /(\d{2}\/\d{2}\/\d{4})/;
  const DEC = /^(\d{1,3}[.,]\d{1,2})$/;
  const INT = /^(\d{1,2})$/;
  const NUMBROAD = /(\d{1,3}(?:[.,]\d{1,2})?)/;

  // --- Coluna esquerda (exame + laboratoriais) ---
  setField(d, "meldData", valueRightOf(findLabel(label.dataExame), DATE, 400), src);
  setField(d, "creatinina", valueRightOf(findLabel(label.creatinina), NUMBROAD, 300), src);
  setField(d, "bilirrubina", valueRightOf(findLabel(label.bilirrubina), NUMBROAD, 300), src);
  setField(d, "inr", valueRightOf(findLabel(label.inr), NUMBROAD, 300), src);
  const sodHit = findLabel(label.sodioSerico) || findLabel(label.sodio);
  setField(d, "sodio", valueRightOf(sodHit, NUMBROAD, 300), src);

  // --- Coluna direita (MELD, MELD-Na, validade) ---
  setField(d, "meld", valueRightOf(findLabel(label.valorMeld), NUMBROAD, 300), src);
  setField(d, "meldValidade", valueRightOf(findLabel(label.validade), DATE, 300), src);

  // MELD-Na da tela — vira CANDIDATO (não grava direto; a seleção decide).
  const meldNaRes = valueRightOf(findLabel(label.valorMeldNa), NUMBROAD, 300);
  if (meldNaRes && meldNaRes.value) {
    collectMeldCandidate(d, meldNaRes.value, d.meldData, { name: meta.fileName }, src(meldNaRes.bbox), "tela");
  }

  // Data da TELA (cabeçalho "Data: 21/07/2025") — NUNCA vira data do exame.
  const telaHit = rows.map((r) => r.find((w) => /^data:?$/i.test(w.text))).find(Boolean);
  if (telaHit) {
    const row = rows.find((r) => r.includes(telaHit));
    const after = row.slice(row.indexOf(telaHit) + 1);
    const dv = after.map((w) => (w.text.match(DATE) || [])[1]).find(Boolean);
    if (dv && dv !== d.meldData) setField(d, "meldScreenDate", { value: dv, bbox: box(telaHit), conf }, src);
  }

  // --- Tabela de Histórico ---
  extractMeldHistory(d, rows, fileIndex, pageIndex, conf);
}

/** Grava um campo a partir de um resultado {value,bbox,conf}. Vazio => sinaliza revisão. */
function setField(d, field, result, srcFn) {
  if (!result || !result.value) {
    if (!d[field]) markReview(d, field);  // ilegível/ausente -> revisar (nunca substitui)
    return;
  }
  if (!d[field]) {
    d[field] = result.value;
    d.fieldSources[field] = srcFn(result.bbox);
  }
}

function markReview(d, field) {
  d.reviewFlags = d.reviewFlags || {};
  d.reviewFlags[field] = "valor ilegível/não encontrado — revisar manualmente.";
}

/** Agrupa palavras em linhas (por Y), ordenando cada linha por X. */
function groupRows(words) {
  const sorted = [...words].sort((a, b) => a.cy - b.cy);
  const rows = [];
  const tol = 10;
  for (const w of sorted) {
    let row = rows.find((r) => Math.abs(r.cy - w.cy) <= Math.max(tol, w.h * 0.6));
    if (!row) { row = Object.assign([], { cy: w.cy }); rows.push(row); }
    row.push(w);
    row.cy = (row.cy * (row.length - 1) + w.cy) / row.length;
  }
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));
  return rows.sort((a, b) => a.cy - b.cy);
}

/** Procura a sequência de tokens (normalizados) numa linha; devolve o índice inicial. */
function findTokenSeq(row, tokens) {
  for (let i = 0; i + tokens.length <= row.length; i++) {
    let ok = true;
    for (let k = 0; k < tokens.length; k++) {
      const rn = row[i + k].n.replace(/[:()]/g, "");
      if (rn !== tokens[k] && !(tokens[k].length >= 3 && rn.includes(tokens[k]))) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/** Extrai a tabela de Histórico: cada linha vira um registro datado separado (#4). */
function extractMeldHistory(d, rows, fileIndex, pageIndex, conf) {
  // Acha a linha de cabeçalho do histórico.
  const headerRowIdx = rows.findIndex((r) => {
    const txt = r.map((w) => w.n).join(" ");
    return /data do exame/.test(txt) && /creatinina/.test(txt) && /meld/.test(txt);
  });
  if (headerRowIdx < 0) return;
  // Linhas abaixo do cabeçalho que começam com uma data.
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const nums = row.map((w) => w.text);
    const date = (nums.find((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x)) || "");
    if (!date) continue;
    const decimals = nums.filter((x) => /^\d{1,3}[.,]\d{1,2}$/.test(x));
    const ints = nums.filter((x) => /^\d{1,2}$/.test(x));
    const dates = nums.filter((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x));
    const rec = {
      date,
      creat: decimals[0] || "", bili: decimals[1] || "", inr: decimals[2] || "",
      meld: ints[0] || "", meldNa: ints[1] || ints[0] || "",
      validade: dates[1] || "",
      source: { fileIndex, pageIndex, confidence: conf },
    };
    d.meldHistory.push(rec);
    // Candidato de MELD-Na do histórico — marcado como "historico".
    if (rec.meldNa) collectMeldCandidate(d, rec.meldNa, rec.date, { name: "histórico" }, rec.source, "historico");
  }
}

/** Coleta um candidato (data, valor) de MELD-Na com sua origem. */
function collectMeldCandidate(d, value, date, f, src, kind) {
  const v = Number(String(value).replace(",", "."));
  if (!isFinite(v)) return;
  d.meldCandidates.push({ value: v, raw: String(value), date: date || "", source: src || null, kind: kind || "lab", file: f && f.name });
}

/**
 * Seleciona MELD-Na conforme regra confirmada:
 *  Q1=a: janela de 3 meses relativa a HOJE.
 *  Q3=a: se nada na janela, usa o mais recente com aviso.
 *  Entre os elegíveis, escolhe o MAIOR valor; empate -> data mais recente.
 *  (Q2=b: diálise já foi tratada na coleta — usamos "sem diálise" como padrão.)
 */
function selectMeldNa(d) {
  d.notices = d.notices || {};
  d.warnings = d.warnings || {};

  // Candidatos "primários" = tela MELD + laudo laboratorial (formulário atual tem
  // prioridade). Histórico NÃO entra no pool primário (item #4): só é usado para
  // verificação/recuperação quando a linha casa com a data do exame atual.
  const all = d.meldCandidates.slice();
  const primary = all.filter((c) => c.kind === "tela" || c.kind === "lab");
  const history = all.filter((c) => c.kind === "historico");

  const now = Date.now();
  const THREE_MONTHS = 92 * 86400000;
  const within = (c) => c.date && (now - parseDate(c.date)) <= THREE_MONTHS && (now - parseDate(c.date)) >= -86400000;

  let pool = primary.filter(within);
  let outOfWindow = false, recovered = false;

  if (!pool.length && primary.length) {
    // Q3=a: fallback -> candidato primário mais recente, com aviso.
    outOfWindow = true;
    pool = [primary.filter((c) => c.date).sort((a, b) => parseDate(b.date) - parseDate(a.date))[0] || primary[0]];
  }

  if (!pool.length) {
    // Sem valor primário legível. Recuperação pelo histórico SOMENTE se a linha
    // casar com a data do exame atual (e a data do exame for legível).
    if (d.meldData) {
      const match = history.find((c) => c.date === d.meldData);
      if (match) { pool = [match]; recovered = true; }
    }
    if (!pool.length) {
      // Nada confiável: deixa vazio e sinaliza revisão (não inventa valor).
      markReview(d, "meldNa");
      if (!d.meldData) d.warnings.meldNa = "MELD-Na não lido e data do exame ilegível — selecione manualmente o registro correto.";
      else d.warnings.meldNa = "MELD-Na não lido — revise; nenhum histórico casou com a data do exame.";
      return;
    }
  }

  // Maior valor; empate -> data mais recente.
  pool.sort((a, b) => (b.value - a.value) || (parseDate(b.date) - parseDate(a.date)));
  const chosen = pool[0];

  d.meldNa = String(chosen.raw);
  if (chosen.date && !d.meldData) d.meldData = chosen.date;
  if (chosen.source) d.fieldSources.meldNa = chosen.source;

  const inWin = primary.filter(within);
  if (recovered) d.notices.meldNa = `MELD-Na recuperado do histórico (linha ${chosen.date}) por casar com a data do exame — confirme.`;
  else if (outOfWindow) d.warnings.meldNa = `MELD-Na ${chosen.raw} (${chosen.date || "sem data"}) está fora da janela de 3 meses — revisar.`;
  else if (inWin.length > 1) d.notices.meldNa = `Selecionado o maior MELD-Na dos últimos 3 meses (${chosen.raw}); ${inWin.length} exames considerados.`;
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
  // Preserva avisos/notas já definidos na consolidação (ex.: seleção de MELD-Na).
  d.warnings = d.warnings || {};
  d.notices = d.notices || {};

  // CPF — dígitos verificadores
  if (d.cpf) {
    if (!isValidCpf(d.cpf)) d.warnings.cpf = "CPF inválido — verifique se o OCR leu os dígitos corretamente.";
  }

  // MELD-Na recalculado SÓ como verificação — nunca substitui o valor lido (#5).
  const meldCalc = computeMeldNa(d.creatinina, d.bilirrubina, d.inr, d.sodio);
  if (meldCalc != null) {
    d.meldCalculado = String(meldCalc);
    // Só alerta de divergência se já houver valor lido e NÃO houver aviso prévio.
    if (d.meldNa && !d.warnings.meldNa && Math.abs(Number(d.meldNa) - meldCalc) > 1) {
      d.warnings.meldNa = `MELD-Na lido (${d.meldNa}) difere do recalculado (${meldCalc}). Confira os laboratoriais.`;
    } else if (!d.meldNa && !d.warnings.meldNa) {
      // Não preenche — apenas informa a estimativa para revisão manual.
      d.notices.meldNa = `Estimativa pelo cálculo: MELD-Na ≈ ${meldCalc} (não preenchido automaticamente; revise).`;
    }
  }
  // Propaga os flags de revisão da tela MELD para os avisos exibidos.
  if (d.reviewFlags) for (const [k, msg] of Object.entries(d.reviewFlags)) {
    if (!d.warnings[k]) d.warnings[k] = msg;
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
  add("meld", d.meld); add("meldNa", d.meldNa); add("meldData", d.meldData);
  add("meldValidade", d.meldValidade); add("meldScreenDate", d.meldScreenDate);
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
    // Preferir a caixa PRECISA registrada na extração da tela MELD (#5).
    const fs = d.fieldSources && d.fieldSources[field];
    if (fs && fs.bbox) {
      d.sourceMap[field] = { fileIndex: fs.fileIndex, pageIndex: fs.pageIndex, boxes: [fs.bbox], score: 999, confidence: fs.confidence };
      continue;
    }
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
  set("meld", d.meld); set("meldNa", d.meldNa); set("meldData", d.meldData);
  set("meldValidade", d.meldValidade); set("meldScreenDate", d.meldScreenDate);
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

/** (#1) Resumo dos relatórios individuais detectados dentro dos PDFs. */
function renderReportsSummary(reports) {
  const box = $("#reportsSummary");
  if (!box) return;
  if (!reports || !reports.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<h4>Relatórios identificados (${reports.length})</h4>` +
    reports.map((r) => {
      const lbl = r.label || reportLabel(r);
      const amb = r.ambiguous ? `<span class="rep-amb" title="Fronteira ambígua — revise manualmente">⚠ revisar</span>` : "";
      return `<div class="rep-card ${r.ambiguous ? "amb" : ""}">
        <div class="rep-head"><strong>${escapeHtml(lbl.title)}</strong> ${amb}</div>
        <div class="rep-pages">Páginas: ${escapeHtml(lbl.pages)}</div>
      </div>`;
    }).join("");
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

  const curMeta = f.pageMeta[verifierState.pageIndex];
  // Botão disponível para páginas digitais (forçar OCR) e para OCR rápido (refinar em alta resolução).
  const forceBtn = (curMeta.source === "digital" || !curMeta.ocrHighRes)
    ? `<button id="verForceOcr" class="btn btn-ghost btn-sm" type="button">🔁 ${curMeta.source === "digital" ? "Forçar OCR" : "Reprocessar em alta resolução"}</button>`
    : "";
  const cov = curMeta.coverage ? ` (cobertura ${Math.round((curMeta.coverage.ratio || 0) * 100)}%)` : "";
  const fonte = curMeta.source === "ocr"
    ? (curMeta.ocrHighRes ? "OCR (alta resolução, 300 dpi)" : "OCR (rápido, ~220 dpi)")
    : "texto digital" + cov;

  host.innerHTML = `
    <div class="verifier-head">
      <h4>Verificação — origem dos dados</h4>
      <div class="verifier-ctrls">
        <select id="verDoc" class="ver-doc">${docOptions}</select>
        <label class="ver-toggle"><input type="checkbox" id="verShowAll" ${verifierState.showAll ? "checked" : ""}> Mostrar todos os destaques</label>
      </div>
    </div>
    <p class="ver-hint">Clique em um campo para destacar sua origem. Fonte desta página:
      <strong>${fonte}</strong>. ${forceBtn}</p>
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
  const fb = $("#verForceOcr");
  if (fb) fb.addEventListener("click", () => forceOcrPage(verifierState.fileIndex, verifierState.pageIndex));

  drawStage();
}

/** (#5) Reprocessa uma página específica forçando OCR, depois re-consolida tudo. */
async function forceOcrPage(fileIndex, pageIndex) {
  const f = state.files[fileIndex];
  if (!f) return;
  const fb = $("#verForceOcr");
  if (fb) { fb.disabled = true; fb.textContent = "Executando OCR…"; }
  try {
    // (#5) Preserva correções manuais feitas pelo usuário no formulário.
    const manual = captureManualEdits();

    const pdf = await pdfjsLib.getDocument({ data: await f.file.arrayBuffer() }).promise;
    const page = await pdf.getPage(pageIndex + 1);
    let worker = state.ocrWorker;
    const ensureWorker = async () => {
      if (!worker) { worker = await Tesseract.createWorker("por", 1); state.ocrWorker = worker; }
      return worker;
    };
    const meta = await processPage(page, pageIndex + 1, pdf.numPages, f, 0, ensureWorker, true, true);
    f.pageMeta[pageIndex] = meta;
    f.pages[pageIndex] = meta.text;
    f.fullText = f.pages.join("\n");
    f.usedOcr = true;
    // Re-segmenta e re-consolida com o novo conteúdo da página.
    state.reports = segmentReports(state.files);
    state.data = consolidate(state.files, state.reports);
    runValidations(state.data);
    computeFieldConfidence(state.data);
    buildSourceMap(state.data);
    // Reaplica correções manuais por cima da re-extração.
    applyManualEdits(state.data, manual);
    fillReviewForm(state.data);
    renderReportsSummary(state.reports);
    renderImagingList(state.data);
    saveSession();
    renderVerifier();
  } catch (e) {
    console.error(e); alert("Falha ao reprocessar com OCR: " + e.message);
    if (fb) { fb.disabled = false; fb.textContent = "🔁 Reprocessar em alta resolução"; }
  }
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

/** (#5) Captura campos simples cujo valor no formulário difere do extraído (edições manuais). */
function captureManualEdits() {
  const form = $("#reviewForm");
  if (!form) return {};
  const prev = state.data || {};
  const fields = ["meld","meldNa","meldData","meldValidade","meldScreenDate","creatinina","bilirrubina","inr","sodio",
    "paciente","dataNasc","idade","cpf","rgct","equipe","hospital","tcToraxData","tcToraxResultado",
    "imagemData","afpExameData","taceDatas","irressecabilidade","criterioBarcelona","indicacao","medico","crm","dataRelatorio"];
  const edits = {};
  for (const f of fields) {
    const el = form.elements[f];
    if (!el) continue;
    const cur = (el.value || "").trim();
    if (cur && cur !== (prev[f] || "")) edits[f] = cur; // usuário alterou/preencheu
  }
  return edits;
}
/** Reaplica edições manuais por cima do objeto de dados re-extraído. */
function applyManualEdits(d, edits) {
  if (!edits) return;
  for (const [k, v] of Object.entries(edits)) {
    d[k] = v;
    if (d.reviewFlags && d.reviewFlags[k]) delete d.reviewFlags[k];
    if (d.warnings && d.warnings[k]) delete d.warnings[k];
  }
}

function readForm() {
  const form = $("#reviewForm");
  const g = (n) => (form.elements[n]?.value || "").trim();
  // Preserva metadados que não estão no formulário (imaging, confiança…).
  const prev = state.data || {};
  const d = {
    ...prev,
    paciente: g("paciente"), dataNasc: g("dataNasc"), idade: g("idade"),
    cpf: g("cpf"), rgct: g("rgct"), equipe: g("equipe"), hospital: g("hospital"),
    meld: g("meld"), meldNa: g("meldNa"), meldData: g("meldData"),
    meldValidade: g("meldValidade"), meldScreenDate: g("meldScreenDate"),
    creatinina: g("creatinina"),
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
