// Module 4: --invite-only, the allowlist restarts: exact entries, then a list with no entries (fail closed), and the de-listed pending user.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cookieOf } from "../harness";
import { authHelpers, type Ctx, GATE_PW } from "../shared";
import type { InviteUsers } from "./auth";

export async function allowlistChecks(ctx: Ctx, { kept, pending, pendingLink }: InviteUsers): Promise<void> {
  const { config, app, h } = ctx;
  const { authPost, mailUrls, waitMails, SET_PW, setPassword, isVerified, dropLinks, signUpVerified, inviteRefused } = authHelpers(h);
  if (config.inviteOnly) {
    // The list is read at startup: restart the dev server on a changed .env. Exact entries, then a list with no entries (fail closed).
    const envFile = join(app, ".env"), original = readFileSync(envFile, "utf8");
    const withList = (list: string) => h.restart(original, { SIGNUP_ALLOWLIST: list });
    try {
      const exact = `exact-${Date.now()}@partner.test`;
      let b = await withList(`${exact.toUpperCase()},other@partner.test`);
      await signUpVerified(b, exact); // an exact list entry admits its email (any case)
      await inviteRefused(b, `other2-${Date.now()}@partner.test`); // a different address on the same domain is not a domain entry
      await inviteRefused(b, `nobody-${Date.now()}@example.com`); // the list no longer holds @example.com
      if (!(await authPost(b, "/api/auth/sign-in/email", { email: kept, password: GATE_PW })).ok) throw new Error("an existing user could not sign in after the list changed");
      // The list no longer holds the pending user's address: an earlier set-password link and a forgot-password link are refused and do not verify,
      // and a sign-in (after its link is gone) mails nothing. A verified user who was removed from the list still resets their password.
      const pendingPw = "pending-password-1";
      for (const link of [pendingLink!, null]) {
        let l = link;
        if (!l) {
          await authPost(b, "/api/auth/request-password-reset", { email: pending, redirectTo: "/reset-password" });
          [l] = await waitMails(b, "Reset your password", pending, 1);
          if (!l) throw new Error(`no forgot-password mail for ${pending}`);
        }
        const r = await setPassword(b, l!, pendingPw);
        if (r.ok || isVerified(pending)) throw new Error(`a de-listed pending user's ${link ? "set-password" : "forgot-password"} link -> ${r.status}, verified ${isVerified(pending)}`);
        const s = await authPost(b, "/api/auth/sign-in/email", { email: pending, password: pendingPw });
        if (s.ok || cookieOf(s)) throw new Error(`a de-listed pending user signed in -> ${s.status}`);
      }
      dropLinks(pending);
      const before = (await mailUrls(b, SET_PW, pending)).length;
      await authPost(b, "/api/auth/sign-in/email", { email: pending, password: "wrong-password-z" });
      await authPost(b, "/api/auth/sign-up/email", { name: "Pending", email: pending, password: "" });
      await Bun.sleep(1000);
      if ((await mailUrls(b, SET_PW, pending)).length !== before) throw new Error("a de-listed pending user's sign-in or sign-up mailed a set-password link");
      await authPost(b, "/api/auth/request-password-reset", { email: kept, redirectTo: "/reset-password" });
      const [keptLink] = await waitMails(b, "Reset your password", kept, 1);
      if (!keptLink || !(await setPassword(b, keptLink, GATE_PW + "-2")).ok) throw new Error("a verified, de-listed user could not reset their password");
      if (!(await authPost(b, "/api/auth/sign-in/email", { email: kept, password: GATE_PW + "-2" })).ok) throw new Error("a verified, de-listed user could not sign in after a reset");
      console.log("gate: invite-only re-checks the list when the inbox is proven: a de-listed pending user's set-password and forgot-password links are refused and do not verify, its sign-in mails nothing; a verified, de-listed user still resets and signs in");
      // A truly empty value fails Void's required-env check (every request is a 500, so nothing is admitted); a list of only separators is the empty list the matcher sees.
      b = await withList(",");
      await inviteRefused(b, `nobody-${Date.now()}@example.com`);
      await inviteRefused(b, `nobody-${Date.now()}@partner.test`);
      if (!(await authPost(b, "/api/auth/sign-in/email", { email: kept, password: GATE_PW + "-2" })).ok) throw new Error("an existing user could not sign in with an empty list");
      console.log("gate: invite-only exact entry admits (any case) and a same-domain address is refused; a list with no entries refuses everyone; existing users still sign in");
    } finally {
      writeFileSync(envFile, original);
    }
  }
}
