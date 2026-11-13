<script lang="ts">
  import { auth } from "void/client";

  let email = $state("");
  let password = $state("");
  let error = $state("");

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const res = await auth.signIn.email({ email, password });
    if (res.error) error = res.error.message ?? "Sign in failed";
    else location.href = "/";
  }
</script>

<main>
  <h1>Sign in</h1>
  <form onsubmit={submit}>
    <input bind:value={email} name="email" type="email" placeholder="Email" required />
    <input bind:value={password} name="password" type="password" placeholder="Password" required />
    <button type="submit">Sign in</button>
    {#if error}<p role="alert">{error}</p>{/if}
  </form>
  <a href="/sign-up">Create an account</a>
</main>
