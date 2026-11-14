/* ===========================================================================
 * Regressão da TELA MELD — valida extractMeldScreen() / selectMeldNa() contra
 * caixas de palavras sintéticas que reproduzem o layout do screenshot.
 *
 * Caso de regressão (valores verificados visualmente):
 *   Data do Exame 16/06/2025 · Creatinina 0,74 · Bilirrubina 1,44 · INR 1,33
 *   Sódio 142,00 · MELD 11 · MELD-Na 11 · Validade 14/09/2025
 *   Data da tela (cabeçalho) 21/07/2025  -> NÃO pode virar data do exame
 *   Histórico: linha 04/10/2024 deve ficar separada.
 *
 * Também cobre: valores ausentes, texto de OCR reordenado, números repetidos,
 * múltiplas linhas de histórico, e a garantia de que um INR ilegível NÃO
 * capture a creatinina (0,74).
 * Rode com:  node tests/meld-screen.test.mjs
 * ======================================================================== */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, "..", "app.js");

// --- Stub de DOM mínimo para avaliar app.js em Node ---
const stub = {
  value: "", classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, appendChild() {}, querySelectorAll: () => [],
  closest: () => null, parentElement: { appendChild() {}, querySelectorAll: () => [] },
  reset() {}, scrollIntoView() {}, innerHTML: "", style: {},
  elements: new Proxy({}, { get: () => ({ value: "", classList: { add() {}, remove() {} }, addEventListener() {} }) }),
};
globalThis.pdfjsLib = { GlobalWorkerOptions: {} };
globalThis.Tesseract = {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {};
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.document = { querySelector: () => stub, createElement: () => stub, addEventListener() {}, body: { appendChild() {} } };

const code = fs.readFileSync(appPath, "utf8");
new Function(code + "\n;globalThis.__app={consolidate,extractMeldScreen,selectMeldNa,groupRows,findTokenSeq};")();
const app = globalThis.__app;

// --- Utilidades de teste ---
let passed = 0, failed = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  console.log(`${ok ? "✓" : "✗"} ${name} => got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? passed++ : failed++;
}
function truthy(name, got) {
  const ok = !!got;
  console.log(`${ok ? "✓" : "✗"} ${name} => ${JSON.stringify(got)}`);
  ok ? passed++ : failed++;
}

/** Gera uma palavra-caixa simples numa grade (coluna*120, linha*40). */
function W(text, col, line, wpx = 90) {
  return { text, x: col * 120, y: line * 40, w: wpx, h: 24 };
}

/** Monta um meta de página (tela MELD) a partir de uma lista de palavras. */
function meldPage(words, fileName = "tela.pdf") {
  const text = buildText(words);
  return { source: "ocr", confidence: 90, width: 2000, height: 1400, words, text, fileName,
    ids: {}, hasExamIds: false };
}
function buildText(words) {
  // Reconstrói um texto por linhas (para os ramos que usam texto corrido).
  const byLine = new Map();
  for (const w of words) { const k = Math.round(w.y / 40); (byLine.get(k) || byLine.set(k, []).get(k)).push(w); }
  return [...byLine.entries()].sort((a, b) => a[0] - b[0])
    .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((w) => w.text).join(" ")).join("\n");
}

/** Caixas que reproduzem o layout do screenshot. */
function screenshotWords(overrides = {}) {
  const v = Object.assign({
    dataExame: "16/06/2025", creat: "0,74", bili: "1,44", inr: "1,33", sodio: "142,00",
    meld: "11", meldNa: "11", validade: "14/09/2025", dataTela: "21/07/2025",
  }, overrides);
  const words = [];
  // Cabeçalho: "Data: 21/07/2025"
  words.push(W("Data:", 6, 0), W(v.dataTela, 7, 0));
  // Coluna esquerda
  words.push(W("Data", 0, 2), W("do", 1, 2), W("Exame:", 1.6, 2), v.dataExame ? W(v.dataExame, 3, 2) : null);
  words.push(W("Creatinina", 0, 3), W("(mg/dL):", 1.4, 3), v.creat ? W(v.creat, 3, 3) : null);
  words.push(W("Bilirrubina", 0, 4), W("(mg/dL):", 1.4, 4), v.bili ? W(v.bili, 3, 4) : null);
  words.push(W("INR:", 0, 5), v.inr ? W(v.inr, 3, 5) : null);
  words.push(W("Sodio", 0, 6), W("serico", 0.7, 6), W("(mEq/L):", 1.5, 6), v.sodio ? W(v.sodio, 3, 6) : null);
  // Coluna direita
  words.push(W("Valor", 5, 2), W("do", 5.7, 2), W("MELD:", 6.2, 2), v.meld ? W(v.meld, 7.3, 2) : null);
  words.push(W("Valor", 5, 3), W("MELD/Na:", 5.7, 3), v.meldNa ? W(v.meldNa, 7.3, 3) : null);
  words.push(W("Data", 5, 4), W("de", 5.6, 4), W("validade", 6.1, 4), W("do", 6.9, 4), W("Exame:", 7.3, 4), v.validade ? W(v.validade, 9, 4) : null);
  // Marcador de tela p/ detecção
  words.push(W("Valor", 5, 2));
  return words.filter(Boolean);
}

/** Linhas de histórico (cada uma com data + labs + MELD + validade). */
function historyWords(startLine) {
  const words = [];
  // Cabeçalho do histórico
  ["Data", "do", "Exame", "Creatinina", "Bilirrubina", "INR", "MELD", "MELD", "Corrigido", "Validade"]
    .forEach((t, i) => words.push(W(t, i, startLine)));
  // Linha atual (16/06/2025) e anterior (04/10/2024)
  const r1 = ["16/06/2025", "0,74", "1,44", "1,33", "11", "11", "14/09/2025"];
  const r2 = ["04/10/2024", "0,87", "1,62", "1,27", "11", "11", "02/01/2025"];
  r1.forEach((t, i) => words.push(W(t, i, startLine + 1)));
  r2.forEach((t, i) => words.push(W(t, i, startLine + 2)));
  return words;
}

function freshD() {
  return {
    meld: "", meldNa: "", meldData: "", meldScreenDate: "", meldValidade: "",
    creatinina: "", bilirrubina: "", inr: "", sodio: "",
    meldHistory: [], meldCandidates: [], afp: [], imaging: [],
    fieldSources: {}, warnings: {}, notices: {}, reviewFlags: {},
  };
}

/* --- Teste 1: caso de regressão do screenshot --- */
console.log("\n== Teste 1: valores do screenshot ==");
{
  const d = freshD();
  const words = screenshotWords().concat(historyWords(8));
  app.extractMeldScreen(d, meldPage(words), 0, 0);
  app.selectMeldNa(d);
  eq("Data do exame", d.meldData, "16/06/2025");
  eq("Creatinina", d.creatinina, "0,74");
  eq("Bilirrubina", d.bilirrubina, "1,44");
  eq("INR", d.inr, "1,33");
  eq("Sódio", d.sodio, "142,00");
  eq("MELD", d.meld, "11");
  eq("MELD-Na", d.meldNa, "11");
  eq("Validade", d.meldValidade, "14/09/2025");
  eq("Data da tela (separada)", d.meldScreenDate, "21/07/2025");
  truthy("Tela != exame", d.meldScreenDate !== d.meldData);
  eq("Histórico: nº de linhas", d.meldHistory.length, 2);
  truthy("Histórico tem 04/10/2024", d.meldHistory.some((h) => h.date === "04/10/2024"));
}

/* --- Teste 2: INR ilegível NÃO vira creatinina --- */
console.log("\n== Teste 2: INR ausente não captura creatinina ==");
{
  const d = freshD();
  const words = screenshotWords({ inr: "" }); // sem valor de INR
  app.extractMeldScreen(d, meldPage(words), 0, 0);
  truthy("INR vazio", d.inr === "" || d.inr == null);
  truthy("INR sinalizado p/ revisão", d.reviewFlags && d.reviewFlags.inr);
  eq("Creatinina intacta", d.creatinina, "0,74");
  truthy("INR != creatinina", d.inr !== "0,74");
}

/* --- Teste 3: data da tela não vira data do exame (exame ausente) --- */
console.log("\n== Teste 3: data do exame ausente não é preenchida pela tela ==");
{
  const d = freshD();
  const words = screenshotWords({ dataExame: "" });
  app.extractMeldScreen(d, meldPage(words), 0, 0);
  truthy("Data do exame vazia", !d.meldData);
  truthy("Data do exame sinalizada", d.reviewFlags && d.reviewFlags.meldData);
  eq("Data da tela ainda 21/07/2025", d.meldScreenDate, "21/07/2025");
}

/* --- Teste 4: números repetidos (MELD e MELD-Na ambos 11) --- */
console.log("\n== Teste 4: MELD e MELD-Na ambos 11, campos separados ==");
{
  const d = freshD();
  app.extractMeldScreen(d, meldPage(screenshotWords()), 0, 0);
  eq("MELD", d.meld, "11");
  app.selectMeldNa(d);
  eq("MELD-Na", d.meldNa, "11");
}

/* --- Teste 5: múltiplas linhas de histórico com datas distintas --- */
console.log("\n== Teste 5: histórico preserva registros datados separados ==");
{
  const d = freshD();
  const words = screenshotWords().concat(historyWords(8));
  app.extractMeldScreen(d, meldPage(words), 0, 0);
  const h1 = d.meldHistory.find((h) => h.date === "16/06/2025");
  const h2 = d.meldHistory.find((h) => h.date === "04/10/2024");
  truthy("Registro 16/06/2025", h1);
  truthy("Registro 04/10/2024", h2);
  eq("Labs não se misturam (04/10 creat)", h2 && h2.creat, "0,87");
  eq("Labs não se misturam (16/06 creat)", h1 && h1.creat, "0,74");
}

/* --- Teste 6: OCR reordenado na linha (valor antes do rótulo em outra coluna) --- */
console.log("\n== Teste 6: ordem de OCR embaralhada entre linhas ==");
{
  const d = freshD();
  const words = screenshotWords();
  // embaralha a ORDEM do array (não as posições x/y) para simular OCR fora de ordem
  for (let i = words.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [words[i], words[j]] = [words[j], words[i]]; }
  app.extractMeldScreen(d, meldPage(words), 0, 0);
  eq("Creatinina (apesar da ordem)", d.creatinina, "0,74");
  eq("INR (apesar da ordem)", d.inr, "1,33");
  eq("Data do exame (apesar da ordem)", d.meldData, "16/06/2025");
}

/* --- Teste 7: laudo laboratorial "sem/com diálise" (Q2=b usa SEM diálise) --- */
console.log("\n== Teste 7: lab MELD-Na sem/com diálise -> usa SEM diálise ==");
{
  const d = freshD();
  const labText = "ESCALA MELD\nCREATININA 0.74 mg/dL\nBILIRRUBINA TOTAL 1.44 mg/dL\nSODIO 142 mEq/L\nINR 1.33\nMELD-Na (sem dialise) 11\nMELD-Na (com dialise) 24\nColeta: 16/06/2025";
  const files = [{ fullText: labText, pages: [labText], detected: "Laudo laboratorial (MELD)", pageMeta: [] }];
  globalThis.state = { files };
  const out = app.consolidate(files, []);
  eq("MELD-Na do lab (sem diálise)", out.meldNa, "11");
  truthy("Não usou 24 (com diálise)", out.meldNa !== "24");
}

/* --- Teste 8: seleção do maior MELD-Na dentro de 3 meses --- */
console.log("\n== Teste 8: janela de 3 meses + maior valor ==");
{
  // Reaproveita selectMeldNa com candidatos sintéticos datados perto de hoje.
  const d = freshD();
  const fmt = (dt) => `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
  const near1 = new Date(Date.now() - 10 * 86400000); // 10 dias atrás
  const near2 = new Date(Date.now() - 40 * 86400000); // 40 dias atrás
  const old = new Date(Date.now() - 200 * 86400000);  // fora da janela
  d.meldCandidates = [
    { value: 11, raw: "11", date: fmt(near1), kind: "tela", source: null },
    { value: 15, raw: "15", date: fmt(near2), kind: "lab", source: null },
    { value: 30, raw: "30", date: fmt(old), kind: "lab", source: null },
  ];
  app.selectMeldNa(d);
  eq("Maior MELD-Na dentro de 3 meses (15, não 30)", d.meldNa, "15");
}

/* --- Teste 9: remoção de rodapé/assinatura/lixo de OCR --- */
console.log("\n== Teste 9: stripSignatureNoise remove assinaturas/endereços/URLs/lixo ==");
{
  new Function(code + "\n;globalThis.__noise=stripSignatureNoise;")();
  const strip = globalThis.__noise;
  const noisy = "Figado com sinais de hepatopatia cronica. Lesao no segmento IVa. " +
    "Dra SL Figueiredo CRM - 126918/SP Rua Napoleao de Barros, 737 - Vila Clementino - 04024-002 - Sao Paulo — SP " +
    "Tel.: (11) 5576-4897 - https://www.hspmais.org.br/ EEE ese pm pa. " +
    "Patient ID: 35999947$$$34020 Report Date: 03/07/2025 18:06 ACCH: 987175290 " +
    "FERNANDA ANGELI BRAGA CRM/SP 148840 DRA. JULIA ESPINDOLA GUIMARAES CRM 271008-SP " +
    "o o o o o o o o o o o o o";
  const out = strip(noisy);
  truthy("Mantém o conteúdo clínico", /hepatopatia cronica/i.test(out) && /segmento iva/i.test(out));
  truthy("Remove CRM", !/crm/i.test(out));
  truthy("Remove telefone", !/5576-4897/.test(out));
  truthy("Remove URL", !/hspmais|https?:/i.test(out));
  truthy("Remove Patient ID/ACC/Report Date", !/patient id|acc#|report date/i.test(out));
  truthy("Remove endereço", !/napole[aã]o|clementino|04024/i.test(out));
  truthy("Remove lixo de OCR", !/EEE|ese pm pa|\$\$\$/.test(out) && !/\bo o o o\b/.test(out));
  console.log("   saída:", JSON.stringify(out));
}

console.log(`\n==== RESULTADO: ${passed} passaram, ${failed} falharam ====`);
process.exit(failed ? 1 : 0);
