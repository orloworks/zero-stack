<script lang="ts">
  import type { Props } from "./billing.server";

  let { user, configured, plans, view }: Props = $props();

  let pending = $state("");
  let error = $state("");

  const price = (amount: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);

  // Both actions answer with a Stripe-hosted URL (Checkout or the billing portal); card details never touch this app.
  async function go(path: string, body: object, what: string) {
    pending = what;
    error = "";
    try {
      const res = await fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.url) {
        window.location.href = data.url;
        return;
      }
      error = data?.message ?? "Couldn't reach Stripe. Try again.";
    } catch {
      error = "Something went wrong. Check your connection and try again.";
    }
    pending = "";
  }
  const subscribe = (plan: string) => go("/subscription/upgrade", { plan, successUrl: "/billing", cancelUrl: "/billing" }, plan);
  const manage = () => go("/subscription/billing-portal", { returnUrl: "/billing" }, "manage");
</script>

<main>
  <h1 tabindex="-1">Billing</h1>
  {#if !user || !view}
    <p>Sign in to manage billing</p>
    <a href="/sign-in">Sign in</a>
  {:else}
    <section aria-labelledby="plan-title">
      <h2 id="plan-title">Your plan</h2>
      {#if view.state === "none"}
        <p>You're not on a plan.</p>
      {:else if view.state === "active"}
        <p>{view.plan}. Renews on {view.date}.</p>
      {:else if view.state === "trialing"}
        <p>{view.plan}, free trial. The trial ends on {view.date}.</p>
      {:else if view.state === "cancelling"}
        <p>{view.plan}. Cancelling, ends on {view.date}. You keep access until then.</p>
      {:else if view.state === "past_due"}
        <p role="alert">{view.plan}. Your last payment failed. Fix your card in Manage billing to keep access.</p>
      {:else if view.state === "unpaid"}
        <p role="alert">{view.plan} is paused because payments failed. Fix your card in Manage billing.</p>
      {:else if view.state === "canceled"}
        <p>Your {view.plan} plan has ended.</p>
      {/if}
      {#if !configured}
        <p role="status">Stripe isn't set up yet.</p>
      {:else if view.canManage}
        <button type="button" onclick={manage} disabled={!!pending}>{pending === "manage" ? "Opening…" : "Manage billing"}</button>
      {/if}
    </section>
    {#if configured && view.canSubscribe}
      <section aria-labelledby="subscribe-title">
        <h2 id="subscribe-title">Choose a plan</h2>
        <ul>
          {#each plans as plan (plan.name)}
            <li>
              <button type="button" onclick={() => subscribe(plan.name)} disabled={!!pending}>
                {pending === plan.name ? "Opening checkout…" : `Subscribe to ${plan.label}, ${price(plan.monthly, plan.currency)} a month`}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  {/if}
</main>
