<script lang="ts">
  import { auth } from "void/client";
  import type { Props } from "./settings.server";

  let { user }: Props = $props();

  let current = $state("");
  let next = $state("");
  let pending = $state(false);
  let error = $state("");
  let wrongCurrent = $state(false);
  let done = $state(false);

  async function changePassword(e: SubmitEvent) {
    e.preventDefault();
    pending = true;
    error = "";
    wrongCurrent = false;
    done = false;
    try {
      const res = await auth.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
      if (res.error) {
        wrongCurrent = res.error.code === "INVALID_PASSWORD";
        error = wrongCurrent ? "Current password is incorrect." : (res.error.message ?? "Couldn't update the password.");
      } else {
        current = "";
        next = "";
        done = true;
      }
    } catch {
      error = "Something went wrong. Check your connection and try again.";
    } finally {
      pending = false;
    }
  }
</script>

<main>
  {#if user}
    <h1 tabindex="-1">Account</h1>
    <p>Signed in as {user.email}</p>
    <section aria-labelledby="change-password-title">
      <h2 id="change-password-title">Change password</h2>
      <form onsubmit={changePassword}>
        <label for="current-password">Current password</label>
        <input
          id="current-password"
          bind:value={current}
          name="currentPassword"
          type="password"
          autocomplete="current-password"
          aria-invalid={wrongCurrent || undefined}
          aria-describedby={wrongCurrent ? "change-password-error" : undefined}
          required
        />
        <label for="new-password">New password</label>
        <input
          id="new-password"
          bind:value={next}
          name="newPassword"
          type="password"
          autocomplete="new-password"
          minlength="8"
          aria-describedby="new-password-hint"
          required
        />
        <p id="new-password-hint">At least 8 characters</p>
        <button type="submit" disabled={pending}>{pending ? "Updating password…" : "Update password"}</button>
        {#if error}<p id="change-password-error" role="alert">{error}</p>{/if}
        {#if done}<p role="status">Password updated. Other devices have been signed out.</p>{/if}
      </form>
    </section>
    <!-- zero-stack:account-deletion -->
  {:else}
    <h1 tabindex="-1">Account</h1>
    <p>Sign in to manage your account</p>
    <a href="/sign-in">Sign in</a>
  {/if}
</main>
