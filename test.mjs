import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHtml, parseArgs, renderPdf, validateExamCode } from "./app.mjs";
import {
  completeCachedExam,
  createFetcher,
  deriveAnswers,
  extractExamCatalog,
  extractFlightStream,
  extractTextRecords,
  isConnectionFailure,
  isAllowedHost,
  resolveExam,
  resumeState,
  SOURCE_ORIGIN,
  stripSourceMetadata,
} from "./scraper.mjs";

assert.equal(validateExamCode(" ai-103 "), "AI-103");
assert.throws(() => validateExamCode("AI 103"), /valid exam code/);
assert.deepEqual(parseArgs(["AIF-C01", "--provider", "amazon", "--refresh"]), {
  code: "AIF-C01",
  provider: "amazon",
  refresh: true,
});
assert.throws(() => parseArgs(["AIF-C01", "--provider"]), /requires a provider slug/);
const sourceHost = new URL(SOURCE_ORIGIN).hostname;
assert.equal(isAllowedHost(sourceHost), true);
assert.equal(isAllowedHost(`cdn.${sourceHost}`), true);
assert.equal(isAllowedHost(`${sourceHost}.example.org`), false);
assert.equal(isConnectionFailure(Object.assign(new Error("fetch failed"), {
  cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
})), true);

const flight = '<script>self.__next_f.push([1,"40:T5,hello\\n"])</script>';
assert.equal(extractTextRecords(extractFlightStream(flight)).get("40"), "hello");
const catalog = extractExamCatalog('<a href="/exams/microsoft/ai-103/1">AI-103</a>');
assert.equal(resolveExam(catalog, "AI103").url, `${SOURCE_ORIGIN}/exams/microsoft/ai-103/1`);
const longSlugCatalog = extractExamCatalog(
  '<a href="/exams/amazon/aws-certified-ai-practitioner-aif-c01/1">AWS Certified AI Practitioner AIF-C01</a>',
);
assert.equal(
  resolveExam(longSlugCatalog, "AIF-C01").url,
  `${SOURCE_ORIGIN}/exams/amazon/aws-certified-ai-practitioner-aif-c01/1`,
);
assert.equal(
  resolveExam(longSlugCatalog, `${SOURCE_ORIGIN}/exams/amazon/aws-certified-ai-practitioner-aif-c01/1`).name,
  "aws-certified-ai-practitioner-aif-c01",
);
assert.equal(
  resolveExam([{ provider: "amazon", name: "practice-aif-c01-current", displayName: "AWS AIF-C01 Practice" }], "AIF-C01").name,
  "practice-aif-c01-current",
);
assert.throws(
  () => resolveExam([
    { provider: "amazon", name: "aws-aif-c01", displayName: "AWS AIF-C01" },
    { provider: "other", name: "other-aif-c01", displayName: "Other AIF-C01" },
  ], "AIF-C01"),
  /ambiguous/,
);
assert.match(deriveAnswers({ blanks: [{ label: "Action", answer: "Block" }] })[0], /Action.*Block/);
assert.deepEqual(deriveAnswers({ choices: [{ text: "A", correct: true }, { text: "B" }] }), ["A"]);

const checkpoint = {
  _exam: { provider: "microsoft", name: "az-900" },
  questionCount: 3,
  questions: [{ id: "q1", number: 1 }, { id: "q2", number: 2 }, { id: "q61", number: 61 }],
  _checkpoint: { completedPages: [1, 2], nextDetailRoute: 62 },
};
assert.equal(completeCachedExam(checkpoint, "az-900", "microsoft"), true);
assert.equal(resumeState(checkpoint, { provider: "microsoft", name: "az-900" }).nextDetailRoute, 62);

const longSlugCache = {
  _exam: { provider: "amazon", name: "aws-certified-ai-practitioner-aif-c01" },
  questionCount: 1,
  questions: [{ id: "aif-1", number: 1 }],
};
assert.equal(completeCachedExam(longSlugCache, "AIF-C01", null), true);
assert.equal(completeCachedExam(longSlugCache, "AIF-C01", "microsoft"), false);
assert.equal(completeCachedExam(longSlugCache, "AIF-C02", null), false);
assert.deepEqual(
  stripSourceMetadata({
    source: `${SOURCE_ORIGIN}/exams/amazon/example/1`,
    questions: [{ number: 1, sourceUrl: `${SOURCE_ORIGIN}/exams/amazon/example/q/1`, definition: {} }],
  }),
  { _exam: { provider: "amazon", name: "example" }, questions: [{ number: 1, definition: {} }] },
);

const fetcher = createFetcher({ requestDelayMs: 0 });
await assert.rejects(fetcher("https://example.com/image.png"), /outside the configured source host/);
const originalFetch = globalThis.fetch;
const requestTimes = [];
globalThis.fetch = async (url) => {
  requestTimes.push(Date.now());
  if (String(url).endsWith("/redirect")) {
    return new Response(null, { status: 302, headers: { location: "/final" } });
  }
  return new Response("ok");
};
try {
  const pacingDelayMs = 500;
  const pacedFetcher = createFetcher({ requestDelayMs: pacingDelayMs });
  await pacedFetcher(`${SOURCE_ORIGIN}/redirect`);
  await pacedFetcher(`${SOURCE_ORIGIN}/next`);
  assert.ok(requestTimes[1] - requestTimes[0] < pacingDelayMs * 0.8, "same-site redirect should not pay the pacing delay twice");
  assert.ok(requestTimes[2] - requestTimes[0] >= pacingDelayMs * 0.8, "separate requests should remain paced");
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
try {
  await assert.rejects(fetcher(`${SOURCE_ORIGIN}/exams`), /off-site redirect/);
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async () => {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  throw error;
};
try {
  await assert.rejects(
    fetcher(`${SOURCE_ORIGIN}/exams`, { attempts: 1 }),
    /did not accept a secure connection after 1 attempt/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

const html = buildHtml({
  title: "Sample & Exam",
  provider: "Example",
  imageCount: 1,
  questions: [{
    number: 1,
    topic: "Basics",
    type: "multiple_choice",
    definition: {
      stemRaw: "What is <safe>?",
      choices: [{ label: "A", text: "First" }, { label: "B", text: "Second" }],
      explanation: "Because it is correct.",
      diagram: "assets/q001-1.png",
    },
    answers: ["B - Second"],
  }],
}, "SAMPLE-1");

assert.match(html, /Sample &amp; Exam/);
assert.match(html, /Certification Exam Questions/);
assert.doesNotMatch(html, /Exam study guide|EXAM PDF MAKER|Questions\s+-&gt;\s+Answers/);
assert.match(html, /What is &lt;safe&gt;\?/);
assert.match(html, /assets\/q001-1\.png/);
assert.match(html, /B - Second/);
assert.doesNotMatch(html, /<safe>/);
assert.match(html, /break-inside: avoid-page; page-break-inside: avoid/);
assert.match(html, /question\.style\.zoom/);
assert.match(html, /https:\/\/swarnava\.dev/);
assert.match(html, /github\.com\/swarnava-dutta\/Certification-Exams-Dumps-FREE/);
assert.match(html, /<time class="created">[^<]+<\/time>/);
assert.doesNotMatch(html, /PDF created:/);
assert.doesNotMatch(html, /Question images/);
assert.match(html, /counter\(page\).*counter\(pages\)/s);
assert.match(html, /<a class="owner" href="https:\/\/swarnava\.dev">Swarnava Dutta \(https:\/\/swarnava\.dev\)<\/a>/);
assert.match(html, /\.page-header \{ top: 0;/);
assert.match(html, /\.page-footer \{ bottom: 0;/);
assert.match(html, /\.pdf-content \{ padding: 8mm 0; box-decoration-break: clone;/);

if (process.argv.includes("--pdf")) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "exam-pdf-test-"));
  try {
    const htmlPath = path.join(directory, "sample.html");
    const pdfPath = path.join(directory, "sample.pdf");
    await mkdir(path.join(directory, "assets"));
    await writeFile(
      path.join(directory, "assets", "q001-1.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    );
    await writeFile(htmlPath, html, "utf8");
    await writeFile(pdfPath, "old PDF", "utf8");
    await renderPdf(htmlPath, pdfPath);
    assert.ok((await stat(pdfPath)).size > 1_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log("Offline checks passed.");
