import { getStore } from "../lib/store.js";
import { sha, accessStore, checkAccess } from "../lib/auth.js";

/*
  TEZMO AI relay.  Deploy as api/ai.js  (next to access.js)
  Keeps your AI keys on the server so buyers can never see them.
  Vercel environment variables:
    GEMINI_KEY   your Google AI Studio key (used for the calendar and as a fallback)
    GROQ_KEY     your Groq key (free fallback)
  Optional: AI_PER_HOUR (requests per buyer per hour, default 150)
*/
const env = (k, d = "") => process.env[k] || d;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,OPTIONS" };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
/* only free-tier models can ever be called with your keys */
const FREE_GEMINI = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const FREE_GROQ = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b"];

async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ error: { message: "method" } }, 405);
  let raw = ""; try { raw = await req.text(); } catch (e) {}
  if (raw.length > 4.4e6) return J({ error: { message: "request too large" } }, 413);
  let b; try { b = JSON.parse(raw); } catch (e) { return J({ error: { message: "bad json" } }, 400); }

  const email = String(b.email || "").trim().toLowerCase(), device = String(b.device || "");
  const store = accessStore();
  const acc = await checkAccess(store, email, device, "");
  if (!acc.ok) return J({ error: { message: "access not active" } }, 401);

  const hk = "ai:" + sha(email).slice(0, 16) + ":" + Math.floor(Date.now() / 36e5);
  const rl = (await store.get(hk, { type: "json" })) || { n: 0 };
  if (rl.n >= parseInt(env("AI_PER_HOUR", "150"), 10)) return J({ error: { message: "hourly limit reached", status: "RESOURCE_EXHAUSTED" } }, 429);
  rl.n++; await store.setJSON(hk, rl);

  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 55000);
  try {
    let r;
    if (b.provider === "gemini") {
      if (!env("GEMINI_KEY")) return J({ error: { message: "service not configured" } }, 503);
      if (!FREE_GEMINI.includes(String(b.model || ""))) return J({ error: { message: "bad model" } }, 400);
      r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + b.model + ":generateContent", {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env("GEMINI_KEY") }, body: JSON.stringify(b.payload), signal: ac.signal });
    } else if (b.provider === "groq") {
      if (!env("GROQ_KEY")) return J({ error: { message: "service not configured" } }, 503);
      if (!b.payload || !FREE_GROQ.includes(String(b.payload.model || ""))) return J({ error: { message: "bad model" } }, 400);
      r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env("GROQ_KEY") }, body: JSON.stringify(b.payload), signal: ac.signal });
    } else return J({ error: { message: "unknown provider" } }, 400);
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
  } catch (e) {
    return J({ error: { message: e && e.name === "AbortError" ? "timeout" : "upstream unreachable" } }, e && e.name === "AbortError" ? 504 : 502);
  } finally { clearTimeout(tm); }
}

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
