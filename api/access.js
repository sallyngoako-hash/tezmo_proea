import crypto from "node:crypto";
import { env, sha, canon, same, okEmail, okDev, accessStore, ownerDevice, isOwnerEmail, ownerEmail } from "../lib/auth.js";

/*
  TEZMO access approval.  Deploy as api/access.js
  Vercel environment variables:
    ACCESS_SECRET   any long random text (signs the approve/reject links)
    ADMIN_TOKEN     any long random text (admin page password, and the owner's token in the app Setup)
    RESEND_API_KEY  API key from resend.com (free plan is enough) so approval requests reach your inbox
  Optional: OWNER_EMAIL (default tumeloseleka74@gmail.com), MAIL_FROM, SITE_URL
  Rule: the owner email never needs approval (on the owner's device). Every other email needs approval.
*/

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-admin", "access-control-allow-methods": "GET,POST,OPTIONS" };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const P = (title, body, s = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:16px system-ui;background:#05070d;color:#e8ecf5;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px"><div style="max-width:440px;width:100%;background:#0c1220;border:1px solid #22304d;border-radius:14px;padding:20px">${body}</div>`, { status: s, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const secret = () => env("ACCESS_SECRET");
const sign = (id, act) => crypto.createHmac("sha256", secret()).update(id + ":" + act).digest("hex");
const uKey = (email) => "u:" + sha(email).slice(0, 32);
const aKey = (email) => "a:" + sha(canon(email)).slice(0, 32);
const ONE = 1; /* one email = one approval = one device */
const base = (req) => (env("SITE_URL") || new URL(req.url).origin).replace(/\/+$/, "");

async function mail(to, subject, html) {
  if (!env("RESEND_API_KEY")) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env("RESEND_API_KEY"), "content-type": "application/json" },
      body: JSON.stringify({ from: env("MAIL_FROM", "TEZMO Access <onboarding@resend.dev>"), to: [to], subject, html }),
    });
    return r.ok;
  } catch (e) { return false; }
}

async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!secret() || !env("ADMIN_TOKEN")) return J({ error: "Server not configured: set ACCESS_SECRET and ADMIN_TOKEN in Vercel." }, 500);
  const store = accessStore();
  const url = new URL(req.url);
  const ct = req.headers.get("content-type") || "";

  /* ---------- approve / reject links from the email (confirm page, so mail scanners cannot auto-approve) ---------- */
  const decide = async (act, id, sg, doIt) => {
    if (!["approve", "reject"].includes(act) || !/^[a-f0-9]{24}$/.test(id || "") || !same(sg || "", sign(id, act))) return P("Invalid link", "<h2>Invalid or expired link</h2>", 400);
    const p = await store.get("p:" + id, { type: "json" });
    if (!p) return P("Not found", "<h2>Request not found</h2>", 404);
    if (!doIt) {
      return P("Confirm", `<h2>${act === "approve" ? "Approve" : "Reject"} access?</h2><p>Email: <b>${esc(p.email)}</b><br>Device: …${esc(p.device.slice(-6))}<br>Status now: ${esc(p.status)}</p><form method="POST" action="${esc(url.pathname + url.search)}"><button style="width:100%;padding:14px;border-radius:12px;border:0;font:600 16px system-ui;background:${act === "approve" ? "#2dd4a0" : "#ff6b6b"};color:#05070d">${act === "approve" ? "Yes, approve" : "Yes, reject"}</button></form>`);
    }
    if (act === "approve") {
      const k = uKey(p.email);
      const al = await store.get(aKey(p.email), { type: "json" });
      const u = (await store.get(k, { type: "json" })) || (al && (await store.get(al.key, { type: "json" }))) || { email: p.email, devices: [], created: Date.now() };
      if (u.devices.length >= ONE && !u.devices.includes(p.device)) {
        p.status = "exists"; p.decided = Date.now(); await store.setJSON("p:" + id, p);
        return P("Already approved", `<h2>Not approved ⚠️</h2><p><b>${esc(p.email)}</b> is already approved on another device. One email can be approved only once.<br><br>To move it to a new phone, open the admin page and tap <b>Reset devices</b> for this email first.</p>`);
      }
      if (!u.devices.includes(p.device)) u.devices.push(p.device);
      u.revoked = false;
      await store.setJSON(uKey(u.email || p.email), u);
      await store.setJSON(aKey(p.email), { key: uKey(u.email || p.email) });
      p.status = "approved";
    } else p.status = "rejected";
    p.decided = Date.now();
    await store.setJSON("p:" + id, p);
    return P("Done", `<h2>${act === "approve" ? "Approved ✅" : "Rejected ❌"}</h2><p>${esc(p.email)}</p>`);
  };

  if (req.method === "GET" && url.searchParams.get("a") === "admin") return adminPage();
  if (req.method === "GET") return decide(url.searchParams.get("a"), url.searchParams.get("id"), url.searchParams.get("sig"), false);
  if (req.method === "POST" && !ct.includes("application/json")) return decide(url.searchParams.get("a"), url.searchParams.get("id"), url.searchParams.get("sig"), true);
  if (req.method !== "POST") return J({ error: "method" }, 405);

  let b; try { b = await req.json(); } catch (e) { return J({ error: "bad json" }, 400); }
  const action = String(b.action || "");

  /* ---------- admin actions ---------- */
  if (action.startsWith("admin_")) {
    if (!same(req.headers.get("x-admin") || "", env("ADMIN_TOKEN"))) return J({ error: "wrong admin token" }, 401);
    const email = String(b.email || "").trim().toLowerCase();
    if (action === "admin_clearowner") { await store.delete("o:dev"); return J({ ok: true }); }
    if (action === "admin_list") {
      const users = [], pend = [];
      for (const pre of ["u:", "p:"]) {
        const { blobs } = await store.list({ prefix: pre });
        for (const x of blobs) { const v = await store.get(x.key, { type: "json" }); if (v) (pre === "u:" ? users : pend).push(v); }
      }
      return J({ users, pending: pend.filter((p) => p.status === "pending") });
    }
    if (!okEmail(email)) return J({ error: "bad email" }, 400);
    const k = uKey(email);
    const u = (await store.get(k, { type: "json" })) || null;
    if (action === "admin_preapprove") { await store.setJSON(k, Object.assign(u || { email, devices: [], created: Date.now() }, { revoked: false, pre: true })); await store.setJSON(aKey(email), { key: k }); return J({ ok: true }); }
    if (!u) return J({ error: "not found" }, 404);
    if (action === "admin_revoke") u.revoked = true;
    else if (action === "admin_restore") u.revoked = false;
    else if (action === "admin_cleardevices") u.devices = [];
    else if (action === "admin_delete") { await store.delete(k); await store.delete(aKey(email)); return J({ ok: true }); }
    else return J({ error: "unknown" }, 400);
    await store.setJSON(k, u);
    return J({ ok: true });
  }

  /* ---------- app actions ---------- */
  const email = String(b.email || "").trim().toLowerCase(), device = String(b.device || "");
  if (!okEmail(email) || !okDev(device)) return J({ error: "bad input" }, 400);
  /* the owner never needs approval (only on the owner's own device, see lib/auth.js) */
  if (isOwnerEmail(email) && (action === "status" || action === "request") && await ownerDevice(store, email, device, "")) return J({ status: "approved", owner: true });
  const k = uKey(email), pid = sha(email + ":" + device).slice(0, 24);
  let u = await store.get(k, { type: "json" });
  if (!u) { const al = await store.get(aKey(email), { type: "json" }); if (al) u = await store.get(al.key, { type: "json" }); }   /* same mailbox written another way */
  const p = await store.get("p:" + pid, { type: "json" });

  if (u && u.revoked) return J({ status: "revoked" });
  if (u && u.devices.includes(device)) return J({ status: "approved" });
  if (u && u.devices.length >= ONE) return J({ status: "exists" });          /* already approved once on another device */

  if (action === "status") return J({ status: p ? p.status : "none" });
  if (action !== "request") return J({ error: "unknown" }, 400);

  /* pre-approved email: its single device unlocks without waiting */
  if (u && u.pre && u.devices.length < ONE) {
    u.devices.push(device); await store.setJSON(uKey(u.email), u); await store.setJSON(aKey(email), { key: uKey(u.email) }); return J({ status: "approved" });
  }
  if (p && p.status === "rejected") return J({ status: "rejected" });
  if (p && p.status === "pending" && Date.now() - p.mailedAt < 10 * 60e3) return J({ status: "pending" });

  /* new request: at most 30 emails per hour in total so nobody can flood your inbox */
  const hk = "rl:" + Math.floor(Date.now() / 36e5);
  const rl = (await store.get(hk, { type: "json" })) || { n: 0 };
  const rec = { pid, email, device, status: "pending", created: (p && p.created) || Date.now(), mailedAt: Date.now() };
  let sent = false;
  if (rl.n < 30) {
    rl.n++; await store.setJSON(hk, rl);
    const a = base(req) + "/api/access?id=" + pid + "&a=";
    const html = `<div style="font:16px system-ui"><h2>New access request</h2><p>Email: <b>${esc(email)}</b><br>Device: …${esc(device.slice(-6))}<br>Devices already approved for this email: <b>${u ? u.devices.length : 0}</b>${u && u.devices.length ? " (check this person paid for more than one)" : ""}</p><p><a href="${a}approve&sig=${sign(pid, "approve")}" style="background:#2dd4a0;color:#05070d;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">Approve</a>&nbsp;&nbsp;<a href="${a}reject&sig=${sign(pid, "reject")}" style="background:#ff6b6b;color:#05070d;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">Reject</a></p><p style="color:#666">Approve only after you have seen the payment.</p></div>`;
    sent = await mail(ownerEmail(), "Access request: " + email, html);
  }
  rec.mailed = sent;
  await store.setJSON("p:" + pid, rec);
  return J({ status: "pending", mailed: sent });
};

function adminPage() {
  return P("Admin", `<h2>TEZMO access admin</h2><input id="t" type="password" placeholder="Admin token" style="width:100%;padding:10px;margin:6px 0;border-radius:8px;border:1px solid #22304d;background:#0a1020;color:#e8ecf5"><button onclick="L()" style="width:100%;padding:10px;border-radius:8px;border:0;background:#4f7cff;color:#fff;font-weight:600">Load</button><div style="margin-top:10px"><input id="pe" placeholder="Pre-approve an email" style="width:68%;padding:10px;border-radius:8px;border:1px solid #22304d;background:#0a1020;color:#e8ecf5"><button onclick="A('admin_preapprove',pe.value)" style="width:30%;padding:10px;border-radius:8px;border:0;background:#2dd4a0;font-weight:600">Add</button></div><button onclick="if(confirm('Forget the owner devices? The next device that opens the app with the owner email becomes the owner device.'))A('admin_clearowner','')" style="width:100%;margin-top:10px;padding:10px;border-radius:8px;border:1px solid #22304d;background:#0a1020;color:#e8ecf5">Reset owner devices</button><div id="o" style="margin-top:12px;font-size:14px"></div><script>
async function C(a,e){const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json','x-admin':document.getElementById('t').value},body:JSON.stringify({action:a,email:e})});return r.json()}
async function A(a,e){const j=await C(a,e);if(j.error)alert(j.error);L()}
async function L(){const j=await C('admin_list');const o=document.getElementById('o');o.textContent='';if(j.error){o.textContent=j.error;return}
const add=(t,s)=>{const d=document.createElement('div');d.style.cssText='border-top:1px solid #22304d;padding:8px 0';d.textContent=t;(s||[]).forEach(([n,f])=>{const b=document.createElement('button');b.textContent=n;b.style.cssText='margin:6px 6px 0 0;padding:6px 10px;border-radius:8px;border:1px solid #22304d;background:#0a1020;color:#e8ecf5';b.onclick=f;d.appendChild(b)});o.appendChild(d)};
add('Pending requests: '+j.pending.length);j.pending.forEach(p=>add(p.email+' (device …'+p.device.slice(-6)+')'));
add('Approved people: '+j.users.length);j.users.forEach(u=>add(u.email+' | devices '+u.devices.length+(u.revoked?' | REVOKED':'')+(u.pre?' | pre-approved':''),[u.revoked?['Restore',()=>A('admin_restore',u.email)]:['Revoke',()=>A('admin_revoke',u.email)],['Reset devices',()=>A('admin_cleardevices',u.email)],['Delete',()=>{if(confirm('Delete '+u.email+'?'))A('admin_delete',u.email)}]]))}
</script>`);
}

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
