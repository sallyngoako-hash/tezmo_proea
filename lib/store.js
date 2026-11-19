/*
  Tiny key-value store for Vercel, simple get / setJSON / delete / list calls:
  get(key,{type:"json"}), setJSON(key,value), delete(key), list({prefix}) -> {blobs:[{key}]}.
  It talks to a Redis database over HTTPS, so it needs no extra npm package.
  Connect one in Vercel: Project > Storage > Create > Upstash Redis (Marketplace) and connect it to this project.
  Vercel then adds KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN) by itself.
*/
const URL_ = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_KV_REST_API_URL || "").replace(/\/+$/, "");
const TOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_KV_REST_API_TOKEN || "";

async function cmd(args) {
  const u = URL_(), t = TOK();
  if (!u || !t) throw new Error("storage_not_connected");
  const r = await fetch(u, { method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: JSON.stringify(args) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("storage_error: " + (j.error || r.status));
  return j.result;
}
const globEsc = (s) => String(s).replace(/[\\*?\[\]]/g, "\\$&");
/* counters and rate-limit keys clean themselves up after 3 days */
const TEMP = /^(h|rl|ai|d):/;

export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  const P = "tz:" + name + ":";
  return {
    async get(key, o) {
      const v = await cmd(["GET", P + key]);
      if (v == null) return null;
      if (o && o.type === "json") { try { return JSON.parse(v); } catch (e) { return null; } }
      return v;
    },
    async setJSON(key, val) {
      const a = ["SET", P + key, JSON.stringify(val)];
      if (TEMP.test(String(key))) a.push("EX", "259200");
      await cmd(a);
    },
    async delete(key) { await cmd(["DEL", P + key]); },
    async list(o) {
      const prefix = (o && o.prefix) || "";
      const seen = new Set();
      let cur = "0", guard = 0;
      do {
        const r = await cmd(["SCAN", cur, "MATCH", P + globEsc(prefix) + "*", "COUNT", "500"]);
        cur = String(r[0]);
        for (const k of r[1]) seen.add(k.slice(P.length));
      } while (cur !== "0" && ++guard < 200);
      return { blobs: [...seen].map((key) => ({ key })) };
    },
  };
}
