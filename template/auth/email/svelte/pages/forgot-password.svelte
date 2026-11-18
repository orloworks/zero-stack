<script lang="ts">
  import { auth } from "void/client";

  let email = $state("");
  let pending = $state(false);
  let error = $state("");
  let sent = $state(false);
  let alertEl: HTMLElement | undefined = $state();
  let sentEl: HTMLElement | undefined = $state();

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    pending = true;
    error = "";
    try {
      const res = await auth.requestPasswordReset({ email, redirectTo: "/reset-password" });
      // Neutral copy only when the request was accepted; a rejection (captcha, rate limit) keeps the form.
      if (res.error) error = res.error.message || "Couldn't send the reset link. Try again.";
      else sent = true;
    } catch {
      error = "Something went wrong. Check your connection and try again.";
    }
    pending = false;
    queueMicrotask(() => (sent ? sentEl : alertEl)?.focus());
  }
</script>

<main>
  <h1>Reset your password</h1>
  {#if sent}
    <p role="status" tabindex="-1" bind:this={sentEl}>If an account exists for that email, we've sent a reset link. Check your spam folder too.</p>
  {:else}
    <form onsubmit={submit}>
      <label for="email">Email</label>
      <input id="email" bind:value={email} name="email" type="email" autocomplete="email" required aria-invalid={error ? "true" : undefined} aria-describedby={error ? "form-error" : undefined} />
      <!-- zero-stack:turnstile -->
      <button type="submit" disabled={pending}>{pending ? "Sending link…" : "Send reset link"}</button>
      {#if error}<p id="form-error" role="alert" tabindex="-1" bind:this={alertEl}>{error}</p>{/if}
    </form>
  {/if}
  <a href="/sign-in">Back to sign in</a>
</main>
