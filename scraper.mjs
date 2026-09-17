import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPT_DIR);
export const SOURCE_ORIGIN = process.env.EXAM_SOURCE_ORIGIN?.trim() || "https://examcademy.com";
const ORIGIN = SOURCE_ORIGIN;
const DIRECTORY_URL = `${ORIGIN}/exams`;
const DEFAULT_EXAM = "AI-103";
const DEFAULT_REQUEST_DELAY_MS = 1_500;
const USER_AGENT = "Mozilla/5.0 (compatible; Exam PDF Maker/1.0; personal study use)";
const ORIGIN_HOST = new URL(ORIGIN).hostname;

export function isAllowedHost(hostname) {
  const host = String(hostname).toLowerCase();
  return host === ORIGIN_HOST || host.endsWith(`.${ORIGIN_HOST}`);
}

export function isConnectionFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  return [
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ETIMEDOUT",
  ].includes(code) || /connect.*(?:timed? ?out|reset|refused)|fetch failed/i.test(error?.cause?.message ?? error?.message ?? "");
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function emit(event, details = {}, stream = process.stdout) {
  stream.write(`${JSON.stringify({ event, ...details })}\n`);
}

function parseArguments(argv) {
  const options = {
    exam: DEFAULT_EXAM,
    provider: null,
    refresh: false,
    skipImages: false,
    outputDir: null,
    requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
  };
  let positionalExam = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--refresh") options.refresh = true;
    else if (argument === "--no-images") options.skipImages = true;
    else if (argument === "--exam" || argument === "--code" || argument === "-e") {
      options.exam = argv[++index];
    } else if (argument === "--provider" || argument === "-p") {
      options.provider = argv[++index];
    } else if (argument === "--output-dir" || argument === "-o") {
      options.outputDir = argv[++index];
    } else if (argument === "--delay-ms") {
      options.requestDelayMs = Number(argv[++index]);
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (positionalExam === null) {
      positionalExam = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (positionalExam !== null) options.exam = positionalExam;
  if (!options.exam) throw new Error("An exam code is required");
  if (options.provider === undefined) throw new Error("--provider requires a provider slug");
  if (options.outputDir === undefined) throw new Error("--output-dir requires a directory");
  if (options.outputDir !== null && !String(options.outputDir).trim()) {
    throw new Error("--output-dir requires a non-empty directory");
  }
  if (!Number.isFinite(options.requestDelayMs) || options.requestDelayMs < 0) {
    throw new Error("--delay-ms must be a non-negative number");
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/scrape.mjs [EXAM-CODE] [options]",
      "",
      `EXAM-CODE defaults to ${DEFAULT_EXAM}. Codes are matched case-insensitively`,
      "against the public exam catalog. A full source exam URL is also accepted.",
      "",
      "Options:",
      "  -e, --exam CODE       Exam code or full source exam URL",
      "  -p, --provider SLUG   Require this provider when a code is ambiguous",
      "      --refresh         Ignore a matching complete questions.json cache",
      "      --no-images       Keep remote image URLs and skip image downloads",
      "  -o, --output-dir DIR  Write questions.json and assets under DIR",
      "      --delay-ms N      Minimum delay between requests (default: 1500)",
      "  -h, --help            Show this help",
      "",
    ].join("\n"),
  );
}

function retryAfterMilliseconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

export function createFetcher({ requestDelayMs = DEFAULT_REQUEST_DELAY_MS } = {}) {
  let nextRequestAt = 0;

  async function waitForTurn() {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await sleep(wait);
    nextRequestAt = Date.now() + requestDelayMs;
  }

  return async function fetchWithRetry(url, options = {}) {
    const target = new URL(url, ORIGIN);
    if (target.protocol !== "https:" || !isAllowedHost(target.hostname)) {
      throw new Error("Refusing to fetch outside the configured source host");
    }
    const attempts = options.attempts ?? 8;
    const accept = options.accept ?? "text/html,application/xhtml+xml,*/*";
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        let response;
        let requestTarget = target;
        await waitForTurn();
        for (let redirects = 0; redirects <= 5; redirects += 1) {
          response = await fetch(requestTarget, {
            redirect: "manual",
            headers: { "user-agent": USER_AGENT, accept },
            signal: AbortSignal.timeout(options.timeoutMs ?? 35_000),
          });
          if (response.status < 300 || response.status >= 400 || !response.headers.get("location")) break;
          const redirected = new URL(response.headers.get("location"), requestTarget);
          if (redirected.protocol !== "https:" || redirected.hostname !== target.hostname) {
            throw new Error("Refusing an off-site redirect");
          }
          requestTarget = redirected;
        }
        if (!response) throw new Error("Too many redirects");

        if (response.status === 429) {
          const wait = retryAfterMilliseconds(response.headers.get("retry-after")) ?? 20_000;
          if (attempt === attempts) throw new Error(`HTTP 429 after ${attempts} attempts`);
          emit("rate_limit", {
            attempt,
            retryAfterMs: wait,
            limit: response.headers.get("x-ratelimit-limit"),
          });
          await sleep(wait + 500);
          continue;
        }

        if (response.status === 408 || response.status >= 500) {
          if (attempt === attempts) throw new Error(`HTTP ${response.status}`);
          const wait = Math.min(15_000, 700 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          emit("retry", { attempt, status: response.status, waitMs: wait });
          await sleep(wait);
          continue;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (error) {
        lastError = error;
        const connectionFailure = isConnectionFailure(error);
        const maxAttempts = connectionFailure ? Math.min(attempts, 3) : attempts;
        if (attempt === maxAttempts || /^HTTP 4\d\d/.test(error.message) || /^Refusing\b/.test(error.message)) break;
        const wait = Math.min(15_000, 700 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        emit("retry", {
          attempt,
          maxAttempts,
          reason: connectionFailure ? "connection" : "temporary",
          error: error?.cause?.message ?? error.message,
          waitMs: wait,
        });
        await sleep(wait);
      }
    }

    if (isConnectionFailure(lastError)) {
      const connectionAttempts = Math.min(attempts, 3);
      throw new Error(
        `The source did not accept a secure connection after ${connectionAttempts} attempt${connectionAttempts === 1 ? "" : "s"}. ` +
        "It is unavailable from this network right now; verify the source in a browser and try again later.",
      );
    }
    throw new Error(`Could not fetch the source page: ${lastError?.message ?? "unknown error"}`);
  };
}

export function extractFlightStream(html) {
  const pieces = [];
  const scripts = /<script(?:\s[^>]*)?>self\.__next_f\.push\((.*?)\)<\/script>/gs;
  for (const match of html.matchAll(scripts)) {
    try {
      const payload = JSON.parse(match[1]);
      if (payload[0] === 1 && typeof payload[1] === "string") pieces.push(payload[1]);
    } catch {
      // Ignore unrelated or non-JSON scripts.
    }
  }
  if (!pieces.length) throw new Error("No Next.js Flight data was found");
  return pieces.join("");
}

export function extractTextRecords(flight) {
  const records = new Map();
  const bytes = Buffer.from(flight, "utf8");
  const marker = /(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/g;
  let match;
  while ((match = marker.exec(flight))) {
    const byteStart = Buffer.byteLength(flight.slice(0, marker.lastIndex), "utf8");
    const byteLength = Number.parseInt(match[2], 16);
    if (!Number.isFinite(byteLength) || byteStart + byteLength > bytes.length) continue;
    records.set(match[1], bytes.subarray(byteStart, byteStart + byteLength).toString("utf8"));
  }
  return records;
}

function readBalancedJson(text, start) {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return null;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function jsonValuesAfter(flight, marker) {
  const values = [];
  let cursor = 0;
  while ((cursor = flight.indexOf(marker, cursor)) !== -1) {
    let start = cursor + marker.length;
    while (/\s/.test(flight[start] ?? "")) start += 1;
    const json = readBalancedJson(flight, start);
    if (json) {
      try {
        values.push(JSON.parse(json));
      } catch {
        // Continue to the next marker if this value is not standalone JSON.
      }
      cursor = start + json.length;
    } else {
      cursor = start;
    }
  }
  return values;
}

const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "\u2026",
  laquo: "\u00ab",
  ldquo: "\u201c",
  lsquo: "\u2018",
  lt: "<",
  mdash: "\u2014",
  nbsp: "\u00a0",
  ndash: "\u2013",
  quot: '"',
  raquo: "\u00bb",
  rdquo: "\u201d",
  rsquo: "\u2019",
};

export function decodeHtmlEntities(value) {
  if (typeof value !== "string" || !value.includes("&")) return value;
  let result = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = result.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, body) => {
      if (body[0] === "#") {
        const hexadecimal = body[1]?.toLowerCase() === "x";
        const number = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        if (!Number.isFinite(number) || number < 0 || number > 0x10ffff) return entity;
        try {
          return String.fromCodePoint(number);
        } catch {
          return entity;
        }
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    });
    if (decoded === result) break;
    result = decoded;
  }
  return result;
}

function decodeEntitiesDeep(value) {
  if (typeof value === "string") return decodeHtmlEntities(value);
  if (Array.isArray(value)) return value.map(decodeEntitiesDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeEntitiesDeep(item)]));
  }
  return value;
}

function stripTags(value) {
  return decodeHtmlEntities(value.replace(/<!--.*?-->/gs, "").replace(/<[^>]*>/g, "")).trim();
}

function examPathParts(url) {
  try {
    const parsed = new URL(url, ORIGIN);
    if (parsed.hostname !== new URL(ORIGIN).hostname) return null;
    const match = parsed.pathname.match(/^\/exams\/([^/]+)\/([^/]+)\/(?:\d+|q\/[^/]+)\/?$/i);
    if (!match) return null;
    return { provider: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function catalogEntry(entry) {
  if (!entry || typeof entry !== "object" || !entry.provider || !entry.name) return null;
  const provider = String(entry.provider);
  const name = String(entry.name);
  return {
    ...entry,
    provider,
    name,
    displayName: entry.displayName ?? entry.nameDisplayName ?? entry.examName ?? entry.title ?? name,
    providerDisplayName: entry.providerDisplayName ?? entry.providerName ?? provider,
    url: `${ORIGIN}/exams/${encodeURIComponent(provider)}/${encodeURIComponent(name)}/1`,
  };
}

export function extractExamCatalog(html) {
  const entries = [];
  try {
    const flight = extractFlightStream(html);
    for (const value of jsonValuesAfter(flight, '"initialExams":')) {
      if (Array.isArray(value)) entries.push(...value.map(catalogEntry).filter(Boolean));
    }
  } catch {
    // The rendered links below are a smaller but durable fallback.
  }

  for (const match of html.matchAll(/href=["']([^"']*\/exams\/([^/"']+)\/([^/"']+)\/1(?:[?#][^"']*)?)["']/gi)) {
    const provider = decodeHtmlEntities(decodeURIComponent(match[2]));
    const name = decodeHtmlEntities(decodeURIComponent(match[3]));
    entries.push(
      catalogEntry({
        provider,
        name,
        url: new URL(decodeHtmlEntities(match[1]), ORIGIN).href,
      }),
    );
  }

  const unique = new Map();
  for (const entry of entries.filter(Boolean)) {
    const key = `${entry.provider.toLowerCase()}/${entry.name.toLowerCase()}`;
    const previous = unique.get(key);
    if (!previous || Object.keys(entry).length > Object.keys(previous).length) unique.set(key, entry);
  }
  return [...unique.values()];
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function collapsed(value) {
  return normalized(value).replace(/[^a-z0-9]+/g, "");
}

function containsDelimitedCode(value, code) {
  const parts = normalized(code).split(/[^a-z0-9]+/).filter(Boolean);
  if (!parts.length) return false;
  const pattern = parts.map(escapedRegex).join("[^a-z0-9]+");
  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, "i").test(normalized(value));
}

export function examNameMatches(candidate, requested) {
  return normalized(candidate) === normalized(requested)
    || collapsed(candidate) === collapsed(requested)
    || containsDelimitedCode(candidate, requested);
}

export function resolveExam(catalog, input, providerInput = null) {
  const urlIdentity = examPathParts(input);
  const wantedName = urlIdentity?.name ?? input;
  const wantedProvider = providerInput ?? urlIdentity?.provider;
  const wantedNormalized = normalized(wantedName);
  const wantedCollapsed = collapsed(wantedName);
  if (!wantedCollapsed) throw new Error("Exam code must contain at least one letter or number");
  const providerFiltered = wantedProvider
    ? catalog.filter((entry) => normalized(entry.provider) === normalized(wantedProvider))
    : catalog;

  const ranked = providerFiltered
    .map((entry) => {
      const names = [
        entry.name,
        entry.code,
        entry.examCode,
        entry.exam_code,
        entry.displayName,
        entry.nameDisplayName,
        entry.examName,
        entry.title,
      ].filter(Boolean);
      let score = -1;
      if (normalized(entry.name) === wantedNormalized) score = 100;
      else if (entry.code && normalized(entry.code) === wantedNormalized) score = 98;
      else if (collapsed(entry.name) === wantedCollapsed) score = 95;
      else if (names.some((name) => normalized(name).startsWith(`${wantedNormalized}:`))) score = 90;
      else if (names.some((name) => collapsed(name).startsWith(wantedCollapsed))) score = 80;
      else if (names.some((name) => containsDelimitedCode(name, wantedName))) score = 75;
      else if (
        wantedCollapsed.length >= 4 &&
        names.some((name) => normalized(name).endsWith(`-${wantedNormalized}`) || collapsed(name).endsWith(wantedCollapsed))
      ) score = 70;
      return { entry, score };
    })
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score);

  if (!ranked.length) {
    const providerNote = wantedProvider ? ` for provider ${wantedProvider}` : "";
    throw new Error(`Exam ${wantedName}${providerNote} was not found in the public catalog`);
  }
  const best = ranked.filter(({ score }) => score === ranked[0].score);
  if (best.length > 1) {
    const candidates = best.map(({ entry }) => `${entry.provider}/${entry.name}`).join(", ");
    throw new Error(`Exam code ${wantedName} is ambiguous (${candidates}); pass --provider`);
  }
  return best[0].entry;
}

export async function discoverExam(input, { provider = null, fetcher = createFetcher() } = {}) {
  const response = await fetcher(DIRECTORY_URL);
  const catalog = extractExamCatalog(await response.text());
  if (!catalog.length) throw new Error("The public exam directory did not contain an exam catalog");
  const exam = resolveExam(catalog, input, provider);
  return { exam, catalogSize: catalog.length };
}

function lastCaptured(text, regex) {
  let value = null;
  for (const match of text.matchAll(regex)) value = match[1];
  return value;
}

function extractRenderedMetadata(html, pageUrl) {
  const metadata = new Map();
  const rows = /<div class="exam-row" id="q-(\d+)"[\s\S]*?<a class="qa-question-heading__link"[^>]*href="([^"]+)"[\s\S]*?<span class="pill accent sm topic-badge">([\s\S]*?)<\/span>/g;
  for (const match of html.matchAll(rows)) {
    metadata.set(Number(match[1]), {
      sourcePath: new URL(decodeHtmlEntities(match[2]), pageUrl).pathname,
      topic: stripTags(match[3]),
    });
  }
  return metadata;
}

function resolveReferences(value, textRecords) {
  if (typeof value === "string") {
    const reference = value.match(/^\$([0-9a-f]+)$/i);
    return reference && textRecords.has(reference[1]) ? textRecords.get(reference[1]) : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, textRecords));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveReferences(item, textRecords)]),
    );
  }
  return value;
}

function readable(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!value || typeof value !== "object") return "";
  return value.text ?? value.label ?? value.name ?? value.value ?? value.content ?? value.answer ?? "";
}

export function deriveAnswers(definition) {
  const answers = [];
  const add = (label, value) => {
    const text = readable(value);
    if (!text) return;
    const cleanLabel = String(label ?? "").replace(/\s*:\s*$/, "");
    answers.push(cleanLabel ? `${cleanLabel} \u2014 ${text}` : text);
  };

  for (const blank of definition.blanks ?? []) add(blank.label ?? `Blank ${blank.id ?? ""}`.trim(), blank.answer);
  const choiceByLabel = new Map(
    (definition.choices ?? [])
      .filter((choice) => choice && typeof choice === "object" && choice.label)
      .map((choice) => [String(choice.label), readable(choice)]),
  );
  for (const answer of definition.answers ?? []) {
    const answerText = readable(answer);
    const choiceText = choiceByLabel.get(answerText);
    add("", choiceText && choiceText !== answerText ? `${answerText} \u2014 ${choiceText}` : answer);
  }
  if (definition.answerText) add("", definition.answerText);

  for (const statement of definition.statements ?? []) {
    add(statement.statement ?? statement.text ?? statement.label ?? "Statement", statement.answer ?? statement.correctAnswer);
  }
  for (const slot of definition.slots ?? []) {
    const value = slot.answer ?? slot.correctAnswer ?? slot.item ?? slot.items;
    if (Array.isArray(value)) value.forEach((item) => add(slot.label ?? slot.name ?? "", item));
    else add(slot.label ?? slot.name ?? "", value);
  }
  for (const column of definition.columns ?? []) {
    if (!column || typeof column !== "object") continue;
    const value = column.answer ?? column.correctAnswer ?? column.items;
    if (Array.isArray(value)) value.forEach((item) => add(column.label ?? column.name ?? "", item));
    else add(column.label ?? column.name ?? "", value);
  }
  for (const choice of definition.choices ?? []) {
    if (choice && typeof choice === "object" && (choice.correct === true || choice.isCorrect === true)) add("", choice);
  }

  return [...new Set(answers)];
}

// Flight rows are newline separated, except after a T record whose payload ends at its byte length.
function flightRows(flight) {
  const bytes = Buffer.from(flight, "utf8");
  const rows = new Map();
  let cursor = 0;
  while (cursor < flight.length) {
    const header = /^([0-9a-f]+):/.exec(flight.slice(cursor, cursor + 24));
    const nextLine = flight.indexOf("\n", cursor) + 1;
    if (!header) {
      if (nextLine <= cursor) return rows;
      cursor = nextLine;
      continue;
    }
    const start = cursor + header[0].length;
    const text = /^T([0-9a-f]+),/.exec(flight.slice(start, start + 12));
    if (text) {
      const payload = start + text[0].length;
      const byteEnd = Buffer.byteLength(flight.slice(0, payload), "utf8") + Number.parseInt(text[1], 16);
      if (byteEnd > bytes.length) return rows;
      cursor = bytes.subarray(0, byteEnd).toString("utf8").length;
    } else {
      const json = readBalancedJson(flight, start);
      if (!json) {
        if (nextLine <= cursor) return rows;
        cursor = nextLine;
        continue;
      }
      rows.set(header[1], json);
      cursor = start + json.length;
    }
    if (flight[cursor] === "\n") cursor += 1;
  }
  return rows;
}

function groupQuestionNumbers(row, rows, depth = 0) {
  const numbers = [...row.matchAll(/"questionNumber":(\d+)/g)].map((match) => Number(match[1]));
  if (depth < 3) {
    for (const reference of row.matchAll(/"\$L([0-9a-f]+)"/g)) {
      const target = rows.get(reference[1]);
      if (target) numbers.push(...groupQuestionNumbers(target, rows, depth + 1));
    }
  }
  return numbers;
}

// Scenario and case-study blocks render as a sibling of the question, not inside its definition.
export function extractQuestionGroups(flight, textRecords = extractTextRecords(flight)) {
  const rows = flightRows(flight);
  const groups = new Map();
  for (const row of rows.values()) {
    if (!row.includes('"exam-content"')) continue;
    const marker = row.indexOf('"group":');
    if (marker === -1) continue;
    const json = readBalancedJson(row, marker + '"group":'.length);
    if (!json) continue;
    let group;
    try {
      group = decodeEntitiesDeep(resolveReferences(JSON.parse(json), textRecords));
    } catch {
      continue;
    }
    if (!group || typeof group.content !== "string" || !group.content.trim()) continue;
    const value = {
      type: String(group.type ?? "scenario"),
      title: String(group.title ?? ""),
      content: group.content,
    };
    for (const number of groupQuestionNumbers(row, rows)) groups.set(number, value);
  }
  return groups;
}

export function parseQuestions(html, pageUrl) {
  const flight = extractFlightStream(html);
  const textRecords = extractTextRecords(flight);
  const groups = extractQuestionGroups(flight, textRecords);
  const renderedMetadata = extractRenderedMetadata(html, pageUrl);
  const questions = [];
  const marker = '"definition":';
  let cursor = 0;

  while ((cursor = flight.indexOf(marker, cursor)) !== -1) {
    const objectStart = cursor + marker.length;
    const objectText = readBalancedJson(flight, objectStart);
    if (!objectText) {
      cursor += marker.length;
      continue;
    }
    try {
      const context = flight.slice(Math.max(0, cursor - 30_000), cursor);
      const number = Number(lastCaptured(context, /"questionNumber":(\d+)/g));
      const id = lastCaptured(context, /"questionId":"([^"]+)"/g);
      const topic = lastCaptured(
        context,
        /"className":"pill accent sm topic-badge","children":"([^"]+)"/g,
      );
      const href = lastCaptured(context, /"href":"(\/exams\/[^"?]+\/q\/[^"]+)"/g);
      if (number && id) {
        const definition = decodeEntitiesDeep(resolveReferences(JSON.parse(objectText), textRecords));
        const group = groups.get(number);
        if (group) definition.group = group;
        const rendered = renderedMetadata.get(number);
        questions.push({
          number,
          id: decodeHtmlEntities(id),
          topic: rendered?.topic ?? decodeHtmlEntities(topic ?? "Other"),
          type: definition.type ?? "question",
          sourcePath: rendered?.sourcePath ?? new URL(href || pageUrl, pageUrl).pathname,
          definition,
          answers: deriveAnswers(definition),
        });
      }
    } catch (error) {
      throw new Error(`Failed to parse a question on ${pageUrl}: ${error.message}`);
    }
    cursor = objectStart + objectText.length;
  }

  return [...new Map(questions.map((question) => [question.id, question])).values()];
}

function declaredQuestionCount(html, catalogExam) {
  const candidates = [
    Number(catalogExam?.questionCount),
    Number(html.match(/with\s+(\d+)\s+community-verified questions/i)?.[1]),
    Number(html.match(/<strong>(\d+)<\/strong>\s*Questions/i)?.[1]),
    Number(html.match(/"questionCount":(\d+)/)?.[1]),
  ].filter((value) => Number.isSafeInteger(value) && value > 0);
  return candidates[0] ?? null;
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declaredPageCount(html, exam, questionCount) {
  const text = stripTags(html);
  const fromText = Number(text.match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1]);
  const prefix = `/exams/${exam.provider}/${exam.name}/`;
  const pagePattern = new RegExp(`href=["']${escapedRegex(prefix)}(\\d+)`, "gi");
  const linked = [...html.matchAll(pagePattern)].map((match) => Number(match[1]));
  const fromLinks = linked.length ? Math.max(...linked) : null;
  const fromCount = questionCount ? Math.ceil(questionCount / 25) : null;
  return Math.max(...[fromText, fromLinks, fromCount, 1].filter(Number.isFinite));
}

function titleFromPage(html, exam) {
  const header = html.match(/<span class="exam-header__name">([\s\S]*?)<\/span>/i)?.[1];
  if (header) return stripTags(header);
  return decodeHtmlEntities(exam.displayName ?? exam.nameDisplayName ?? exam.name);
}

function uniqueQuestions(questions) {
  return [...new Map(questions.map((question) => [question.id, question])).values()]
    .sort((left, right) => left.number - right.number);
}

export function buildPreview(metadata, questions, scrapedAt = new Date().toISOString(), checkpoint = null) {
  return {
    ...metadata,
    scrapedAt,
    questions: uniqueQuestions(questions),
    ...(checkpoint ? { _checkpoint: checkpoint } : {}),
  };
}

function imageUrlsIn(value, baseUrl, output = new Set()) {
  if (typeof value === "string") {
    const candidates = [
      ...value.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g),
      ...value.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi),
      ...value.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g),
    ];
    for (const match of candidates) {
      const candidate = match[1] ?? match[0];
      if (!/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(candidate) && !/\/images?\//i.test(candidate)) continue;
      try {
        output.add(new URL(candidate, baseUrl).href);
      } catch {
        // Ignore malformed URLs embedded in prose.
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => imageUrlsIn(item, baseUrl, output));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => imageUrlsIn(item, baseUrl, output));
  }
  return output;
}

function replaceStrings(value, replacements) {
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of replacements) result = result.split(from).join(to);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replacements)]));
  }
  return value;
}

function extensionFor(url, contentType) {
  const fromType = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
  }[contentType?.split(";")[0].toLowerCase()];
  if (fromType) return fromType;
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.(?:avif|gif|jpe?g|png|svg|webp)$/.test(fromUrl) ? fromUrl : ".img";
}

async function atomicWrite(filename, data, encoding) {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data, encoding);
  try {
    await rename(temporary, filename);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await rm(filename, { force: true });
    await rename(temporary, filename);
  }
}

async function localizeImages(questions, fetcher, outputDir) {
  const assetsDir = path.join(outputDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const replacements = new Map();
  const targets = [];
  const seen = new Set();
  for (const question of questions) {
    for (const url of imageUrlsIn(question.definition, new URL(question.sourcePath || "/", ORIGIN))) {
      if (seen.has(url)) continue;
      seen.add(url);
      targets.push({ question: question.number, url });
    }
  }
  emit("images_started", { total: targets.length });
  let imageNumber = 0;
  let processed = 0;
  let saved = 0;
  let reused = 0;
  let skipped = 0;

  for (const target of targets) {
    const { url } = target;
    try {
      const imageUrl = new URL(url);
      if (imageUrl.protocol !== "https:" || !isAllowedHost(imageUrl.hostname)) {
        skipped += 1;
        emit("image_skipped", { question: target.question, reason: "off-site image" });
        continue;
      }
      const imageNumberForUrl = imageNumber + 1;
      const extension = extensionFor(url, null);
      const reusableName = `q${String(target.question).padStart(3, "0")}-${imageNumberForUrl}${extension}`;
      try {
        if ((await readFile(path.join(assetsDir, reusableName))).length > 0) {
          imageNumber = imageNumberForUrl;
          reused += 1;
          replacements.set(url, `assets/${reusableName}`);
          emit("image_reused", { question: target.question, index: imageNumber, file: `assets/${reusableName}` });
          continue;
        }
      } catch {
        // Download a missing or unreadable checkpointed image again.
      }
      const response = await fetcher(url, { accept: "image/avif,image/webp,image/png,image/jpeg,image/svg+xml,*/*" });
      const contentType = response.headers.get("content-type");
      if (!contentType?.toLowerCase().startsWith("image/")) {
        skipped += 1;
        emit("image_skipped", { question: target.question, contentType });
        continue;
      }
      imageNumber = imageNumberForUrl;
      const filename = `q${String(target.question).padStart(3, "0")}-${imageNumber}${extensionFor(url, contentType)}`;
      await atomicWrite(path.join(assetsDir, filename), Buffer.from(await response.arrayBuffer()));
      replacements.set(url, `assets/${filename}`);
      saved += 1;
      emit("image_saved", { question: target.question, index: imageNumber, file: `assets/${filename}` });
    } finally {
      processed += 1;
      emit("image_progress", { processed, total: targets.length, saved, reused, skipped });
    }
  }

  for (const question of questions) {
    question.definition = replaceStrings(question.definition, replacements);
    question.answers = deriveAnswers(question.definition);
  }
  return replacements.size;
}

function storedExamIdentity(cache) {
  if (cache?._exam?.provider && cache?._exam?.name) {
    return { provider: String(cache._exam.provider), name: String(cache._exam.name) };
  }
  return examPathParts(cache?.source);
}

function normalizeQuestionSource(question) {
  if (question?.sourcePath || !question?.sourceUrl) return question;
  try {
    return { ...question, sourcePath: new URL(question.sourceUrl, ORIGIN).pathname };
  } catch {
    return question;
  }
}

export function stripSourceMetadata(data) {
  const identity = storedExamIdentity(data);
  const { source, ...rest } = data ?? {};
  return {
    ...rest,
    ...(identity ? { _exam: identity } : {}),
    questions: Array.isArray(rest.questions)
      ? rest.questions.map((question) => {
        const { sourceUrl, sourcePath, ...portable } = question;
        return portable;
      })
      : rest.questions,
  };
}

export function completeCachedExam(cache, requestedExam, provider) {
  if (!cache || !Array.isArray(cache.questions) || cache.questions.length !== cache.questionCount) return false;
  if (Number(cache.declaredQuestionCount) > cache.questionCount) return false;
  const numbers = new Set(cache.questions.map((question) => question.number));
  const ids = new Set(cache.questions.map((question) => question.id));
  if (numbers.size !== cache.questionCount || ids.size !== cache.questionCount) return false;
  const identity = storedExamIdentity(cache);
  if (!identity) return false;
  if (provider && normalized(identity.provider) !== normalized(provider)) return false;
  return examNameMatches(identity.name, requestedExam);
}

async function readCache(outputDir) {
  try {
    return JSON.parse(await readFile(path.join(outputDir, "questions.json"), "utf8"));
  } catch {
    return null;
  }
}

async function readJsonFile(filename) {
  if (!filename) return null;
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return null;
  }
}

export function resumeState(cache, exam) {
  if (!cache || !Array.isArray(cache.questions)) return null;
  const identity = storedExamIdentity(cache);
  if (!identity || normalized(identity.provider) !== normalized(exam.provider)) return null;
  if (normalized(identity.name) !== normalized(exam.name)) return null;
  const completedPages = Array.isArray(cache._checkpoint?.completedPages)
    ? cache._checkpoint.completedPages.filter((page) => Number.isInteger(page) && page > 0)
    : [];
  const knownNumbers = new Set(cache.questions.map((question) => question.number));
  let firstMissing = 1;
  while (knownNumbers.has(firstMissing)) firstMissing += 1;
  const savedRoute = Number(cache._checkpoint?.nextDetailRoute);
  return {
    preview: cache,
    questions: uniqueQuestions(cache.questions.map(normalizeQuestionSource)),
    completedPages: new Set(completedPages),
    nextDetailRoute: Number.isInteger(savedRoute) && savedRoute > 0 ? savedRoute : firstMissing,
  };
}

export async function scrape(options) {
  const settings = {
    exam: DEFAULT_EXAM,
    provider: null,
    refresh: false,
    skipImages: false,
    outputDir: null,
    requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
    ...options,
  };
  const outputDir = settings.outputDir ? path.resolve(settings.outputDir) : ROOT;
  const jobMode = Boolean(settings.outputDir);
  await mkdir(outputDir, { recursive: true });
  const cached = await readCache(outputDir);
  const inputIdentity = examPathParts(settings.exam);
  const requestedName = inputIdentity?.name ?? settings.exam;
  const requestedProvider = settings.provider ?? inputIdentity?.provider ?? null;

  if (!settings.refresh && completeCachedExam(cached, requestedName, requestedProvider)) {
    const portableCache = stripSourceMetadata(cached);
    await atomicWrite(path.join(outputDir, "questions.json"), `${JSON.stringify(portableCache, null, 2)}\n`, "utf8");
    emit("cache_reused", {
      exam: requestedName,
      questions: cached.questionCount,
      images: cached.imageCount ?? null,
    });
    return portableCache;
  }

  const fetcher = createFetcher({ requestDelayMs: settings.requestDelayMs });
  const previewFile = process.env.EXAM_PREVIEW_FILE?.trim();
  const savedPreview = settings.refresh ? null : await readJsonFile(previewFile);
  const savedIdentity = storedExamIdentity(savedPreview);
  const canResume = Boolean(
    savedIdentity &&
    Array.isArray(savedPreview?.questions) && savedPreview.questions.length > 0 &&
    examNameMatches(savedIdentity.name, requestedName) &&
    (!requestedProvider || normalized(savedIdentity.provider) === normalized(requestedProvider)),
  );
  let exam;

  if (canResume) {
    exam = {
      provider: savedIdentity.provider,
      name: savedIdentity.name,
      providerDisplayName: savedPreview.provider ?? savedIdentity.provider,
      displayName: savedPreview.title ?? savedIdentity.name,
      questionCount: Number(savedPreview.questionCount) || null,
      url: `${ORIGIN}/exams/${encodeURIComponent(savedIdentity.provider)}/${encodeURIComponent(savedIdentity.name)}/1`,
    };
    emit("checkpoint_reused", {
      exam: exam.name,
      provider: exam.provider,
      title: exam.displayName,
      fetched: savedPreview.questions.length,
      questionCount: exam.questionCount,
    });
  } else {
    emit("discovery_started", { query: settings.exam, provider: requestedProvider });
    const discovered = await discoverExam(settings.exam, {
      provider: requestedProvider,
      fetcher,
    });
    exam = discovered.exam;
    emit("exam_discovered", {
      query: settings.exam,
      catalogSize: discovered.catalogSize,
      provider: exam.provider,
      providerDisplayName: exam.providerDisplayName ?? exam.provider,
      exam: exam.name,
      title: exam.displayName ?? exam.nameDisplayName ?? exam.name,
      questionCount: exam.questionCount,
    });
  }

  const examBase = `${ORIGIN}/exams/${encodeURIComponent(exam.provider)}/${encodeURIComponent(exam.name)}`;
  const resumed = resumeState(savedPreview, exam);
  const allQuestions = resumed?.questions ?? [];
  const completedPages = resumed?.completedPages ?? new Set();
  let nextDetailRoute = resumed?.nextDetailRoute ?? 1;
  let firstResponse = null;
  let firstHtml = null;
  let questionCount = Number(resumed?.preview.questionCount ?? exam.questionCount);
  let pageCount = Number(resumed?.preview.pages);
  let title = resumed?.preview.title;

  if (!completedPages.has(1) || !questionCount || !pageCount || !title) {
    firstResponse = await fetcher(exam.url);
    firstHtml = await firstResponse.text();
    questionCount = declaredQuestionCount(firstHtml, exam);
    if (!questionCount) throw new Error("The source did not declare a positive question count");
    pageCount = declaredPageCount(firstHtml, exam, questionCount);
    title = titleFromPage(firstHtml, exam);
  }

  const previewBase = {
    title,
    provider: decodeHtmlEntities(exam.providerDisplayName ?? exam.provider),
    _exam: { provider: exam.provider, name: exam.name },
    pages: pageCount,
    questionCount,
    imageCount: 0,
  };
  emit("exam_metadata", {
    exam: exam.name,
    title,
    provider: previewBase.provider,
    questionCount,
    pages: pageCount,
    fetched: uniqueQuestions(allQuestions).length,
  });
  const writePreview = async () => {
    if (!previewFile || !allQuestions.length) return;
    await mkdir(path.dirname(previewFile), { recursive: true });
    await atomicWrite(
      previewFile,
      `${JSON.stringify(buildPreview(previewBase, allQuestions, new Date().toISOString(), {
        completedPages: [...completedPages].sort((left, right) => left - right),
        nextDetailRoute,
      }))}\n`,
      "utf8",
    );
  };

  for (let page = 1; page <= pageCount; page += 1) {
    if (completedPages.has(page)) continue;
    const url = `${examBase}/${page}`;
    let html;
    let finalUrl;
    if (page === 1 && firstHtml !== null && firstResponse !== null) {
      html = firstHtml;
      finalUrl = firstResponse.url;
    } else {
      const response = await fetcher(url);
      html = await response.text();
      finalUrl = response.url;
    }
    const parsed = parseQuestions(html, finalUrl);
    allQuestions.push(...parsed);
    if (parsed.length) completedPages.add(page);
    await writePreview();
    emit("page_parsed", {
      page,
      pages: pageCount,
      questions: parsed.length,
      fetched: uniqueQuestions(allQuestions).length,
      questionNumbers: parsed.map((question) => question.number),
    });
    if (page > 1 && parsed.length === 0) {
      for (let remaining = page; remaining <= pageCount; remaining += 1) completedPages.add(remaining);
      await writePreview();
      emit("listing_fallback_started", { page, pages: pageCount, fetched: uniqueQuestions(allQuestions).length });
      break;
    }
  }

  if (!resumed) {
    const foundNumbers = new Set(allQuestions.map((question) => question.number));
    while (foundNumbers.has(nextDetailRoute)) nextDetailRoute += 1;
  }
  let fetched = uniqueQuestions(allQuestions).length;
  const missing = Math.max(0, questionCount - fetched);
  if (missing) emit("detail_fallback_started", { missing, fetched });
  let recovered = 0;
  let consecutiveMisses = 0;

  while (fetched < questionCount && consecutiveMisses < 25) {
    const routeNumber = nextDetailRoute;
    nextDetailRoute += 1;
    try {
      const response = await fetcher(`${examBase}/q/${routeNumber}`);
      const html = await response.text();
      const parsed = parseQuestions(html, response.url).map((question) => ({
        ...question,
        sourcePath: new URL(response.url).pathname,
      }));
      const before = fetched;
      allQuestions.push(...parsed);
      fetched = uniqueQuestions(allQuestions).length;
      if (fetched > before) {
        recovered += fetched - before;
        consecutiveMisses = 0;
      } else {
        consecutiveMisses += 1;
      }
      if (fetched > before) {
        emit("detail_fallback_progress", {
          recovered,
          missing,
          question: parsed.at(-1)?.number ?? routeNumber,
          fetched,
        });
      }
    } catch (error) {
      if (!/HTTP 404\b/.test(error?.message ?? "")) throw error;
      consecutiveMisses += 1;
      emit("detail_skipped", { route: routeNumber, reason: "HTTP 404" });
    }
    await writePreview();
  }

  const questions = uniqueQuestions(allQuestions);
  if (!questions.length) throw new Error("The source did not return any questions");
  if (questions.length < questionCount) {
    throw new Error(`Expected ${questionCount} questions but fetched ${questions.length}; checkpoint saved`);
  }

  if (settings.skipImages) emit("images_started", { total: 0 });
  const imageCount = settings.skipImages ? 0 : await localizeImages(questions, fetcher, outputDir);
  const output = stripSourceMetadata({
    title,
    provider: decodeHtmlEntities(exam.providerDisplayName ?? exam.provider),
    _exam: { provider: exam.provider, name: exam.name },
    pages: pageCount,
    questionCount: questions.length,
    imageCount,
    scrapedAt: new Date().toISOString(),
    questions,
  });
  const json = JSON.stringify(output, null, 2);
  await atomicWrite(path.join(outputDir, "questions.json"), `${json}\n`, "utf8");
  if (!jobMode) {
    await atomicWrite(
      path.join(outputDir, "questions.js"),
      `window.EXAM_DATA = ${JSON.stringify(output).replaceAll("<", "\\u003c")};\n`,
      "utf8",
    );
  }
  emit("saved", {
    exam: exam.name,
    provider: exam.provider,
    questions: questions.length,
    images: imageCount,
    outputDir,
    files: jobMode ? ["questions.json"] : ["questions.json", "questions.js"],
  });
  return output;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await scrape(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    emit("fatal", { error: error.message }, process.stderr);
    process.exitCode = 1;
  });
}
