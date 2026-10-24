// POST /api/stripe-webhook  → Stripe conferma il pagamento: qui nasce l'ordine in Supabase.
const { env, sb, finalize, rawBody, verifySignature } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  let ev;
  try {
    const raw = await rawBody(req);
    if (!verifySignature(raw, req.headers["stripe-signature"], env("STRIPE_WEBHOOK_SECRET"))) return res.status(400).json({ error: "Firma non valida" });
    ev = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    console.error("webhook:", e);
    return res.status(400).json({ error: "Richiesta non valida" });
  }
  try {
    const s = ev.data && ev.data.object;
    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
      if (s.payment_status === "paid") await finalize(s);
    } else if (ev.type === "checkout.session.expired") {
      await sb("checkouts?stripe_session_id=eq." + encodeURIComponent(s.id) + "&status=eq.pending", { method: "PATCH", body: { status: "expired" } });
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("webhook finalize:", e); // Stripe riproverà automaticamente
    return res.status(500).json({ error: "Errore" });
  }
};
module.exports.config = { api: { bodyParser: false } };
