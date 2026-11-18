<script lang="ts">
  import { auth } from "void/client";

  let email = $state("");
  let password = $state("");
  let pending = $state(false);
  let error = $state("");
  let alertEl: HTMLElement | undefined = $state();

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    pending = true;
    error = "";
    try {
      const res = await auth.signIn.email({ email, password });
      if (res.error) error = res.error.message ?? "Sign in failed";
      else {
        location.href = "/";
        return;
      }
    } catch {
      error = "Something went wrong. Check your connection and try again.";
    }
    pending = false;
    queueMicrotask(() => alertEl?.focus());
  }
</script>

<main>
  <h1>Sign in</h1>
  <!-- zero-stack:sign-in-notice -->
  <form onsubmit={submit}>
    <label for="email">Email</label>
    <input id="email" bind:value={email} name="email" type="email" autocomplete="email" required aria-invalid={error ? "true" : undefined} aria-describedby={error ? "form-error" : undefined} />
    <label for="password">Password</label>
    <input id="password" bind:value={password} name="password" type="password" autocomplete="current-password" required aria-invalid={error ? "true" : undefined} aria-describedby={error ? "form-error" : undefined} />
    <!-- zero-stack:sign-in-forgot-link -->
    <!-- zero-stack:turnstile -->
    <button type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    {#if error}<p id="form-error" role="alert" tabindex="-1" bind:this={alertEl}>{error}</p>{/if}
  </form>
  <a href="/sign-up">Create an account</a>
</main>
