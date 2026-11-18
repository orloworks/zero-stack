<script lang="ts">
  import { onMount } from "svelte";
  import { auth } from "void/client";

  // The token is read once, then dropped from the URL (history, shared URLs); a reload shows the expired state.
  let token = "";
  let view = $state<"loading" | "invalid" | "form">("loading");
  let password = $state("");
  let pending = $state(false);
  let error = $state("");
  let invalid = $state(false); // aria-invalid only for server-rejected input, not network failures
  let headingEl: HTMLElement | undefined = $state();
  let alertEl: HTMLElement | undefined = $state();

  onMount(() => {
    const params = new URLSearchParams(location.search);
    token = params.get("token") ?? "";
    view = token && !params.get("error") ? "form" : "invalid";
    history.replaceState(null, "", location.pathname);
  });
  $effect(() => {
    if (view !== "loading") headingEl?.focus();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    pending = true;
    error = "";
    invalid = false;
    try {
      const res = await auth.resetPassword({ newPassword: password, token });
      if (!res.error) {
        location.href = "/sign-in?reset=1";
        return;
      }
      if (res.error.code === "INVALID_TOKEN") view = "invalid";
      else (error = res.error.message || "Couldn't update the password."), (invalid = true);
    } catch {
      error = "Something went wrong. Check your connection and try again.";
    }
    pending = false;
    queueMicrotask(() => alertEl?.focus());
  }
</script>

<svelte:head><meta name="referrer" content="no-referrer" /></svelte:head>

<main>
  {#if view === "loading"}
    <h1>Reset your password</h1>
    <p role="status">Loading…</p>
  {:else if view === "invalid"}
    <h1 tabindex="-1" bind:this={headingEl}>Reset your password</h1>
    <p>This reset link has expired or was already used.</p>
    <a href="/forgot-password">Request a new link</a>
  {:else}
    <h1 tabindex="-1" bind:this={headingEl}>Choose a new password</h1>
    <form onsubmit={submit}>
      <label for="new-password">New password</label>
      <input id="new-password" bind:value={password} name="newPassword" type="password" autocomplete="new-password" minlength="8" required aria-invalid={invalid || undefined} aria-describedby={error ? "password-hint form-error" : "password-hint"} />
      <p id="password-hint">At least 8 characters</p>
      <button type="submit" disabled={pending}>{pending ? "Updating password…" : "Update password"}</button>
      {#if error}<p id="form-error" role="alert" tabindex="-1" bind:this={alertEl}>{error}</p>{/if}
    </form>
  {/if}
</main>
