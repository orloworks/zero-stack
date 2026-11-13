import { useState } from "react";
import { auth } from "void/client";

export default function SignIn() {
  const [error, setError] = useState("");
  return (
    <main>
      <h1>Sign in</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const res = await auth.signIn.email({ email: String(f.get("email")), password: String(f.get("password")) });
          if (res.error) setError(res.error.message ?? "Sign in failed");
          else location.href = "/";
        }}
      >
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
        {error && <p role="alert">{error}</p>}
      </form>
      <a href="/sign-up">Create an account</a>
    </main>
  );
}
