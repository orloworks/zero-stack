import { expect, it } from "vite-plus/test";
import { signedIn } from "./signed-in";

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
