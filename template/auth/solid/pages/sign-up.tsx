import { createSignal, Show } from "solid-js";
import { auth } from "void/client";

export default function SignUp() {
  const [error, setError] = createSignal("");
  return (
    <main>
      <h1>Sign up</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const res = await auth.signUp.email({
            name: String(f.get("name")),
            email: String(f.get("email")),
            password: String(f.get("password")),
          });
          if (res.error) setError(res.error.message ?? "Sign up failed");
          else location.href = "/";
        }}
      >
        <input name="name" placeholder="Name" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" minLength={8} required />
        <button type="submit">Sign up</button>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </form>
      <a href="/sign-in">Already have an account?</a>
    </main>
  );
}
