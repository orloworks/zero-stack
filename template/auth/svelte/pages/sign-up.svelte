<script lang="ts">
  import { auth } from "void/client";

  let name = $state("");
  let email = $state("");
  let password = $state("");
  let pending = $state(false);
  let error = $state("");
  let invalid = $state(false); // aria-invalid only for server-rejected input, not network failures
  let alertEl: HTMLElement | undefined = $state();

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    pending = true;
    error = "";
    invalid = false;
    try {
      const res = await auth.signUp.email({ name, email, password });
      if (res.error) (error = res.error.message ?? "Sign up failed"), (invalid = true);
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
  <h1>Sign up</h1>
  <form onsubmit={submit}>
    <label for="name">Name</label>
    <input id="name" bind:value={name} name="name" autocomplete="name" required aria-invalid={invalid || undefined} aria-describedby={error ? "form-error" : undefined} />
    <label for="email">Email</label>
    <input id="email" bind:value={email} name="email" type="email" autocomplete="email" required aria-invalid={invalid || undefined} aria-describedby={error ? "form-error" : undefined} />
    <label for="password">Password</label>
    <input id="password" bind:value={password} name="password" type="password" autocomplete="new-password" minlength="8" required aria-invalid={invalid || undefined} aria-describedby={error ? "password-hint form-error" : "password-hint"} />
    <p id="password-hint">At least 8 characters</p>
    <!-- zero-stack:turnstile -->
    <button type="submit" disabled={pending}>{pending ? "Creating account…" : "Sign up"}</button>
    {#if error}<p id="form-error" role="alert" tabindex="-1" bind:this={alertEl}>{error}</p>{/if}
  </form>
  <a href="/sign-in">Already have an account?</a>
</main>
