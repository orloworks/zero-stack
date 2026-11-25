import { expect, it } from "vite-plus/test";
import { envValue, signedIn } from "./signed-in";

// `secrets:pull` writes KEY='value'; a secret read with its quotes signs a cookie the app rejects.
it("reads a quoted .env value without its quotes", () => {
  const text = "A_KEY='abc=def'\nB_KEY=\"x y\"\nC_KEY=plain\nD_KEY='odd\n";
  expect([envValue(text, "A_KEY"), envValue(text, "B_KEY"), envValue(text, "C_KEY"), envValue(text, "D_KEY"), envValue(text, "NONE")]).toEqual(["abc=def", "x y", "plain", "'odd", ""]);
});

// Needs a running dev server (`vp dev`, then DEV_URL=http://localhost:5173 vp test tests/signed-in.test.ts); skipped otherwise, so `bun run verify` stays offline.
const url = process.env.DEV_URL;
const SLOW = 30_000;

it.skipIf(!url)("signedIn() gives a verified user the running app accepts", async () => {
  const { headers, user } = await signedIn();
  const res = await fetch(`${url}/api/auth/get-session`, { headers });
  expect(res.status).toBe(200);
  const session = (await res.json()) as { user: { id: string; emailVerified: boolean } };
  expect(session.user).toMatchObject({ id: user.id, emailVerified: true });
}, SLOW);

it.skipIf(!url)("a request without the helper's cookie has no session", async () => {
  const res = await fetch(`${url}/api/auth/get-session`);
  expect(await res.json()).toBeNull();
}, SLOW);
