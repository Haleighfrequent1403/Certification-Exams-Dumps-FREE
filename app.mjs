import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface as createLineReader } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(ROOT, "output");
const CACHE_ROOT = path.join(ROOT, ".cache");
const SCRAPER = path.join(ROOT, "scraper.mjs");
const REQUEST_DELAY_MS = 1_500;
const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const color = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const cyan = (text) => color("96", text);
const green = (text) => color("92", text);
const yellow = (text) => color("93", text);
const red = (text) => color("91", text);
const dim = (text) => color("2", text);

let liveTimer = null;
let liveFrame = 0;
const frames = ["|", "/", "-", "\\"];
const progressStates = new Map();
const nonTtyProgress = new Map();

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function duration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function phase(number, label) {
  return `[${number}/3] ${label.padEnd(9)}`;
}

function fitLine(value) {
  const width = Math.max(48, (process.stdout.columns || 100) - 3);
  return value.length > width ? `${value.slice(0, width - 3)}...` : value;
}

function clearLive() {
  if (!liveTimer) return;
  clearInterval(liveTimer);
  liveTimer = null;
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
}

function spin(text) {
  clearLive();
  if (!process.stdout.isTTY) {
    process.stdout.write(`  RUN  ${text}\n`);
    return;
  }
  const draw = () => process.stdout.write(`\r\x1b[2K  ${cyan(frames[liveFrame++ % frames.length])} ${fitLine(text)}`);
  draw();
  liveTimer = setInterval(draw, 120);
}

function line(text = "") {
  clearLive();
  process.stdout.write(`${text}\n`);
}

function progress(number, label, current, total, suffix = "", unit = "q") {
  clearLive();
  const safeTotal = Math.max(1, Number(total) || Number(current) || 1);
  const safeCurrent = Math.min(safeTotal, Math.max(0, Number(current) || 0));
  const now = Date.now();
  const key = `${number}:${label}`;
  const state = progressStates.get(key) ?? {
    startedAt: now,
    lastAt: now,
    lastCurrent: safeCurrent,
    rate: 0,
  };
  const secondsSinceUpdate = (now - state.lastAt) / 1_000;
  if (safeCurrent > state.lastCurrent && secondsSinceUpdate > 0) {
    const currentRate = (safeCurrent - state.lastCurrent) / secondsSinceUpdate;
    state.rate = state.rate ? state.rate * 0.7 + currentRate * 0.3 : currentRate;
    state.lastAt = now;
    state.lastCurrent = safeCurrent;
  } else if (safeCurrent < state.lastCurrent) {
    state.startedAt = now;
    state.lastAt = now;
    state.lastCurrent = safeCurrent;
    state.rate = 0;
  }
  state.current = safeCurrent;
  state.total = safeTotal;
  state.suffix = suffix;
  state.unit = unit;
  progressStates.set(key, state);

  const percent = Math.round((safeCurrent / safeTotal) * 100);
  if (!process.stdout.isTTY) {
    const bucket = safeCurrent === safeTotal ? 10 : Math.floor(percent / 10);
    if (nonTtyProgress.get(key) === bucket) return;
    nonTtyProgress.set(key, bucket);
    process.stdout.write(`  RUN  ${phase(number, label)} ${safeCurrent}/${safeTotal} ${percent}%${suffix ? ` | ${suffix}` : ""}\n`);
    return;
  }

  const draw = () => {
    const barWidth = clamp((process.stdout.columns || 100) - 78, 12, 28);
    const currentPercent = Math.round((state.current / state.total) * 100);
    const filled = Math.round((currentPercent / 100) * barWidth);
    const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
    const eta = state.rate > 0 && state.current < state.total
      ? duration(((state.total - state.current) / state.rate) * 1_000)
      : "--:--";
    const rate = state.rate > 0 ? `${state.rate.toFixed(state.rate < 10 ? 1 : 0)} ${state.unit}/s` : `-- ${state.unit}/s`;
    const text = `${phase(number, label)} [${bar}] ${state.current}/${state.total} ${currentPercent}% | ${rate} | ${duration(Date.now() - state.startedAt)} | ETA ${eta}${state.suffix ? ` | ${state.suffix}` : ""}`;
    process.stdout.write(`\r\x1b[2K  ${cyan(fitLine(text))}`);
  };
  draw();
  liveTimer = setInterval(draw, 500);
}

function printHeader() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  line(cyan("                                                                    █"));
  line(cyan("  ▄▄▄  ▄     ▄  ▄▄▄    ▄ ▄▄  ▄ ▄▄    ▄▄▄   ▄   ▄   ▄▄▄           ▄▄▄█   ▄▄▄   ▄   ▄"));
  line(cyan(" █   ▀ ▀▄ ▄ ▄▀ ▀   █   █▀  ▀ █▀  █  ▀   █  ▀▄ ▄▀  ▀   █         █▀ ▀█  █▀  █  ▀▄ ▄▀"));
  line(cyan("  ▀▀▀▄  █▄█▄█  ▄▀▀▀█   █     █   █  ▄▀▀▀█   █▄█   ▄▀▀▀█         █   █  █▀▀▀▀   █▄█"));
  line(cyan(" ▀▄▄▄▀   █ █   ▀▄▄▀█   █     █   █  ▀▄▄▀█    █    ▀▄▄▀█    █    ▀█▄██  ▀█▄▄▀    █"));
  line();
  line(cyan("                         CERTIFICATION EXAM QUESTIONS"));
  line();
  line(`  ${cyan("Swarnava Dutta")}  |  https://swarnava.dev`);
  line(`  ${yellow("Star the repo 🌟")}`);
  line("  https://github.com/swarnava-dutta/Certification-Exams-Dumps-FREE");
  line();
}

export function validateExamCode(value) {
  const code = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/i.test(code)) {
    throw new Error("Enter a valid exam code such as AI-103, AZ-900, or PL-300.");
  }
  return code.toUpperCase();
}

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  let code = null;
  let provider = null;
  let refresh = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--refresh") refresh = true;
    else if (value === "--provider" || value === "-p") provider = argv[++index];
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else if (code === null) code = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  if (provider === undefined || (provider && !/^[a-z0-9][a-z0-9-]{0,59}$/i.test(provider))) {
    throw new Error("--provider requires a provider slug such as microsoft or amazon.");
  }
  return { code, provider: provider?.toLowerCase() ?? null, refresh };
}

async function askForCode() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return validateExamCode(await prompt.question(cyan("  Enter exam code: ")));
  } finally {
    prompt.close();
  }
}

function parseEvent(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function runScraper(code, outputDir, refresh, provider) {
  const args = [SCRAPER, "--exam", code, "--output-dir", outputDir, "--delay-ms", String(REQUEST_DELAY_MS)];
  if (provider) args.push("--provider", provider);
  if (refresh) args.push("--refresh");

  let total = 0;
  let fetched = 0;
  let activePhase = phase(1, "Find exam");
  let fatal = "";
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, EXAM_PREVIEW_FILE: path.join(outputDir, "checkpoint.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onEvent = (event) => {
    if (!event) return;
    if (event.event === "discovery_started") spin(`${phase(1, "Find exam")} Looking up ${code}...`);
    else if (event.event === "exam_discovered") {
      total = Number(event.questionCount) || total;
      line(`  ${green("OK")}   ${phase(1, "Find exam")} ${event.title ?? event.exam} (${event.providerDisplayName ?? event.provider})`);
      activePhase = phase(2, "Questions");
      spin(`${activePhase} Preparing questions...`);
    } else if (event.event === "checkpoint_reused") {
      total = Number(event.questionCount) || total;
      fetched = Number(event.fetched) || 0;
      line(`  ${green("OK")}   ${phase(1, "Find exam")} ${event.title ?? event.exam}`);
      activePhase = phase(2, "Questions");
      progress(2, "Questions", fetched, total || fetched, "resumed");
    } else if (event.event === "exam_metadata") {
      total = Number(event.questionCount) || total;
      fetched = Number(event.fetched) || fetched;
      progress(2, "Questions", fetched, total, event.pages ? `page 0/${event.pages}` : "");
    } else if (event.event === "page_parsed") {
      fetched = Number(event.fetched) || fetched;
      progress(2, "Questions", fetched, total, `page ${event.page}/${event.pages}`);
    } else if (event.event === "listing_fallback_started") {
      progress(2, "Questions", fetched, total, "switching to complete question pages");
    } else if (event.event === "detail_fallback_started") {
      fetched = Number(event.fetched) || fetched;
      progress(2, "Questions", fetched, total, `recovering ${event.missing} remaining`);
    } else if (event.event === "detail_fallback_progress") {
      fetched = Number(event.fetched) || fetched;
      progress(2, "Questions", fetched, total, `recovering question ${event.question}`);
    } else if (event.event === "detail_skipped") {
      progress(2, "Questions", fetched, total, `source route ${event.route} unavailable`);
    } else if (event.event === "rate_limit") {
      line(`  ${yellow("WAIT")} The source requested a ${Math.ceil(event.retryAfterMs / 1_000)}s pause; respecting it.`);
      spin(`${activePhase} Waiting before the next request...`);
    } else if (event.event === "retry") {
      if (event.reason === "connection") {
        line(`  ${yellow("WAIT")} Secure connection attempt ${event.attempt}/${event.maxAttempts} timed out; retrying in ${Math.ceil(event.waitMs / 1_000)}s.`);
        spin(`${activePhase} Waiting for the source to accept the connection...`);
      } else {
        line(`  ${yellow("WAIT")} Temporary source error; retrying in ${Math.ceil(event.waitMs / 1_000)}s.`);
        spin(`${activePhase} Trying the same public page again...`);
      }
    } else if (event.event === "images_started") {
      line(`  ${green("OK")}   ${phase(2, "Questions")} ${total} questions ready`);
      activePhase = phase(2, "Questions");
      spin(`${activePhase} Finalizing study content...`);
    } else if (event.event === "cache_reused") {
      total = Number(event.questions) || total;
      line(`  ${green("OK")}   ${phase(1, "Find exam")} Exam ready`);
      line(`  ${green("OK")}   ${phase(2, "Questions")} ${event.questions} questions ready`);
    } else if (event.event === "saved") {
      clearLive();
    } else if (event.event === "fatal") {
      fatal = event.error ?? "Scraping failed";
    }
  };

  createLineReader({ input: child.stdout }).on("line", (value) => onEvent(parseEvent(value)));
  createLineReader({ input: child.stderr }).on("line", (value) => {
    const event = parseEvent(value);
    if (event) onEvent(event);
    else if (value.trim()) fatal = value.trim();
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearLive();
  if (exitCode !== 0) throw new Error(fatal || `Scraper stopped with exit code ${exitCode}`);
  return JSON.parse(await readFile(path.join(outputDir, "questions.json"), "utf8"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanProse(value) {
  return String(value ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|blockquote)>/gi, "\n")
    .replace(/<\/?(?:p|div|span|strong|em|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|code|pre|a)\b[^>]*>/gi, " ")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function prose(value) {
  const text = cleanProse(value);
  if (!text || /^\$[0-9a-f]+$/i.test(text)) return "";
  return text
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

function list(values, className = "options") {
  const items = (values ?? []).filter((value) => cleanProse(value));
  if (!items.length) return "";
  return `<ul class="${className}">${items.map((value) => `<li>${prose(value)}</li>`).join("")}</ul>`;
}

function collectImages(value, output = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:^|[\s("'])((?:assets[\\/])[^\s)"'<>]+\.(?:avif|gif|jpe?g|png|svg|webp))/gi)) {
      output.add(match[1].replaceAll("\\", "/"));
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectImages(item, output));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectImages(item, output));
  }
  return [...output];
}

function renderQuestion(question) {
  const definition = question.definition ?? {};
  const choices = (definition.choices ?? []).map((choice) => {
    if (typeof choice === "string") return choice;
    return `${choice.label ? `${choice.label}. ` : ""}${choice.text ?? choice.value ?? ""}`;
  });
  const blanks = (definition.blanks ?? []).map((blank) => `
    <div class="subquestion">
      <div class="subquestion-title">${escapeHtml(blank.label ?? "Select an answer")}</div>
      ${list(blank.options)}
    </div>`).join("");
  const statements = (definition.statements ?? []).map((statement) => `
    <tr><td>${prose(statement.text ?? statement.label)}</td><td>${escapeHtml((definition.columns ?? []).join(" / "))}</td></tr>`).join("");
  const slots = (definition.slots ?? []).map((slot) => slot.label ?? slot.group).filter(Boolean);
  const images = collectImages(definition).map((source) => `
    <figure><img src="${escapeHtml(source)}" alt="Question ${question.number} diagram"><figcaption>Question ${question.number} diagram</figcaption></figure>`).join("");
  const group = definition.group?.content ? `
    <aside class="scenario">
      <strong>${escapeHtml(definition.group.title || "Scenario")}</strong>
      ${prose(definition.group.content)}
    </aside>` : "";
  const explanation = prose(definition.explanation);

  return `
  <article class="question">
    <div class="question-head">
      <span class="number">Question ${question.number}</span>
      <span class="topic">${escapeHtml(question.topic ?? "Other")}</span>
      <span class="type">${escapeHtml(String(question.type ?? "question").replaceAll("_", " "))}</span>
    </div>
    ${group}
    <div class="stem">${prose(definition.stemRaw ?? definition.stem ?? "")}</div>
    ${choices.length ? list(choices) : ""}
    ${blanks}
    ${statements ? `<table><thead><tr><th>Statement</th><th>Options</th></tr></thead><tbody>${statements}</tbody></table>` : ""}
    ${slots.length ? `<div class="subquestion"><div class="subquestion-title">Match each item</div>${list(slots)}${definition.items?.length ? `<div class="choice-pool"><strong>Available choices:</strong> ${escapeHtml(definition.items.join(" | "))}</div>` : ""}</div>` : ""}
    ${definition.template ? `<div class="template">${prose(definition.template)}</div>` : ""}
    ${images}
    <section class="answer"><strong>Correct answer${question.answers?.length === 1 ? "" : "s"}</strong>${list(question.answers, "answers")}</section>
    ${explanation ? `<section class="explanation"><strong>Explanation</strong>${explanation}</section>` : ""}
  </article>`;
}

export function buildHtml(data, code) {
  const questions = Array.isArray(data.questions) ? data.questions : [];
  const generated = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeStyle: "short" }).format(new Date());
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(data.title ?? code)}</title>
<style>
  @page {
    size: A4;
    margin: 14mm;
    @bottom-center {
      content: "Page " counter(page) " of " counter(pages);
      color: #475569;
      font: 7pt Arial, "Segoe UI", sans-serif;
    }
  }
  * { box-sizing: border-box; }
  body { width: 182mm; margin: 0; color: #172033; font: 10.5pt/1.45 Arial, "Segoe UI", sans-serif; background: white; overflow-wrap: anywhere; }
  .page-header, .page-footer { position: fixed; left: 0; right: 0; z-index: 10; color: #475569; font-family: Arial, "Segoe UI", sans-serif; }
  .page-header { top: 0; display: grid; grid-template-columns: minmax(44mm, 1fr) minmax(0, 2fr); gap: 6mm; align-items: start; font-size: 6.8pt; line-height: 1.2; }
  .page-header .created { white-space: nowrap; }
  .page-header .exam-name { color: #172033; font-weight: 700; text-align: right; overflow-wrap: anywhere; }
  .page-footer { bottom: 0; display: grid; grid-template-columns: minmax(0, 1fr) 26mm minmax(0, 1fr); gap: 2.5mm; align-items: end; font-size: 6.3pt; line-height: 1.15; }
  .page-footer a { color: #0e7490; text-decoration: none; overflow-wrap: anywhere; }
  .page-footer .owner { color: #475569; text-align: right; }
  .pdf-content { padding: 8mm 0; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  .cover { min-height: 253mm; display: flex; flex-direction: column; justify-content: center; padding: 18mm; color: white; background: linear-gradient(145deg, #12233f, #155e75 65%, #0891b2); page-break-after: always; }
  .cover .eyebrow { color: #a5f3fc; font-size: 11pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .cover h1 { margin: 8mm 0 4mm; font-size: 30pt; line-height: 1.08; }
  .cover .code { display: inline-block; width: fit-content; padding: 2.5mm 4mm; border: 1px solid rgba(255,255,255,.45); border-radius: 3mm; font-size: 15pt; font-weight: 700; }
  .cover .meta { margin-top: 12mm; display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 4mm; }
  .cover .meta div { padding: 4mm; border-radius: 3mm; background: rgba(255,255,255,.12); }
  .cover .brand { margin-top: auto; display: flex; flex-wrap: wrap; gap: 2mm 4mm; color: #cffafe; font-size: 9pt; }
  .cover .brand a { color: white; font-weight: 700; text-decoration: none; }
  .question { padding: 0 0 8mm; margin: 0 0 8mm; border-bottom: 1px solid #cbd5e1; break-inside: avoid-page; page-break-inside: avoid; }
  .question > *, .question li, .question tr { break-inside: avoid-page; page-break-inside: avoid; }
  .question p { orphans: 3; widows: 3; }
  .question.compact { line-height: 1.22; padding-bottom: 2mm; margin-bottom: 2mm; }
  .question.compact .question-head { margin-bottom: 1.5mm; }
  .question.compact p { margin: .6mm 0; }
  .question.compact ul.options { margin: .8mm 0; }
  .question.compact ul.options li { margin: .5mm 0; padding: .8mm 1.5mm; }
  .question.compact .subquestion { margin: .8mm 0; }
  .question.compact .answer, .question.compact .explanation, .question.compact .scenario { margin-top: 1.2mm; padding: 2mm; }
  .question.compact .answer ul { margin-top: .5mm; }
  .question.compact img { max-height: 120mm; }
  .question-head { display: flex; align-items: center; gap: 2.5mm; margin-bottom: 4mm; break-after: avoid; }
  .number { color: #0e7490; font-size: 15pt; font-weight: 800; }
  .topic, .type { padding: 1.2mm 2.5mm; border-radius: 99px; background: #ecfeff; color: #155e75; font-size: 8.5pt; font-weight: 700; }
  .type { margin-left: auto; background: #f1f5f9; color: #475569; text-transform: capitalize; }
  .stem > p:first-child { margin-top: 0; }
  p { margin: 2.2mm 0; }
  ul.options { list-style: none; padding: 0; margin: 3mm 0; }
  ul.options li { margin: 2mm 0; padding: 2.5mm 3mm; border: 1px solid #dbe4ee; border-radius: 2.5mm; background: #f8fafc; }
  ul.options li p, ul.answers li p { margin: 0; }
  .subquestion { margin: 3mm 0; }
  .subquestion-title { font-weight: 700; }
  .choice-pool { margin-top: 2mm; padding: 2.5mm; background: #f8fafc; border-radius: 2mm; }
  .answer, .explanation, .scenario { margin-top: 4mm; padding: 4mm; border-radius: 3mm; break-inside: avoid; }
  .answer { border-left: 4px solid #16a34a; background: #f0fdf4; color: #14532d; }
  .answer ul { margin: 2mm 0 0; padding-left: 5mm; }
  .explanation { border-left: 4px solid #0284c7; background: #f0f9ff; color: #0c4a6e; }
  .scenario { border-left: 4px solid #7c3aed; background: #f5f3ff; color: #4c1d95; }
  table { width: 100%; margin: 3mm 0; border-collapse: collapse; break-inside: avoid; }
  th, td { padding: 2.5mm; border: 1px solid #cbd5e1; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  figure { margin: 4mm 0; text-align: center; break-inside: avoid; }
  img { display: block; max-width: 100%; max-height: 170mm; margin: 0 auto; object-fit: contain; }
  figcaption { margin-top: 1.5mm; color: #64748b; font-size: 8pt; }
  .template { padding: 3mm; border: 1px dashed #94a3b8; white-space: pre-wrap; }
  @media print { .question { break-before: auto; } }
</style></head><body>
<header class="page-header">
  <time class="created">${escapeHtml(generated)}</time>
  <span class="exam-name">${escapeHtml(data.title ?? code)}</span>
</header>
<footer class="page-footer">
  <a href="https://github.com/swarnava-dutta/Certification-Exams-Dumps-FREE">https://github.com/swarnava-dutta/Certification-Exams-Dumps-FREE</a>
  <span aria-hidden="true"></span>
  <a class="owner" href="https://swarnava.dev">Swarnava Dutta (https://swarnava.dev)</a>
</footer>
<main class="pdf-content">
<section class="cover">
  <div class="eyebrow">Certification Exam Questions</div>
  <h1>${escapeHtml(data.title ?? code)}</h1>
  <div class="code">${escapeHtml(code)}</div>
  <div class="meta">
    <div><strong>${escapeHtml(data.provider ?? "Unknown")}</strong><br>Provider</div>
    <div><strong>${questions.length}</strong><br>Questions</div>
    <div><strong>Included</strong><br>Answers &amp; explanations</div>
    <div><strong>${escapeHtml(generated)}</strong><br>PDF generated</div>
  </div>
  <div class="brand">
    <span>Created by <a href="https://swarnava.dev">Swarnava Dutta</a></span>
    <span>Don’t forget to <a href="https://github.com/swarnava-dutta/Certification-Exams-Dumps-FREE">star the GitHub repo</a></span>
  </div>
</section>
${questions.map(renderQuestion).join("\n")}
</main>
<script>
  addEventListener("load", () => {
    const printableHeight = 244 * 96 / 25.4;
    for (const question of document.querySelectorAll(".question")) {
      if (question.getBoundingClientRect().height <= printableHeight) continue;
      question.classList.add("compact");
      if (question.getBoundingClientRect().height <= printableHeight) continue;
      let low = 0.25;
      let high = 1;
      question.style.zoom = String(low);
      if (question.getBoundingClientRect().height > printableHeight) {
        low *= printableHeight / question.getBoundingClientRect().height * 0.98;
      }
      for (let step = 0; step < 12; step += 1) {
        const middle = (low + high) / 2;
        question.style.zoom = String(middle);
        if (question.getBoundingClientRect().height <= printableHeight) low = middle;
        else high = middle;
      }
      question.style.zoom = (low * 0.995).toFixed(4);
      question.dataset.pdfScale = question.style.zoom;
    }
  });
</script>
</body></html>`;
}

async function firstExisting(paths) {
  for (const filename of paths) {
    try {
      await access(filename);
      return filename;
    } catch {
      // Try the next installed browser.
    }
  }
  return null;
}

export async function renderPdf(htmlPath, pdfPath) {
  const browser = process.env.EXAM_BROWSER_PATH || process.env.BROWSER_PATH || await firstExisting([
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ...(process.env.LOCALAPPDATA ? [
      path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ] : []),
  ]);
  if (!browser) throw new Error("Microsoft Edge or Google Chrome is required to create the PDF.");

  const profileDir = await mkdtemp(path.join(os.tmpdir(), "exam-pdf-"));
  const temporaryPdfPath = path.join(
    path.dirname(pdfPath),
    `.${path.basename(pdfPath, path.extname(pdfPath))}-${process.pid}-${Date.now()}.pdf`,
  );
  try {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--allow-file-access-from-files",
      `--user-data-dir=${profileDir}`,
      `--print-to-pdf=${temporaryPdfPath}`,
      "--no-pdf-header-footer",
      pathToFileURL(htmlPath).href,
    ];
    const child = spawn(browser, args, { windowsHide: true, stdio: "ignore" });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (exitCode !== 0) throw new Error(`PDF renderer stopped with exit code ${exitCode}`);
    const pdf = await stat(temporaryPdfPath);
    if (pdf.size < 1_000) throw new Error("The PDF renderer produced an empty file.");
    await rename(temporaryPdfPath, pdfPath);
  } finally {
    const resolvedProfile = path.resolve(profileDir);
    if (resolvedProfile.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      await rm(resolvedProfile, { recursive: true, force: true }).catch(() => {});
    }
    await rm(temporaryPdfPath, { force: true }).catch(() => {});
  }
}

function safeFilename(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 140);
}

async function main() {
  const startedAt = Date.now();
  printHeader();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    line("  Usage: start.bat [EXAM-CODE] [--provider SLUG] [--refresh]");
    line("  With no code, the app prompts for one.");
    return;
  }
  const code = args.code ? validateExamCode(args.code) : await askForCode();
  const cacheKey = `${args.provider ? `${args.provider}-` : ""}${code.toLowerCase()}`;
  const cacheDir = path.join(CACHE_ROOT, cacheKey);
  const outputDir = path.join(OUTPUT_ROOT, code);
  await mkdir(cacheDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  line(`  Gentle mode: one request at a time, at least ${REQUEST_DELAY_MS / 1_000}s apart.`);
  line();

  const data = await runScraper(code, cacheDir, args.refresh, args.provider);
  const incomplete = data.questions.filter((question) => !question.answers?.length || !cleanProse(question.definition?.stemRaw));
  if (incomplete.length) {
    throw new Error(`Refusing an incomplete PDF: ${incomplete.length} question${incomplete.length === 1 ? " is" : "s are"} missing text or answers.`);
  }
  spin(`${phase(3, "PDF")} Formatting the A4 study guide...`);
  const htmlPath = path.join(cacheDir, ".print.html");
  const pdfPath = path.join(outputDir, `${safeFilename(code)}.pdf`);
  await writeFile(htmlPath, buildHtml(data, code), "utf8");
  await renderPdf(htmlPath, pdfPath);
  await rm(htmlPath, { force: true });
  await rm(path.join(cacheDir, "checkpoint.json"), { force: true });
  line(`  ${green("OK")}   ${phase(3, "PDF")} Study guide rendered`);
  line(`  ${green("DONE")} ${data.questions.length} questions | ${duration(Date.now() - startedAt)}`);
  line();
  line(`  ${cyan(pdfPath)}`);
  line("  Your PDF is ready. Open it and start studying.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    clearLive();
    line(`  ${red("ERROR")} ${error.message}`);
    process.exitCode = 1;
  });
}
