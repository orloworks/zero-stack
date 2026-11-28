<script lang="ts">
  import { LISTS } from "../src/app/lists";
  import { mountTurnstile, type Turnstile } from "../src/lib/turnstile";

  // Public: no account needed. Edit the words and the layout freely; keep the Turnstile widget and the post to /api/lists/subscribe.
  let list = $state<string>(LISTS[0]?.name ?? "");
  let email = $state("");
  let pending = $state(false);
  let message = $state("");
  let failed = $state(false);
  let token = $state<string | null>(null);
  let checkFailed = $state(false);
  let turnstileEl: HTMLElement | undefined = $state();
  let turnstile: Turnstile | undefined;
  $effect(() => {
    if (!turnstileEl) return;
    const t = (turnstile = mountTurnstile(turnstileEl, { onToken: (v) => (token = v), onError: () => (checkFailed = true) }));
    return () => t.dispose();
  });
  const chosen = $derived(LISTS.find((l) => l.name === list));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    pending = true;
    message = "";
    try {
      const res = await fetch("/api/lists/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-captcha-response": turnstile?.token() ?? "" },
        body: JSON.stringify({ email, list }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      failed = !res.ok;
      message = body.message ?? (res.ok ? "Check your inbox to confirm" : "Something went wrong. Try again.");
    } catch {
      failed = true;
      message = "Something went wrong. Check your connection and try again.";
    } finally {
      turnstile?.reset();
      pending = false;
    }
  }
</script>

<main>
  <h1>Subscribe</h1>
  {#if LISTS.length === 0}
    <p>There are no mailing lists yet.</p>
  {:else}
    <form onsubmit={submit}>
      {#if LISTS.length > 1}
        <label for="list">List</label>
        <select id="list" bind:value={list} name="list">
          {#each LISTS as l (l.name)}<option value={l.name}>{l.label}</option>{/each}
        </select>
      {/if}
      {#if chosen}<p>{chosen.label}: {chosen.description}</p>{/if}
      <label for="email">Email</label>
      <input id="email" bind:value={email} name="email" type="email" autocomplete="email" required />
      <div bind:this={turnstileEl}></div>
      {#if checkFailed}<p role="alert">Couldn't load the verification check. Reload the page to try again.</p>{:else if !token}<p role="status">Completing a quick check…</p>{/if}
      <button type="submit" disabled={pending || !token}>{pending ? "Sending…" : "Subscribe"}</button>
      <p>We will mail you a link to confirm. Nothing else is sent until you do.</p>
      {#if message}<p role={failed ? "alert" : "status"}>{message}</p>{/if}
    </form>
  {/if}
</main>
