// POST /api/checkout  → crea la sessione di pagamento Stripe. Non crea nessun ordine.
const { env, stripe, sb, limited } = require("./_lib");

const cents = (n) => Math.round(Number(n) * 100);
const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Metodo non consentito" });
  try {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "Origine non consentita" });
    if (limited(req.headers["x-forwarded-for"] || "x")) return res.status(429).json({ error: "Troppe richieste, riprova tra poco" });

    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length || items.length > 30) return res.status(400).json({ error: "Carrello non valido" });
    for (const it of items) {
      if (!it || typeof it.id !== "string" || !Number.isInteger(it.q) || it.q < 1 || it.q > 50) return res.status(400).json({ error: "Carrello non valido" });
    }
    const email = clean(b.email, 160).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "E-mail non valida" });
    if (!clean(b.name, 120)) return res.status(400).json({ error: "Inserisci il nome" });

    // Utente collegato (facoltativo): verificato da Supabase, mai fidandosi del browser
    let userId = null;
    const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (tok) {
      try {
        const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/auth/v1/user", { headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: "Bearer " + tok } });
        if (r.ok) userId = (await r.json()).id || null;
      } catch (e) { /* ordine come ospite */ }
    }

    // Prezzi, sconto, spedizione e scorte sono calcolati dal database, non dal browser
    let quote;
    try {
      quote = await sb("rpc/quote_order", { body: { o: { items: items.map((i) => ({ id: i.id, q: i.q, color: i.color, size: i.size, text: i.text })), shipId: b.shipId, coupon: b.coupon } } });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const inv = b.invoice && typeof b.invoice === "object" ? b.invoice : {};
    const payload = {
      userId, name: clean(b.name, 120), email, phone: clean(b.phone, 40), addr: clean(b.addr, 300),
      shipMethod: clean(b.shipMethod, 60), eta: clean(b.eta, 60), notes: clean(b.notes, 500),
      invoice: { req: !!inv.req, company: clean(inv.company, 120), vat: clean(inv.vat, 30), sdi: clean(inv.sdi, 20), no: "", date: 0 },
      items: quote.items, subtotal: quote.subtotal, discount: quote.discount, ship: quote.ship, total: quote.total, coupon: quote.coupon,
      pay: "card", stripe: true,
    };

    const lines = payload.items.map((it) => ({
      quantity: it.q,
      price_data: {
        currency: "eur", unit_amount: cents(it.price),
        product_data: { name: it.name, ...(it.color || it.size || it.text ? { description: [it.color && "Colore: " + it.color, it.size && "Taglia: " + it.size, it.text && "Testo: " + it.text].filter(Boolean).join(" · ") } : {}) },
      },
    }));
    const subC = payload.items.reduce((s, it) => s + cents(it.price) * it.q, 0);
    const discC = cents(payload.discount), shipC = cents(payload.ship);
    const amount = subC - discC + shipC;

    const [ck] = await sb("checkouts", { body: { payload, amount_cents: amount } });
    const site = process.env.SITE_URL || "https://" + req.headers.host;

    const params = {
      mode: "payment", locale: "it", customer_email: email, client_reference_id: ck.id,
      metadata: { checkout_id: ck.id },
      payment_intent_data: { metadata: { checkout_id: ck.id }, description: "Ordine online" },
      line_items: lines,
      shipping_options: [{ shipping_rate_data: { type: "fixed_amount", display_name: payload.shipMethod || "Spedizione", fixed_amount: { amount: shipC, currency: "eur" } } }],
      success_url: site + "/?cs={CHECKOUT_SESSION_ID}#/",
      cancel_url: site + "/#/checkout",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    if (discC > 0) {
      const cp = await stripe("/coupons", { amount_off: discC, currency: "eur", duration: "once", name: "Sconto" + (payload.coupon ? " " + payload.coupon : "") });
      params.discounts = [{ coupon: cp.id }];
    }
    const session = await stripe("/checkout/sessions", params);
    await sb("checkouts?id=eq." + ck.id, { method: "PATCH", body: { stripe_session_id: session.id } });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("checkout:", e);
    return res.status(500).json({ error: "Pagamento non disponibile al momento" });
  }
};
