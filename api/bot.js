import { getStore } from "../lib/store.js";
import webpush from "web-push";
import crypto from "node:crypto";
import { env, sha, canon, same, okDev, okEmail, accessStore, checkAccess, ownerEmail } from "../lib/auth.js";

/*
  TEZMO PRO shared signals.  Deploy as api/bot.js
  - The OWNER account (OWNER_EMAIL, approved on its device, plus the ADMIN_TOKEN typed once on the owner's device) publishes signals.
  - Every other account can only read, and only while its bot is active (START). STOP removes it from the list.
  - New signals are pushed to the phones of active clients. The app also checks (sync) while it is open.
  Needs: web-push (package.json) and the Redis store (lib/store.js). The push keys are created once and kept on the server (never in the app).
*/
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-admin", "access-control-allow-methods": "POST,OPTIONS" };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const STATUSES = ["ACTIVE", "FILLED", "TP", "SL", "CANCELLED", "EXPIRED"];
const ORDERS = ["MARKET", "BUY LIMIT", "BUY STOP", "SELL LIMIT", "SELL STOP"];
const sastParts = (t) => { const d = new Date(t + 2 * 36e5).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };

async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ ok: false, reason: "method" }, 405);
  let b; try { b = await req.json(); } catch (e) { return J({ ok: false, reason: "bad" }, 400); }
  const email = String(b.email || "").trim().toLowerCase(), device = String(b.device || ""), action = String(b.action || "");
  if (!okEmail(email) || !okDev(device)) return J({ ok: false, reason: "access" }, 401);

  /* 1. only approved people on their approved device, or the owner on the owner's device */
  const ac = await checkAccess(accessStore(), email, device, req.headers.get("x-admin") || "");
  if (!ac.ok) return J({ ok: false, reason: "access" }, 401);
  const isOwner = !!ac.owner;
  const isAdmin = isOwner && !!env("ADMIN_TOKEN") && same(req.headers.get("x-admin") || "", env("ADMIN_TOKEN"));

  const st = getStore({ name: "bot", consistency: "strong" });
  const me = "act:" + sha(canon(email)).slice(0, 24);
  const list = async () => (await st.get("sig:list", { type: "json" })) || [];

  async function vapid() {
    let v = await st.get("vapid", { type: "json" });
    if (!v) { v = webpush.generateVAPIDKeys(); await st.setJSON("vapid", v); }
    webpush.setVapidDetails("mailto:" + ownerEmail(), v.publicKey, v.privateKey);
    return v.publicKey;
  }
  const addSub = (rec, sub) => {
    if (sub && typeof sub.endpoint === "string" && sub.keys && sub.keys.p256dh && sub.keys.auth) {
      rec.subs = (rec.subs || []).filter((x) => x.endpoint !== sub.endpoint);
      rec.subs.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
      rec.subs = rec.subs.slice(-3);
    }
  };

  if (action === "whoami") return J({ ok: true, owner: isOwner, admin: isAdmin });
  if (action === "vapid") return J({ ok: true, key: await vapid() });

  /* 2. activate / deactivate */
  if (action === "start") {
    const old = await st.get(me, { type: "json" });
    const rec = { email, at: Date.now(), subs: (old && old.subs) || [] };
    addSub(rec, b.sub);
    await st.setJSON(me, rec);
    const l = await list();
    return J({ ok: true, owner: isOwner, admin: isAdmin, now: Date.now(), latest: l[0] || null, push: rec.subs.length > 0 });
  }
  if (action === "stop") { await st.delete(me); return J({ ok: true }); }
  const rec = await st.get(me, { type: "json" });

  if (action === "push") {
    if (!rec) return J({ ok: false, reason: "inactive" });
    addSub(rec, b.sub); await st.setJSON(me, rec); return J({ ok: true, push: rec.subs.length > 0 });
  }

  /* 3. clients read (only while active) */
  if (action === "sync") {
    if (!rec) return J({ ok: false, reason: "inactive" });
    const since = Math.max(Number(b.since) || 0, rec.at), l = await list();
    return J({ ok: true, now: Date.now(), signals: l.filter((s) => s.t > since).reverse().slice(0, 20), updates: l.slice(0, 20).map((s) => ({ id: s.id, status: s.status })) });
  }

  /* 4. only the owner publishes */
  if (action === "stats") { if (!isAdmin) return J({ ok: false, reason: "forbidden" }, 403); const { blobs } = await st.list({ prefix: "act:" }); return J({ ok: true, active: blobs.length, signals: (await list()).length }); }
  if (action === "status") {
    if (!isAdmin) return J({ ok: false, reason: "forbidden" }, 403);
    const l = await list(), s = l.find((x) => x.id === b.id);
    if (!s || !STATUSES.includes(b.status)) return J({ ok: false, reason: "bad" }, 400);
    s.status = b.status; await st.setJSON("sig:list", l); return J({ ok: true });
  }
  if (action === "publish") {
    if (!isAdmin) return J({ ok: false, reason: "forbidden" }, 403);
    const sym = String(b.sym || "").toUpperCase(), dir = String(b.dir || "").toUpperCase();
    const entry = +b.entry, sl = +b.sl, tp = +b.tp, dec = Math.min(6, Math.max(0, parseInt(b.dec, 10) || 2));
    const ot = ORDERS.includes(String(b.ot)) ? String(b.ot) : "MARKET";
    const good = /^[A-Z0-9._-]{3,15}$/.test(sym) && (dir === "BUY" || dir === "SELL") && entry > 0 && sl > 0 && tp > 0 &&
      (dir === "BUY" ? sl < entry && tp > entry : sl > entry && tp < entry);
    if (!good) return J({ ok: false, reason: "not_a_completed_signal" }, 400);       /* unfinished or rejected setups never go out */
    const hk = "h:" + Math.floor(Date.now() / 36e5), rl = (await st.get(hk, { type: "json" })) || { n: 0 };
    if (rl.n >= 60) return J({ ok: false, reason: "busy" }, 429);
    rl.n++; await st.setJSON(hk, rl);
    const f = (v) => v.toFixed(dec), fp = [sym, dir, f(entry), f(sl), f(tp)].join("|"), l = await list(), now = Date.now();
    const dup = l.find((x) => x.fp === fp && now - x.t < 6 * 36e5);
    if (dup) return J({ ok: true, dup: true, id: dup.id });                           /* published once only */
    const id = "S" + now.toString(36) + crypto.randomBytes(3).toString("hex");
    const sg = { id, t: now, sym, dir, ot, entry, sl, tp, dec, conf: Math.max(0, Math.min(100, Math.round(+b.conf || 0))), src: String(b.src || "TEZMO PRO").slice(0, 24), tf: String(b.tf || "").slice(0, 60), status: "ACTIVE", fp, sast: sastParts(now) };
    l.unshift(sg); await st.setJSON("sig:list", l.slice(0, 100));

    /* phones of active clients, in batches; dead subscriptions are removed */
    await vapid();
    const body = (ot !== "MARKET" ? ot : dir) + " \u2013 " + sym + "\nENTRY: " + f(entry) + "\nSL: " + f(sl) + "\nTP: " + f(tp) + "\nTIME: " + sg.sast.time + " SAST";
    const payload = JSON.stringify({ id, title: "TEZMO PRO EA", body });
    const { blobs } = await st.list({ prefix: "act:" });
    let pushed = 0, failed = 0;
    for (let i = 0; i < blobs.length; i += 25) {
      await Promise.all(blobs.slice(i, i + 25).map(async (x) => {
        const r = await st.get(x.key, { type: "json" }); if (!r || !r.subs || !r.subs.length) return;
        const keep = [];
        for (const sub of r.subs) {
          try { await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: "high", topic: id.slice(0, 32) }); pushed++; keep.push(sub); }
          catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) continue; failed++; keep.push(sub); }
        }
        if (keep.length !== r.subs.length) { r.subs = keep; await st.setJSON(x.key, r); }
      }));
    }
    return J({ ok: true, id, active: blobs.length, pushed, failed });
  }
  return J({ ok: false, reason: "unknown" }, 400);
}

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
