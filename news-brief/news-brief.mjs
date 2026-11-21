// Daily news brief: headlines -> Gemini summary -> fact check -> 1080x1350 JPEG slides -> queued post.
// Runs in GitHub Actions (.github/workflows/news-brief.yml). Needs:
//   secrets  GEMINI_API_KEY, IWT_SECRET (iwt.secrets.cron_secret)
//   variable GEMINI_MODEL (a Gemini model id from Google AI Studio)
// If anything fails, nothing is posted and the reason is reported to the dashboard.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";

const FN_URL = "https://hrekooheseafvocxaquy.supabase.co/functions/v1/iwt-social";
const STORIES = 5;

// ---- Function calls --------------------------------------------------------
async function fn(body) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-iwt-secret": need("IWT_SECRET") },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Function ${body.action}: ${j.error ?? "HTTP " + res.status}`);
  return j;
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Add it in GitHub: Settings > Secrets and variables > Actions.`);
  return v;
}

export function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ---- Gemini ----------------------------------------------------------------
function prompt(headlines) {
  const list = headlines.map((h, i) => `[${i}] (${h.source}) ${h.title}\n    ${h.summary}`).join("\n");
  return `You write a morning market news brief for an Instagram carousel for US retail investors.

Pick the ${STORIES} most market-relevant, distinct stories from the numbered headlines below.
Prefer company news, deals, earnings, markets and the economy. Skip personal-finance advice pieces and opinion.

Hard rules:
- Use ONLY facts stated in the headlines and summaries below. No outside knowledge, no background from memory.
- Every number you write must appear in the cited sources. Do not convert or round numbers.
- Neutral and factual. No advice, no predictions, no hype words.
- English.

Return JSON only, in this shape:
{"stories":[{"sources":[<numbers of the headlines used>],
  "big":"<the key figure or company name, max 14 characters, copied from the sources>",
  "headline":"<max 60 characters>",
  "body":"<2 or 3 short sentences, max 300 characters. Wrap the 2-4 most important facts in **double asterisks**>"}]}

Headlines:
${list}`;
}

async function gemini(text) {
  const model = need("GEMINI_MODEL");
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": need("GEMINI_API_KEY") },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) {
    const list = await fetch(`${base}/models`, { headers: { "x-goog-api-key": need("GEMINI_API_KEY") } }).then((r) => r.json());
    const names = (list.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    throw new Error(`Gemini model "${model}" not found. Set GEMINI_MODEL to one of: ${names.join(", ")}`);
  }
  if (!res.ok) throw new Error(`Gemini: ${j.error?.message ?? "HTTP " + res.status}`);
  const out = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!out) throw new Error(`Gemini returned no text (finish reason: ${j.candidates?.[0]?.finishReason ?? "none"})`);
  return JSON.parse(out);
}

// ---- Fact check ------------------------------------------------------------
// Every number in a story must appear as a number in its cited sources, and the big
// label must appear in them word for word (ignoring case).
const numbers = (s) => (String(s).replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);

export function check(brief, headlines) {
  const stories = brief?.stories;
  if (!Array.isArray(stories) || stories.length !== STORIES) throw new Error(`Expected ${STORIES} stories, got ${stories?.length}`);
  const used = new Set();
  stories.forEach((s, n) => {
    const where = `Story ${n + 1}`;
    if (!Array.isArray(s.sources) || !s.sources.length) throw new Error(`${where}: no sources cited`);
    const src = s.sources.map((i) => {
      const h = headlines[i];
      if (!h) throw new Error(`${where}: cites headline [${i}], which does not exist`);
      if (used.has(i)) throw new Error(`${where}: headline [${i}] is used twice`);
      used.add(i);
      return `${h.title} ${h.summary}`;
    }).join(" ");
    for (const f of ["big", "headline", "body"]) if (typeof s[f] !== "string" || !s[f].trim()) throw new Error(`${where}: ${f} is empty`);
    if (s.big.length > 14) throw new Error(`${where}: big label "${s.big}" is longer than 14 characters`);
    if (s.headline.length > 60) throw new Error(`${where}: headline is longer than 60 characters`);
    if (s.body.replace(/\*\*/g, "").length > 300) throw new Error(`${where}: body is longer than 300 characters`);
    const have = new Set(numbers(src));
    for (const x of numbers(`${s.big} ${s.headline} ${s.body}`)) {
      if (!have.has(x)) throw new Error(`${where}: the number ${x} is not in its sources`);
    }
    if (!/\d/.test(s.big) && !src.toLowerCase().includes(s.big.toLowerCase())) {
      throw new Error(`${where}: big label "${s.big}" is not in its sources`);
    }
  });
}

// ---- Slides ----------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

function longDate(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}
function shortDate(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

const CSS = `
* { box-sizing: border-box; margin: 0; }
body { width: 1080px; height: 1350px; overflow: hidden; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }
.slide { width: 1080px; height: 1350px; position: relative; display: flex; flex-direction: column; background: #0B1011; }
.chip { display: inline-block; background: #23F2AF; color: #051A12; font-weight: 800; font-size: 34px; letter-spacing: -0.01em; padding: 8px 18px; }
.bars { display: block; }
.bars span { display: inline; background: #23F2AF; color: #051A12; font-weight: 800; letter-spacing: -0.02em; padding: 0 22px 6px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.brand { display: flex; align-items: center; justify-content: center; gap: 14px; font-weight: 700; font-size: 26px; letter-spacing: 0.28em; }
.brand i { width: 12px; height: 12px; border-radius: 50%; background: #23F2AF; display: block; }
.dots { display: flex; gap: 6px; }
.grid { position: absolute; inset: 0; background-image: linear-gradient(#152420 1px, transparent 1px), linear-gradient(90deg, #152420 1px, transparent 1px); background-size: 60px 60px; opacity: 0.6; }

/* Cover */
.cover { justify-content: center; align-items: center; text-align: center; color: #F7FBF8; }
.cover .inner { position: relative; display: flex; flex-direction: column; align-items: center; gap: 26px; }
.cover .bars { text-align: center; }
.cover .bars span { font-size: 132px; line-height: 1.22; }
.cover .lead { font-size: 34px; color: #A0B4AE; font-weight: 500; margin-top: 8px; }
.cover .list { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 900px; margin-top: 18px; }
.cover .list span { font-family: "JetBrains Mono", monospace; font-size: 30px; color: #6DFFD1; border: 2px solid #253C34; padding: 6px 16px; }
.cover .brand { position: absolute; bottom: 64px; left: 0; right: 0; color: #F7FBF8; }

/* Story */
.top { height: 600px; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.top .big { position: relative; font-family: "JetBrains Mono", monospace; font-weight: 700; color: #23F2AF; font-size: 150px; letter-spacing: -0.04em; white-space: nowrap; }
.top .src { position: absolute; top: 34px; left: 40px; background: #000; color: #fff; font-size: 22px; font-weight: 700; padding: 6px 12px; }
.mid { position: absolute; top: 470px; left: 56px; right: 56px; display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }
.mid .bars span { font-size: 66px; line-height: 1.3; }
.bottom { flex: 1; min-height: 0; overflow: hidden; background: #F7FBF8; color: #0B1011; padding: 0 64px 56px; display: flex; flex-direction: column; justify-content: space-between; }
.bottom .body { font-size: 46px; line-height: 1.42; font-weight: 400; }
.bottom .body b { font-weight: 800; }
.bottom .brand { color: #0B1011; margin-top: 44px; }
`;

const fonts = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@700&display=block">`;
const brand = `<div class="brand"><span class="dots"><i></i><i></i><i></i></span>INSIDER WHALE TERMINAL</div>`;
const page = (inner) => `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>${CSS}</style></head><body>${inner}</body></html>`;

export function coverHtml(date, stories) {
  return page(`<div class="slide cover"><div class="grid"></div><div class="inner">
    <span class="chip">${esc(shortDate(date))}</span>
    <div class="bars"><span>Morning</span><br><span>Brief</span></div>
    <div class="lead">${STORIES} stories moving markets today · swipe</div>
    <div class="list">${stories.map((s) => `<span>${esc(s.big)}</span>`).join("")}</div>
  </div>${brand}</div>`);
}

export function storyHtml(date, s, sourceNames) {
  return page(`<div class="slide">
    <div class="top"><div class="grid"></div><div class="big">${esc(s.big)}</div><div class="src">Source: ${esc(sourceNames)}</div></div>
    <div class="mid"><span class="chip">${esc(shortDate(date))}</span><div class="bars"><span>${esc(s.headline)}</span></div></div>
    <div class="bottom"><div class="body">${rich(s.body)}</div>${brand}</div>
  </div>`);
}

export async function render(htmls) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
    const out = [];
    for (const html of htmls) {
      await page.setContent(html, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      // Shrink a big label or headline that would overflow its box.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll(".top .big")) {
          let size = 150;
          while (el.scrollWidth > 980 && size > 60) { size -= 6; el.style.fontSize = size + "px"; }
        }
        const mid = document.querySelector(".mid .bars span");
        if (mid) {
          let size = 66;
          while (document.querySelector(".mid").getBoundingClientRect().bottom > 760 && size > 40) { size -= 4; mid.style.fontSize = size + "px"; }
        }
        // The headline bars overlap the top of the white panel; the body starts below them.
        const bottom = document.querySelector(".bottom"), body = document.querySelector(".bottom .body");
        if (bottom) {
          const start = document.querySelector(".mid").getBoundingClientRect().bottom - bottom.getBoundingClientRect().top + 28;
          bottom.style.paddingTop = start + "px";
          let size = 46;
          const over = () => bottom.scrollHeight > bottom.clientHeight;
          while (over() && size > 30) { size -= 2; body.style.fontSize = size + "px"; }
          if (over()) throw new Error("Slide text does not fit");
        }
      });
      out.push(await page.screenshot({ type: "jpeg", quality: 92 }));
    }
    return out;
  } finally {
    await browser.close();
  }
}

// ---- Caption ---------------------------------------------------------------
export function caption(date, stories, sources) {
  const lines = stories.map((s) => `➡️ ${s.headline}`).join("\n");
  return `Morning Brief · ${longDate(date)} ☕\n\n${STORIES} stories moving markets today:\n\n${lines}\n\n` +
    `Sources: ${sources.join(", ")}. Summaries in our own words. Not financial advice.\n\n` +
    `#stockmarket #investing #marketnews #wallstreet #stocks`;
}

// ---- Main ------------------------------------------------------------------
async function main() {
  const date = nyDate();
  const { exists, headlines } = await fn({ action: "news_headlines", news_date: date });
  if (exists) { console.log(`A news brief for ${date} already exists. Nothing to do.`); return; }
  if (headlines.length < 10) throw new Error(`Only ${headlines.length} headlines in the last 24 hours, need at least 10`);
  headlines.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  console.log(`${date}: ${headlines.length} headlines`);

  // Two tries: the second one is told why the first failed the fact check.
  let brief, problem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = prompt(headlines) + (problem ? `\n\nYour previous answer was rejected: ${problem}. Fix that.` : "");
    try {
      brief = await gemini(text);
      check(brief, headlines);
      problem = "";
      break;
    } catch (e) {
      if (/^Gemini/.test(e.message)) throw e; // API problem, not a content problem
      problem = e.message;
      console.log(`Attempt ${attempt} rejected: ${problem}`);
    }
  }
  if (problem) throw new Error(`Fact check failed twice. Last reason: ${problem}`);

  const srcNames = (s) => [...new Set(s.sources.map((i) => headlines[i].source))].join(", ");
  const allSources = [...new Set(brief.stories.flatMap((s) => s.sources.map((i) => headlines[i].source)))];
  const jpgs = await render([coverHtml(date, brief.stories), ...brief.stories.map((s) => storyHtml(date, s, srcNames(s)))]);

  const folder = `news/${date}-${Date.now().toString(36)}`;
  const media = [];
  for (const [i, jpg] of jpgs.entries()) {
    const { signedUrl, publicUrl } = await fn({ action: "sign_upload", path: `${folder}/${String(i + 1).padStart(2, "0")}.jpg` });
    const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: jpg });
    if (!put.ok) throw new Error(`Upload of slide ${i + 1} failed: HTTP ${put.status} ${await put.text()}`);
    media.push(publicUrl);
  }

  const evidence = brief.stories.map((s, n) => `${n + 1}. ` + s.sources.map((i) => headlines[i].link).join(" ")).join("\n");
  const row = await fn({
    action: "add_news", news_date: date, media, evidence_note: evidence,
    title: `N · Morning Brief ${shortDate(date)}`, caption: caption(date, brief.stories, allSources),
  });
  console.log(`Queued news brief ${row.id} for ${date} with ${media.length} slides.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    console.error(e.message);
    await fn({ action: "news_failed", news_date: nyDate(), error: e.message }).catch((r) => console.error(`Could not report to the dashboard: ${r.message}`));
    process.exit(1);
  });
}
