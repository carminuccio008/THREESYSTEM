// Funzioni condivise (il prefisso _ evita che Vercel le esponga come indirizzo pubblico).
const crypto = require("crypto");

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error("Variabile mancante: " + k);
  return v;
};

// Codifica annidata per l'API di Stripe (a[b][0][c]=...)
function enc(obj) {
  const out = [];
  (function walk(v, k) {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${k}[${i}]`));
    else if (typeof v === "object") Object.keys(v).forEach((key) => walk(v[key], k ? `${k}[${key}]` : key));
    else out.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  })(obj, "");
  return out.join("&");
}

async function stripe(path, body, method = "POST") {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY"), "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : enc(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || "Errore Stripe");
  return d;
}

async function sb(path, { method = "POST", body } = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    method,
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch (e) { d = t; }
  if (!r.ok) throw new Error((d && d.message) || "Errore database");
  return d;
}

// Registra l'ordine SOLO se Stripe conferma il pagamento (operazione idempotente).
async function finalize(session) {
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
  return sb("rpc/finalize_order", { body: { sid: session.id, pi, paid_cents: session.amount_total } });
}

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

function verifySignature(raw, header, secret, tolerance = 300) {
  if (!header) return false;
  const parts = {};
  header.split(",").forEach((p) => { const i = p.indexOf("="); if (i > 0) (parts[p.slice(0, i)] = parts[p.slice(0, i)] || []).push(p.slice(i + 1)); });
  const t = parts.t && parts.t[0];
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > tolerance) return false;
  const expected = crypto.createHmac("sha256", secret).update(t + "." + raw.toString("utf8")).digest("hex");
  return parts.v1.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

const hits = new Map();
function limited(ip, max = 12) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

module.exports = { env, enc, stripe, sb, finalize, rawBody, verifySignature, limited };
