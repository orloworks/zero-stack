// Shared by gate.ts and the check modules: the constants, the context every module gets, and the sign-up / inbox helpers that the auth, allowlist
// and admin checks all use. It holds no test data (users, links): auth returns what later checks need and gate.ts passes it on.
// No top-level side effects, so a test can import it.
import type { Config } from "../../src/flags";
import { cookieOf, type GateHarness, hasTable, SET_PASSWORD_SUBJECT } from "./harness";

// The origin the gate's auth extension trusts (#104); it is written into the scaffolded app before the build and asserted by the auth checks.
export const GATE_ORIGIN = "https://gate-app.example";
// The password the gate gives the users it makes.
export const GATE_PW = "gate-password-123";

// What every check module receives from gate.ts.
export type Ctx = {
  config: Config;
  app: string; // the scaffolded app
  root: string; // the gate's temp folder (the app and every scratch file live under it)
  name: string; // the app's name
  vp: string; // the app's vite-plus binary
  argv: string[]; // the gate's own arguments
  h: GateHarness;
  step: (args: string[]) => Promise<void>; // a vp command in the app
};

export function authHelpers(h: GateHarness) {
  const { onUser } = h;
  // --invite-only helpers. The gate checks a proven email, so an invited sign-up makes no session and sends a verification mail whose link signs the user in.
  const authPost = (b: string, path: string, body: object) => h.authPost(path, body, b);
  const mailUrls = (b: string, subject: string, to: string) => h.mailUrls(subject, to, b);
  const mailUrl = (b: string, subject: string, to: string) => h.mailUrl(subject, to, b);
  const waitMails = (b: string, subject: string, to: string, n: number) => h.waitMails(subject, to, n, b);
  // --invite-only: the inbox owner picks the password. Every mail to an unverified user is a set-password link; following it lands on /reset-password?token=.
  const SET_PW = SET_PASSWORD_SUBJECT;
  const setPassword = (b: string, link: URL, newPassword: string) => h.setPassword(link, newPassword, b);
  const signInStatus = async (b: string, address: string, password: string) => (await authPost(b, "/api/auth/sign-in/email", { email: address, password })).status;
  const isVerified = (address: string) => !!onUser(address, "SELECT ?").emailVerified;
  // Stands in for the link expiring: removes the user's set-password rows, so the next accepted request may mail again.
  const dropLinks = (address: string) => onUser(address, "DELETE FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'");
  // Invited: the sign-up (as the page sends it, with no password) succeeds with no session cookie and mails one set-password link and no verify link;
  // setting the password through it verifies the email, and that password then signs in.
  const signUpVerified = (b: string, address: string, password = GATE_PW) => h.makeUser(address, { password, base: b });
  // Refused: no session, no user row, no mail. Status: a 200 (with verification on, Better Auth answers a refused sign-up with a placeholder user) or a 4xx (a malformed address is rejected before the hook).
  const inviteRefused = async (b: string, address: string) => {
    const r = await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: address, password: GATE_PW });
    if (r.status !== 200 && (r.status < 400 || r.status >= 500)) throw new Error(`refused sign-up for ${address} -> ${r.status}`);
    if (cookieOf(r)) throw new Error(`refused sign-up for ${address} set a cookie`);
    if (h.hasUser(address)) throw new Error(`${address} was refused but has a user row`);
    for (const subject of [SET_PW, "Verify your email"]) if (await mailUrl(b, subject, address)) throw new Error(`${address} was refused but got a "${subject}" mail`);
    if ((await authPost(b, "/api/auth/sign-in/email", { email: address, password: GATE_PW })).ok) throw new Error(`${address} was refused but can sign in`);
  };
  // Keys are read back from the local R2 state (miniflare's _mf_objects) to prove what is stored.
  // Only the sqlite files with an _mf_objects table are R2's; any read error on one of them fails the gate.
  const r2Keys = () => {
    let found = false;
    const keys = h.eachDb((d, f) => {
      try {
        if (!hasTable(d, "_mf_objects")) return [];
        found = true;
        return (d.query("SELECT key FROM _mf_objects").all() as { key: string }[]).map((r) => r.key);
      } catch (e) { throw new Error(`cannot read R2 keys from ${f}: ${(e as Error).message}`); }
    }, { readonly: true }).flat();
    if (!found) throw new Error("no local R2 database (_mf_objects) found under .void");
    return keys;
  };
  return { authPost, mailUrls, mailUrl, waitMails, SET_PW, setPassword, signInStatus, isVerified, dropLinks, signUpVerified, inviteRefused, r2Keys };
}
