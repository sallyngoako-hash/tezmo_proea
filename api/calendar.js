import { getStore } from "../lib/store.js";

// Fetches the Forex Factory weekly calendar on the server (no browser CORS or rate-limit problems)
// and caches it for 10 minutes so every phone shares one request.
const URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function handler() {
  const store = getStore({ name: "cal", consistency: "strong" });
  const c = await store.get("week", { type: "json" });
  if (c && Date.now() - c.at < 10 * 60e3) return J(c.d);
  const out = [];
  let ok = 0;
  for (const u of URLS) {
    try {
      const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; TezmoCalendar/1.0)", accept: "application/json" } });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j)) { ok++; out.push(...j); }
    } catch (e) {}
  }
  if (!ok) return J({ error: "feed unreachable" }, 502);
  await store.setJSON("week", { d: out, at: Date.now() });
  return J(out);
}

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
