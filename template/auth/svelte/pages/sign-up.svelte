<script lang="ts">
  import { auth } from "void/client";

  let name = $state("");
  let email = $state("");
  let password = $state("");
  let error = $state("");

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const res = await auth.signUp.email({ name, email, password });
    if (res.error) error = res.error.message ?? "Sign up failed";
    else location.href = "/";
  }
</script>

<main>
  <h1>Sign up</h1>
  <form onsubmit={submit}>
    <input bind:value={name} name="name" placeholder="Name" required />
    <input bind:value={email} name="email" type="email" placeholder="Email" required />
    <input bind:value={password} name="password" type="password" placeholder="Password" minlength="8" required />
    <button type="submit">Sign up</button>
    {#if error}<p role="alert">{error}</p>{/if}
  </form>
  <a href="/sign-in">Already have an account?</a>
</main>
