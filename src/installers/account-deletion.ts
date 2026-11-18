import { editFile, replaceAnchor } from "../anchor";
import type { Config } from "../flags";

const PAGE = "pages/settings.svelte";

// Adds the Delete account section to the svelte Account page (marker left by installAuth). Svelte only (D33).
// The copy is built from `files` so --storage can add its clause; --storage maps its partial-purge code to the D14 copy.
export function installAccountDeletion(dir: string, config: Config): void {
  const files = config.storage ? " and uploaded files" : "";
  // The purge runs before the user is deleted and aborts on any error, so some files may be gone while the account remains (D7, D14).
  const partial = config.storage
    ? ' : res.error.code === "STORAGE_PURGE_FAILED" ? "Your account was not deleted, but some of your files may already have been removed. Try again to finish deleting your account."'
    : "";
  editFile(dir, PAGE, (s) => {
    s = replaceAnchor(s, "  let done = $state(false);\n", `  let done = $state(false);

  let deletePassword = $state("");
  let deleting = $state(false);
  let deleteError = $state("");
  let wrongPassword = $state(false);
  let deleted = $state(false);
  let endingHeading = $state<HTMLElement>();
  $effect(() => endingHeading?.focus());

  async function deleteAccount(e: SubmitEvent) {
    e.preventDefault();
    deleting = true;
    deleteError = "";
    wrongPassword = false;
    try {
      const res = await auth.deleteUser({ password: deletePassword });
      if (res.error) {
        wrongPassword = res.error.code === "INVALID_PASSWORD";
        deleteError = wrongPassword ? "Incorrect password."${partial} : (res.error.message ?? "Couldn't delete the account.");
      } else {
        deleted = true;
      }
    } catch {
      deleteError = "Something went wrong. Check your connection and try again.";
    } finally {
      deleting = false;
    }
  }
`, PAGE);
    s = replaceAnchor(s, "  {#if user}\n", `  {#if deleted}
    <h1 tabindex="-1" bind:this={endingHeading}>Account deleted</h1>
    <p>Your account and its data${files} have been permanently deleted.</p>
    <a href="/">Back to home</a>
  {:else if user}
`, PAGE);
    return replaceAnchor(s, "    <!-- zero-stack:account-deletion -->\n", `    <section aria-labelledby="delete-account-title">
      <h2 id="delete-account-title">Delete account</h2>
      <p>This permanently deletes your account and all its data${files}. It can't be undone.</p>
      <form onsubmit={deleteAccount}>
        <label for="delete-password">Current password</label>
        <input
          id="delete-password"
          bind:value={deletePassword}
          name="password"
          type="password"
          autocomplete="current-password"
          aria-invalid={wrongPassword || undefined}
          aria-describedby={wrongPassword ? "delete-account-error" : undefined}
          required
        />
        <button type="submit" disabled={deleting}>{deleting ? "Deleting account…" : "Delete account permanently"}</button>
        {#if deleteError}<p id="delete-account-error" role="alert">{deleteError}</p>{/if}
      </form>
    </section>
`, PAGE);
  });
}
