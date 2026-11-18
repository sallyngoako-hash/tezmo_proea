import crypto from "node:crypto";
import { getStore } from "./store.js";

export const env = (k, d = "") => process.env[k] || d;
export const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
/* gmail ignores dots and +tags, so a.b+x@gmail.com is the same mailbox as ab@gmail.com */
export const canon = (e) => { let [l, d] = String(e || "").trim().toLowerCase().split("@"); if (d === "googlemail.com") d = "gmail.com"; if (d === "gmail.com") l = (l || "").split("+")[0].replace(/\./g, ""); return l + "@" + d; };
export const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
export const okDev = (d) => typeof d === "string" && /^[a-z0-9]{16,64}$/.test(d);
export const okEmail = (e) => typeof e === "string" && e.length <= 120 && /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(e);
export const accessStore = () => getStore({ name: "access", consistency: "strong" });

/* The owner. OWNER_EMAIL in Vercel can override it, otherwise this address is the owner. */
export const ownerEmail = () => (env("OWNER_EMAIL") || "tumeloseleka74@gmail.com").trim().toLowerCase();
export const isOwnerEmail = (e) => canon(e) === canon(ownerEmail());

/* Owner devices. The owner never needs approval, but an email address alone proves nothing, so the owner
   email only skips approval on the owner's own device(s): the first device that opens the app with the owner email
   (or any device that sends the correct ADMIN_TOKEN) is remembered. Any other device with the owner email goes
   through the normal approval request like everybody else. */
export async function ownerDevice(access, email, device, adminHdr) {
  if (!isOwnerEmail(email) || !okDev(device)) return false;
  const adminOK = !!env("ADMIN_TOKEN") && same(adminHdr || "", env("ADMIN_TOKEN"));
  const rec = (await access.get("o:dev", { type: "json" })) || { devices: [] };
  if (rec.devices.includes(device)) return true;
  if (adminOK || rec.devices.length === 0) {
    rec.devices = rec.devices.concat(device).slice(-5);
    await access.setJSON("o:dev", rec);
    return true;
  }
  return false;
}

/* one check for every function: owner device, or an approved email on its approved device */
export async function checkAccess(access, email, device, adminHdr) {
  email = String(email || "").trim().toLowerCase();
  if (!okEmail(email) || !okDev(device)) return { ok: false };
  if (await ownerDevice(access, email, device, adminHdr)) return { ok: true, owner: true, byOwnerDevice: true };
  let u = await access.get("u:" + sha(email).slice(0, 32), { type: "json" });
  if (!u) { const al = await access.get("a:" + sha(canon(email)).slice(0, 32), { type: "json" }); if (al) u = await access.get(al.key, { type: "json" }); }
  if (!u || u.revoked || !u.devices.includes(device)) return { ok: false };
  return { ok: true, owner: isOwnerEmail(email), u };
}
