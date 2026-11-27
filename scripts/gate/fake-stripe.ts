// The fake Stripe the --payments block points the app at (STRIPE_API_URL). Moved as it was; it has no test of its own yet.
export type Obj = Record<string, any>;

// The fake answers exactly what the app and the plugin call; every request is recorded.
export function startFakeStripe() {
  const fake = { customers: new Map<string, Obj>(), prices: new Map<string, Obj>(), sessions: new Map<string, Obj>(), subs: new Map<string, Obj>(), portals: 0, calls: [] as string[], n: 0, down: "" as "" | "all" | "cancel" };
  const id = (p: string) => `${p}_gate${++fake.n}`;
  // Stripe's form encoding (`metadata[userId]=…`, `line_items[0][price]=…`) read into nested objects.
  const form = (text: string): Obj => {
    const out: Obj = {};
    for (const [k, v] of new URLSearchParams(text)) {
      const path = k.replace(/\]/g, "").split("[");
      let o = out;
      path.slice(0, -1).forEach((p) => (o = o[p] ??= {}));
      o[path.at(-1)!] = v;
    }
    return out;
  };
  const missing = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
  const list = (data: Obj[]) => Response.json({ object: "list", data, has_more: false, url: "/v1/x" });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url), p = url.pathname, m = req.method;
      fake.calls.push(`${m} ${p}`);
      // An outage: every call fails ("all"), or only cancelling a subscription does ("cancel").
      if (fake.down === "all" || (fake.down === "cancel" && m === "DELETE")) return Response.json({ error: { type: "api_error", message: "fake Stripe is down" } }, { status: 500 });
      const body = m === "POST" ? form(await req.text()) : {};
      let r: RegExpMatchArray | null;
      if (m === "GET" && p === "/v1/customers/search") return Response.json({ object: "search_result", data: [], has_more: false, url: p });
      if (m === "POST" && p === "/v1/customers") { const c = { id: id("cus"), object: "customer", email: body.email, name: body.name, metadata: body.metadata ?? {} }; fake.customers.set(c.id, c); return Response.json(c); }
      if ((r = p.match(/^\/v1\/customers\/([^/]+)$/))) { const c = fake.customers.get(r[1]!); if (!c) return missing(); if (m === "POST") Object.assign(c, body); return Response.json(c); }
      if (m === "GET" && p === "/v1/prices") { const keys = [...url.searchParams].filter(([k]) => k.startsWith("lookup_keys")).map(([, v]) => v); return list([...fake.prices.values()].filter((x) => keys.includes(x.lookup_key))); }
      if (m === "POST" && p === "/v1/prices") {
        const x = { id: id("price"), object: "price", active: true, currency: body.currency, unit_amount: Number(body.unit_amount), lookup_key: body.lookup_key, product: body.product ?? id("prod"), recurring: { interval: body.recurring?.interval, usage_type: "licensed" } };
        fake.prices.set(x.id, x);
        return Response.json(x);
      }
      if (m === "GET" && p === "/v1/subscriptions") return list([...fake.subs.values()].filter((s) => s.customer === url.searchParams.get("customer")));
      if ((r = p.match(/^\/v1\/subscriptions\/([^/]+)$/))) { const s = fake.subs.get(r[1]!); if (!s) return missing(); if (m === "DELETE") s.status = "canceled"; return Response.json(s); }
      if (m === "POST" && p === "/v1/checkout/sessions") { const s = { id: id("cs"), object: "checkout.session", url: "https://checkout.stripe.test/pay", subscription: null, payment_status: "unpaid", status: "open", ...body }; fake.sessions.set(s.id, s); return Response.json(s); }
      if (m === "GET" && p === "/v1/checkout/sessions") return list([...fake.sessions.values()].filter((x) => x.customer === url.searchParams.get("customer") && x.status === url.searchParams.get("status")));
      if (m === "POST" && (r = p.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) { const x = fake.sessions.get(r[1]!); if (!x) return missing(); x.status = "expired"; return Response.json(x); }
      if ((r = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) { const s = fake.sessions.get(r[1]!); return s ? Response.json(s) : missing(); }
      if (m === "POST" && p === "/v1/billing_portal/sessions") { fake.portals++; return Response.json({ id: id("bps"), object: "billing_portal.session", url: "https://billing.stripe.test/session", customer: body.customer, return_url: body.return_url }); }
      return Response.json({ error: { type: "invalid_request_error", message: `fake Stripe has no ${m} ${p}` } }, { status: 404 });
    },
  });
  return { fake, id, server };
}
