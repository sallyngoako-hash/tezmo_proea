import { getStore } from "../lib/store.js";
import { sha, accessStore, checkAccess } from "../lib/auth.js";

/*
  TEZMO research feed.  Deploy as api/research.js
  Searches the live web ONCE per event on your server and shares the result with every approved buyer,
  so buyers never need a search-enabled AI key and your search allowance is spent only a few times a day.
  Vercel environment variables:
    TAVILY_KEY        your key from tavily.com (free plan)
  Optional:
    SEARCH_PER_DAY    maximum searches per day for the whole site (default 150)
    RESEARCH_PER_HOUR requests per buyer per hour (default 40, cached answers are cheap)
*/
const env = (k, d = "") => process.env[k] || d;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,OPTIONS" };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const TAGS = ["NFP", "CPI", "PPI", "PMI", "FOMC", "USOPEN"];

const NAMES = { NFP: "nonfarm payrolls", CPI: "CPI inflation", PPI: "PPI producer prices", PMI: "ISM PMI", FOMC: "FOMC Fed interest rate decision" };
function queriesPost(tag, D) {
  const n = NAMES[tag] || tag;
  return [`${n} ${D} actual result released vs forecast`, `${n} ${D} beats expectations or misses expectations`, `${n} ${D} actual previous forecast data released`, `gold price reaction after ${n} release ${D}`, `dollar index Treasury yields reaction after ${n} ${D}`, `${n} ${D} report details breakdown`].map((q) => ({ q, news: true }));
}
function queries(tag, D) {
  if (tag === "USOPEN") {
    const h = [`US stock futures premarket today S&P 500 Nasdaq Dow`, `stock market today what to watch before the open ${D}`, `premarket movers earnings today Wall Street`, `Wall Street overnight Asia Europe markets today`, `economic data schedule today Fed speakers ${D}`, `Treasury yields dollar oil gold moving stocks today`, `stock market outlook analysts expect open today`, `VIX volatility today stocks`, `Wall Street close recap yesterday S&P 500 Nasdaq Dow`];
    return h.map((q) => ({ q, news: true })).concat([{ q: `Fed rate cut odds CME FedWatch this week`, news: true }]);
  }
  const head = {
    NFP: [`nonfarm payrolls ${D} forecast economists expect`, `jobs report preview unemployment rate average hourly earnings ${D}`, `ADP private payrolls latest report`, `initial jobless claims latest week`, `JOLTS job openings ISM employment index latest`, `previous nonfarm payrolls revision last report`],
    CPI: [`CPI report ${D} forecast economists expect core CPI`, `CPI preview ${D} shelter used cars gasoline`, `Cleveland Fed inflation nowcast`, `PPI import prices latest report inflation`, `tariffs inflation pass-through latest`, `previous CPI report core inflation last month`],
    PPI: [`PPI report ${D} forecast economists expect core PPI`, `latest CPI report core inflation`, `import prices latest report`, `ISM prices paid index latest`, `producer prices energy commodity costs this month`, `previous PPI report revision last month`],
    PMI: [`PMI ${D} forecast economists expect ISM`, `ISM manufacturing services PMI previous reading new orders employment prices`, `Empire State Philadelphia Fed manufacturing survey latest`, `S&P Global flash PMI United States latest`, `jobless claims consumer spending latest`, `previous ISM PMI report details`],
    FOMC: [`FOMC decision ${D} expectations rate`, `CME FedWatch probabilities this meeting`, `Fed dot plot last meeting statement minutes`, `latest CPI PCE jobs data Fed outlook`, `Fed officials comments inflation labor market this week`, `FOMC dissent expectations press conference preview`],
  }[tag];
  const tail = [`Fed rate cut odds CME FedWatch this week`, `gold price outlook ahead of ${tag} release`, `10-year Treasury yield dollar index DXY today`, `how gold reacted to last ${tag} release`];
  return head.map((q) => ({ q, news: !/^previous/.test(q) })).concat(tail.map((q) => ({ q, news: !/^how gold/.test(q) })));
}

async function tav(q, news, signal, range) {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env("TAVILY_KEY") },
    body: JSON.stringify({ query: q, topic: news ? "news" : "general", search_depth: "basic", max_results: 4, include_answer: false, time_range: range || (news ? "week" : "month") }),
    signal,
  });
  if (!r.ok) { const e = new Error("search " + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return (j.results || []).map((x) => ({ title: String(x.title || "").slice(0, 140), url: String(x.url || ""), text: String(x.content || "").replace(/\s+/g, " ").slice(0, 420), pub: String(x.published_date || "").slice(0, 25) }));
}

const inflight = new Map();

async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ ok: false, reason: "method" }, 405);
  let b; try { b = await req.json(); } catch (e) { return J({ ok: false, reason: "bad" }, 400); }

  const email = String(b.email || "").trim().toLowerCase(), device = String(b.device || "");
  const ac = await checkAccess(accessStore(), email, device, "");
  if (!ac.ok) return J({ ok: false, reason: "access" }, 401);

  const tag = String(b.tag || ""), date = String(b.date || ""), t = Number(b.t);
  if (!TAGS.includes(tag) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(t) || Math.abs(t - Date.now()) > 3 * 864e5) return J({ ok: false, reason: "bad" }, 400);
  if (!env("TAVILY_KEY")) return J({ ok: false, reason: "not_configured" }, 503);

  const store = getStore({ name: "research", consistency: "strong" });
  const hk = "h:" + sha(email).slice(0, 16) + ":" + Math.floor(Date.now() / 36e5);
  const rl = (await store.get(hk, { type: "json" })) || { n: 0 };
  if (rl.n >= parseInt(env("RESEARCH_PER_HOUR", "40"), 10)) return J({ ok: false, reason: "busy" }, 429);
  rl.n++; await store.setJSON(hk, rl);

  const post = b.phase === "post" && tag !== "USOPEN";
  const key = (post ? "r:" : "s:") + tag + ":" + date, now = Date.now();
  const cached = await store.get(key, { type: "json" });
  const ttl = post ? 150e3 : (tag === "USOPEN" ? (t - now < 90 * 6e4 ? 15 : 45) : (t - now < 45 * 6e4 ? 12 : 60)) * 6e4;               /* refresh more often close to the release */
  const minAge = post ? 90e3 : 15 * 6e4;                                          /* a manual refresh can never search more than every 15 minutes */
  if (cached && now - cached.at < (b.force ? minAge : ttl)) return J({ ok: true, ...cached, shared: true });

  /* site-wide daily search budget */
  const dk = "d:" + new Date().toISOString().slice(0, 10);
  const day = (await store.get(dk, { type: "json" })) || { n: 0 };
  const cap = parseInt(env("SEARCH_PER_DAY", "150"), 10);
  if (day.n + 10 > cap && !post) return cached ? J({ ok: true, ...cached, shared: true, stale: true }) : J({ ok: false, reason: "search_limit" }, 429);

  const run = async () => {
    const D = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 9000);
    let res;
    try { res = await Promise.allSettled((post ? queriesPost(tag, D) : queries(tag, D)).map((x) => tav(x.q, x.news, ac.signal, post || tag === "USOPEN" ? "day" : undefined))); } finally { clearTimeout(tm); }
    const fails = res.filter((x) => x.status === "rejected");
    if (fails.length === res.length) {
      const s = fails[0].reason && fails[0].reason.status;
      return { error: s === 401 || s === 403 ? "search_key" : s === 429 || s === 432 || s === 433 ? "search_limit" : "search_down" };
    }
    day.n += res.length; await store.setJSON(dk, day);
    const seen = new Set(), list = [];
    for (const r of res) if (r.status === "fulfilled") for (const x of r.value) if (x.url && !seen.has(x.url)) { seen.add(x.url); list.push(x); }
    if (list.length < 3) return { error: "not_enough" };
    let text = "", n = 0; const sources = [];
    for (const x of list) {
      n++;
      let host = ""; try { host = new URL(x.url).hostname.replace(/^www\./, ""); } catch (e) {}
      const line = `[${n}] ${x.title} (${host}${x.pub ? ", " + x.pub : ""}): ${x.text}\n`;
      if (text.length + line.length > 14000) break;
      text += line; sources.push({ n, title: x.title, url: x.url });
    }
    const rec = { at: Date.now(), text, sources };
    await store.setJSON(key, rec);
    return rec;
  };
  let p = inflight.get(key);
  if (!p) { p = run().finally(() => inflight.delete(key)); inflight.set(key, p); }
  const out = await p;
  if (out.error) return cached ? J({ ok: true, ...cached, shared: true, stale: true }) : J({ ok: false, reason: out.error }, 502);
  return J({ ok: true, ...out, shared: false });
}

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
