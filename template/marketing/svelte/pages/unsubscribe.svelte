<script lang="ts">
  import type { Props } from "./unsubscribe.server";

  // The page the unsubscribe link in a marketing mail opens. Edit the words freely; keep the posts to /api/lists/unsubscribe (no sign-in needed) and /api/lists/resubscribe.
  let { token, list, label }: Props = $props();

  let pending = $state(false);
  let done = $state<"" | "list" | "all">("");
  let error = $state("");
  let again = $state("");

  async function post(path: string, body: Record<string, string>, query = "") {
    const res = await fetch(path + query, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, message: ((await res.json().catch(() => ({}))) as { message?: string }).message ?? "" };
  }

  async function leave(scope: "list" | "all") {
    pending = true;
    error = again = "";
    try {
      const res = await post("/api/lists/unsubscribe", { scope }, `?token=${encodeURIComponent(token)}&list=${encodeURIComponent(list)}`);
      if (res.ok) done = scope;
      else error = "Couldn't unsubscribe. Try again.";
    } catch {
      error = "Something went wrong. Check your connection and try again.";
    } finally {
      pending = false;
    }
  }

  async function subscribeAgain() {
    pending = true;
    error = again = "";
    try {
      const res = await post("/api/lists/resubscribe", { token, list });
      if (res.ok) again = res.message;
      else error = res.message || "Couldn't send the confirmation mail. Try again later.";
    } catch {
      error = "Something went wrong. Check your connection and try again.";
    } finally {
      pending = false;
    }
  }
</script>

<main>
  <h1>Unsubscribe</h1>
  {#if done}
    <p role="status">You are unsubscribed{done === "all" ? " from everything" : label ? ` from ${label}` : ""}.</p>
    {#if label}
      <p>Changed your mind? We will mail you a link to confirm; nothing is sent until you press it.</p>
      <button type="button" onclick={subscribeAgain} disabled={pending}>Subscribe again</button>
    {/if}
    {#if again}<p role="status">{again}</p>{/if}
  {:else}
    {#if label}<p><button type="button" onclick={() => leave("list")} disabled={pending}>Unsubscribe from {label}</button></p>{/if}
    <p><button type="button" onclick={() => leave("all")} disabled={pending}>Unsubscribe from everything</button></p>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>
