// bun run stripe:seed — creates the prices declared in src/plans.ts in the Stripe sandbox, by lookup key, skipping any that exist (safe to rerun).
// Sandbox only: it refuses live keys. Live products and prices are created by the owner in the Stripe dashboard (see docs/setup.md).
import { type Plan, PLANS } from "../src/plans";
import { PLACEHOLDER_KEY, stripeClient } from "../src/stripe";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (/^(sk|rk)_live_/.test(key)) {
  console.error("stripe:seed refuses live keys. Create live products in the Stripe dashboard; seed only the sandbox.");
  process.exit(1);
}
if (!/^(sk|rk)_test_/.test(key) || key === PLACEHOLDER_KEY) {
  console.error("Set STRIPE_SECRET_KEY in .env to a sandbox key (sk_test_… or rk_test_…) first.");
  process.exit(1);
}

const stripe = stripeClient(key, process.env.STRIPE_API_URL);
for (const plan of PLANS as readonly Plan[]) {
  // The annual price joins the monthly price's product, so one plan is one product.
  let product: string | undefined;
  for (const [interval, price] of [["month", plan.monthly], ["year", plan.annual]] as const) {
    if (!price) continue;
    const found = (await stripe.prices.list({ lookup_keys: [price.lookupKey], active: true, limit: 1 })).data[0];
    if (found) {
      product = typeof found.product === "string" ? found.product : found.product.id;
      console.log(`exists: ${price.lookupKey}`);
      continue;
    }
    const made = await stripe.prices.create({
      currency: plan.currency,
      unit_amount: price.amount,
      recurring: { interval },
      lookup_key: price.lookupKey,
      ...(product ? { product } : { product_data: { name: plan.label } }),
    });
    product = typeof made.product === "string" ? made.product : made.product.id;
    console.log(`created: ${price.lookupKey}`);
  }
}
