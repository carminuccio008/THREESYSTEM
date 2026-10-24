// GET /api/order-status?cs=SESSION_ID  → pagina di conferma dopo il pagamento.
const { stripe, sb, finalize, limited } = require("./_lib");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const cs = String((req.query && req.query.cs) || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(cs)) return res.status(400).json({ error: "Richiesta non valida" });
  if (limited(req.headers["x-forwarded-for"] || "x", 60)) return res.status(429).json({ error: "Troppe richieste" });
  try {
    const rows = await sb("orders?stripe_session_id=eq." + cs + "&select=data,status", { method: "GET" });
    if (rows.length) return res.status(200).json({ order: { ...rows[0].data, status: rows[0].status } });
    // Se il webhook è in ritardo, verifichiamo direttamente con Stripe (server-to-server).
    const s = await stripe("/checkout/sessions/" + cs, null, "GET");
    if (s.payment_status === "paid") {
      const order = await finalize(s);
      return res.status(200).json({ order });
    }
    return res.status(200).json({ pending: true, status: s.payment_status });
  } catch (e) {
    console.error("order-status:", e);
    return res.status(200).json({ pending: true });
  }
};
