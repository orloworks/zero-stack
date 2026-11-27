<script lang="ts">
  import type { Props } from "./confirm.server";

  // The page a confirmation mail opens. Edit the words freely; keep the POST to /api/lists/confirm as the only thing that records consent.
  let { token, status, label }: Props = $props();

  let pending = $state(false);
  let outcome = $state<"" | "confirmed" | "failed">("");

  async function confirm() {
    pending = true;
    try {
      const res = await fetch("/api/lists/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      outcome = res.ok ? "confirmed" : "failed";
    } catch {
      outcome = "failed";
    } finally {
      pending = false;
    }
  }
</script>

<main>
  <h1>Confirm your subscription</h1>
  {#if status === "confirmed" || outcome === "confirmed"}
    <p role="status">You are subscribed to {label}.</p>
  {:else if status === "expired"}
    <p>This link is older than seven days. <a href="/subscribe">Ask for a new one</a>.</p>
  {:else if status === "ready"}
    <p>Press Confirm to get {label} at this address.</p>
    <button type="button" onclick={confirm} disabled={pending}>{pending ? "Confirming…" : "Confirm"}</button>
    {#if outcome === "failed"}<p role="alert">Couldn't confirm. <a href="/subscribe">Ask for a new link</a>.</p>{/if}
  {:else}
    <p>This link isn't valid. <a href="/subscribe">Ask for a new one</a>.</p>
  {/if}
</main>
