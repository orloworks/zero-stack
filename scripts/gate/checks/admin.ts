// Module 5: --admin, with its features, settings, invites and de-list restarts woven in (one sequence, so one module).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cookieOf } from "../harness";
import { authHelpers, type Ctx, GATE_PW } from "../shared";

export async function adminChecks(ctx: Ctx): Promise<void> {
  const { config, app, h } = ctx;
  const { onUser, idOf } = h;
  const { authPost, waitMails, SET_PW, setPassword, isVerified, signUpVerified, inviteRefused, r2Keys } = authHelpers(h);
  if (config.admin) {
    // --admin: /admin and /api/auth/admin/* answer to ADMIN_EMAILS (verified, live) and nobody else. The list is read at startup, so each list change restarts the dev server.
    const envFile = join(app, ".env"), original = readFileSync(envFile, "utf8");
    // `signup`: leave the scaffold's SIGNUP_ALLOWLIST (undefined), set it, or remove the key (null; only with --invite-only, where it is optional).
    const withAdmins = (list: string, signup?: string | null) => h.restart(original, { ADMIN_EMAILS: list, ...(signup !== undefined && { SIGNUP_ALLOWLIST: signup }) });
    // Rows in the app database (user, audit_entry, ...): the one sqlite file that has `table`.
    const rows = (table: string, sql: string, ...args: (string | number)[]) => h.withDb(table, (d) => d.query(sql).all(...args) as any[], { readonly: true });
    const ts = Date.now();
    const addr = (n: string) => `${n}-${ts}@example.com`;
    const [boss, plain, owner2, victim, other] = [addr("boss"), addr("plain"), addr("owner2"), addr("victim"), addr("other")];
    const call = (b: string, method: string, path: string, cookie = "", body?: object) => h.request(path, { base: b, method, redirect: "manual", cookie, body });
    const html = (b: string, path: string, cookie = "") => call(b, "GET", path, cookie).then(async (r) => ({ status: r.status, text: await r.text(), location: r.headers.get("location") }));
    const sessionUser = (b: string, cookie: string) => fetch(`${b}/api/auth/get-session`, { headers: { cookie } }).then((r) => r.json() as Promise<any>).then((j) => j?.user ?? null);
    // A user with a session: a verified one signs in (in an invite-only app the set-password link verifies and sets the password); an unverified one only exists in an app that lets sign-in wait on mail.
    const mk = async (b: string, address: string, verified = true) => {
      const cookie = await h.makeUser(address, { password: GATE_PW, base: b, inviteLink: verified, markVerified: verified });
      return { id: idOf(address), cookie };
    };
    const upload = (b: string, cookie: string, name: string, body: string) => fetch(`${b}/api/files/${name}`, { method: "PUT", body, headers: { cookie, "content-type": "text/plain" } }).then((r) => r.status);
    const signIn = (b: string, address: string, password = GATE_PW) => authPost(b, "/api/auth/sign-in/email", { email: address, password });
    // The 404 matrix: pages, the plugin's endpoints and our own admin route.
    const adminPaths = (id: string): [string, string][] => [["GET", "/admin"], ["GET", "/admin/audit"], ["GET", `/admin/users/${id}`], ["GET", "/admin/users"], ["GET", "/api/auth/admin/list-users"], ["GET", `/api/auth/admin/get-user?id=${id}`], ["POST", `/api/admin/users/${id}/send-link`], ["GET", "/admin/features"], ["GET", "/admin/settings"]];
    const expectAll = async (b: string, who: string, cookie: string, id: string, want: (m: string, p: string) => number) => {
      for (const [m, p] of adminPaths(id)) {
        const r = await call(b, m, p, cookie, m === "POST" ? { userId: id } : undefined);
        if (r.status !== want(m, p)) throw new Error(`${who}: ${m} ${p} -> ${r.status}, expected ${want(m, p)}`);
      }
    };
    const REFUSED = ["set-role", "create-user", "update-user", "set-user-password", "impersonate-user", "stop-impersonating", "has-permission"];
    const auditRows = () => rows("audit_entry", "SELECT * FROM audit_entry ORDER BY created_at");
    const noMail = async (a: string) => { if (rows("audit_entry", "SELECT 1 FROM audit_entry WHERE actor_email = ? OR target_email = ? OR detail LIKE ?", a.toLowerCase(), a.toLowerCase(), `%${a.toLowerCase()}%`).length) throw new Error(`the audit log still holds ${a}`); };

    try {
      let b = await withAdmins(`${boss},${owner2}`);
      const bossU = await mk(b, boss), plainU = await mk(b, plain), victimU = await mk(b, victim), otherU = await mk(b, other);
      const ownerU = config.inviteOnly ? null : await mk(b, owner2, false); // listed, not verified: sign-in waits on nothing here
      // 404 for signed out, a signed-in non-admin and a listed but unverified user; 200 for the admin.
      const any = [["signed out", ""], ["non-admin", plainU.cookie], ...(ownerU ? [["listed, unverified", ownerU.cookie]] : [])] as [string, string][];
      for (const [who, cookie] of any) await expectAll(b, who, cookie, victimU.id, () => 404);
      for (const [m, p] of adminPaths(victimU.id)) {
        const r = await call(b, m, p, bossU.cookie, m === "POST" ? { userId: victimU.id } : undefined);
        const want = p === "/admin/users" ? 302 : 200;
        if (r.status !== want) throw new Error(`admin: ${m} ${p} -> ${r.status}, expected ${want}`);
        if (p === "/admin/users" && r.headers.get("location") !== "/admin") throw new Error(`/admin/users redirected to ${r.headers.get("location")}`);
      }
      // The path spelling does not matter: a case or encoding variant is refused for a non-admin too.
      for (const p of ["/ADMIN", "/Admin/audit", "/admin/", "/%61dmin"]) if ((await fetch(b + p, { headers: { cookie: plainU.cookie } })).status !== 404) throw new Error(`non-admin GET ${p} was not 404 (redirects followed)`);
      // The plugin's endpoints the pages do not use are refused, even for an admin; so is anything not on the allowlist.
      for (const e of REFUSED) {
        const r = await call(b, "POST", `/api/auth/admin/${e}`, bossU.cookie, { userId: victimU.id, role: "admin", email: addr("x"), password: "x-password-123", name: "x", newPassword: "x-password-123", data: {} });
        if (r.status !== 404) throw new Error(`admin POST /api/auth/admin/${e} -> ${r.status}, expected 404`);
      }
      if (rows("user", "SELECT 1 FROM user WHERE role = 'admin' AND id = ?", victimU.id).length) throw new Error("set-role changed a role");
      console.log("gate: admin 404 for signed out, non-admin" + (ownerU ? ", listed-unverified" : "") + ", case/encoding variants and the 7 refused endpoints; 200 for an admin; /admin/users redirects");

      // Sign-in writes lastSignInAt (E9) and never role: only the guard writes that.
      if (!rows("user", "SELECT lastSignInAt AS t FROM user WHERE id = ?", plainU.id)[0].t) throw new Error("sign-in did not write lastSignInAt");
      if (rows("user", "SELECT role FROM user WHERE id = ?", plainU.id)[0].role === "admin") throw new Error("a non-admin has role admin");

      // Grant on a live session (O3): a listed user who verifies after signing in reaches the plugin API on the same session; the guard is what writes role.
      if (ownerU) {
        onUser(owner2, "UPDATE user SET emailVerified = 1 WHERE id = ?");
        if ((await call(b, "GET", "/api/auth/admin/list-users", ownerU.cookie)).status !== 200) throw new Error("a newly verified, listed user did not reach list-users on their existing session");
        if (rows("user", "SELECT role FROM user WHERE id = ?", ownerU.id)[0].role !== "admin") throw new Error("the guard did not sync role");
        onUser(owner2, "UPDATE user SET emailVerified = 0 WHERE id = ?");
        if ((await call(b, "GET", "/api/auth/admin/list-users", ownerU.cookie)).status !== 404) throw new Error("a listed user who is no longer verified still reached list-users");
      }

      // Users page: the admin reaches it, search finds by email and by name, no match says so, paging.
      onUser(other, "UPDATE user SET name = 'Zed Zebrowski' WHERE id = ?");
      const page = await html(b, "/admin", bossU.cookie);
      for (const t of ["<caption>", 'scope="col"', 'aria-label="Admin"', 'aria-current="page"', "Back to app", "Search email or name", 'type="search"']) if (!page.text.includes(t)) throw new Error(`/admin lacks ${t}`);
      if (!page.text.includes(`>${victim}</a>`)) throw new Error("/admin does not list the newest users");
      const byEmail = await html(b, `/admin?q=${encodeURIComponent(other.toUpperCase())}`, bossU.cookie), byName = await html(b, "/admin?q=zebrowski", bossU.cookie);
      if (!byEmail.text.includes(`>${other}</a>`) || byEmail.text.includes(`>${victim}</a>`)) throw new Error("search by email (any case) did not narrow to the user");
      if (!byName.text.includes(`>${other}</a>`) || byName.text.includes(`>${victim}</a>`)) throw new Error("search by name did not find the user");
      const none = await html(b, "/admin?q=nobody-here-xyz", bossU.cookie);
      if (!none.text.includes("No account for nobody-here-xyz.")) throw new Error("no-match copy missing");
      const wild = await html(b, "/admin?q=%25", bossU.cookie);
      if (!wild.text.includes("No account for %.")) throw new Error("a % in the search was treated as a wildcard");
      // Paging: 50 a page, newest first, with the Showing line.
      const now = Date.now();
      const total = h.withDb("user", (db) => {
        for (let i = 0; i < 52; i++) db.run("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)", [`page-${ts}-${i}`, `Page ${i}`, `page-${i}-${ts}@fixture.test`, now - 86_400_000 - i * 1000, now]);
        return (db.query("SELECT count(*) AS n FROM user").get() as { n: number }).n;
      });
      const p1 = await html(b, "/admin", bossU.cookie), p2 = await html(b, "/admin?page=2", bossU.cookie);
      if (!p1.text.includes(`Showing 1–50 of ${total}`) || !p1.text.includes("Older") || p1.text.includes("Newer")) throw new Error("page 1 lacks the Showing line and an Older link");
      if (!p2.text.includes(`Showing 51–${total} of ${total}`) || !p2.text.includes("Newer")) throw new Error("page 2 lacks the Showing line and a Newer link");
      const rowsOn = (t: string) => t.split("<tr>").length - 2;
      if (rowsOn(p1.text) !== 50) throw new Error(`page 1 lists ${rowsOn(p1.text)} rows, expected 50`);
      if (p1.text.indexOf(`>${victim}</a>`) > p1.text.indexOf(`>page-0-${ts}@fixture.test</a>`)) throw new Error("users are not newest first");
      // The delete action's redirect banner, and a failed load is not an empty list.
      if (!(await html(b, "/admin?deleted=gone%40x.com", bossU.cookie)).text.includes("Deleted gone@x.com and their files.")) throw new Error("the deleted banner is missing");
      console.log("gate: admin Users page: search by email (any case) and by name, no-match copy, % is not a wildcard, 50 a page newest first with Showing and Newer/Older");

      // Ban: sessions gone, sign-in refused with the blocked copy, audit entry, reason shown to admins only; unban restores.
      const victimB = cookieOf(await signIn(b, victim)) || victimU.cookie;
      const ban = await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: victimU.id, banReason: "spam signup" });
      if (ban.status !== 200) throw new Error(`ban-user -> ${ban.status}`);
      if (await sessionUser(b, victimB)) throw new Error("a banned user's session survived");
      const refused = await signIn(b, victim);
      const refusedBody = (await refused.json()) as any;
      if (refused.ok || refusedBody?.code !== "BANNED_USER" || refusedBody?.message !== "This account has been blocked. Contact the site owner.") throw new Error(`a banned user's sign-in -> ${refused.status} ${JSON.stringify(refusedBody)}`);
      const detail = await html(b, `/admin/users/${victimU.id}`, bossU.cookie);
      if (!detail.text.includes("Banned") || !detail.text.includes("spam signup") || !detail.text.includes("Unban")) throw new Error("user detail does not show the ban, its reason and Unban");
      const live = await html(b, `/admin/users/${otherU.id}`, bossU.cookie);
      for (const t of ["Only admins see this.", "Active, last sign-in", `aria-label="Ban ${other}"`, "Danger zone", "Delete user permanently", `Type ${other} to confirm`, "Send reset link", 'tabindex="-1"']) if (!live.text.includes(t)) throw new Error(`user detail lacks ${t}`);
      if (JSON.stringify(refusedBody).includes("spam")) throw new Error("the ban reason reached the banned user");
      if (!auditRows().some((r) => r.verb === "ban" && r.target_email === victim && r.actor_email === boss && r.detail === "spam signup" && r.old_value === "active" && r.new_value === "banned")) throw new Error("no audit entry for the ban");
      // B2: a re-ban writes its own entry (banned -> banned, new reason); banExpiresIn is refused (D12) with no change and no entry.
      const banEntries = () => auditRows().filter((r) => r.verb === "ban").length;
      const banned0 = banEntries();
      if ((await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: victimU.id, banReason: "second reason" })).status !== 200 || banEntries() !== banned0 + 1 || !auditRows().some((r) => r.verb === "ban" && r.detail === "second reason" && r.old_value === "banned" && r.new_value === "banned")) throw new Error("a re-ban did not write one banned -> banned entry");
      if ((await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: victimU.id, banReason: "x", banExpiresIn: 60 })).status !== 400 || banEntries() !== banned0 + 1) throw new Error("ban with banExpiresIn was not refused 400 with no entry");
      console.log("gate: admin re-ban writes one banned -> banned entry; banExpiresIn is refused 400");
      if ((await call(b, "POST", "/api/auth/admin/unban-user", bossU.cookie, { userId: victimU.id })).status !== 200) throw new Error("unban-user failed");
      if (!(await signIn(b, victim)).ok) throw new Error("an unbanned user could not sign in");
      if (!auditRows().some((r) => r.verb === "unban" && r.target_email === victim)) throw new Error("no audit entry for the unban");
      console.log("gate: admin ban ends sessions, sign-in shows the blocked copy (no reason), reason on user detail and in the audit entry; unban restores sign-in");

      // Revoke one session, then the rest.
      await signIn(b, victim);
      await signIn(b, victim);
      const sessionsOf = () => rows("session", "SELECT id, token FROM session WHERE userId = ?", victimU.id) as { id: string; token: string }[];
      const before = sessionsOf();
      if (before.length < 2) throw new Error(`${before.length} sessions for the victim`);
      // CSO-1: no token reaches the admin's browser. The plugin's list endpoint is off the allowlist (404 even for an admin), and the User detail page ships ids only.
      if ((await call(b, "POST", "/api/auth/admin/list-user-sessions", bossU.cookie, { userId: victimU.id })).status !== 404) throw new Error("an admin's raw list-user-sessions was not 404");
      const victimPage = await html(b, `/admin/users/${victimU.id}`, bossU.cookie);
      if (before.some((s) => victimPage.text.includes(s.token))) throw new Error("the User detail page ships a raw session token");
      const revokeUrl = (id: string, sid: string) => `/api/admin/users/${id}/sessions/${sid}/revoke`;
      // A foreign or missing Origin is refused with no side effects; so is a session id that is not this user's.
      const post = (path: string, origin?: string) => h.request(path, { base: b, method: "POST", cookie: bossU.cookie, origin: origin ? { foreign: origin } : "none" });
      const audited = auditRows().length;
      const refusals = [await post(revokeUrl(victimU.id, before[0]!.id)), await post(revokeUrl(victimU.id, before[0]!.id), "https://evil.test"), await post(`/api/admin/users/${victimU.id}/send-link`), await post(`/api/admin/users/${victimU.id}/send-link`, "https://evil.test")];
      // No Origin: our 403. A foreign Origin: Void drops the session before our route runs (404, as the review saw); our 403 is the backstop. Either way nothing happens.
      const st = refusals.map((r) => r.status);
      if (st[0] !== 403 || st[2] !== 403 || ![403, 404].includes(st[1]!) || ![403, 404].includes(st[3]!)) throw new Error(`no-Origin and cross-origin revoke/send-link -> ${st}, expected 403 for no Origin and 403 or 404 for a foreign one`);
      if (sessionsOf().length !== before.length || auditRows().length !== audited) throw new Error("a refused revoke or send-link changed a session or wrote an audit entry");
      const foreignSid = (rows("session", "SELECT id FROM session WHERE userId = ?", bossU.id) as { id: string }[])[0]?.id;
      if (!foreignSid) throw new Error("the admin has no session row to use as another user's session id");
      const sessionsBefore = sessionsOf().length;
      const auditBefore = auditRows().length;
      if ((await call(b, "POST", revokeUrl(victimU.id, foreignSid), bossU.cookie)).status !== 404) throw new Error("revoke of another user's session id under the victim's URL was not 404");
      if (sessionsOf().length !== sessionsBefore) throw new Error("a refused revoke changed the session count");
      if (auditRows().length !== auditBefore) throw new Error("a refused revoke wrote an audit entry");
      if ((await call(b, "POST", revokeUrl(victimU.id, "no-such"), bossU.cookie)).status !== 404) throw new Error("revoke of an unknown session id was not 404");
      if ((await call(b, "POST", revokeUrl(victimU.id, before[0]!.id), plainU.cookie)).status !== 404) throw new Error("a non-admin's revoke was not 404");
      const revoke = await call(b, "POST", revokeUrl(victimU.id, before[0]!.id), bossU.cookie);
      if (revoke.status !== 200 || sessionsOf().length !== before.length - 1 || auditRows().filter((r) => r.verb === "revoke-session").length !== 1) throw new Error(`revoke by id -> ${revoke.status}, ${sessionsOf().length} of ${before.length} sessions left`);
      if ((await call(b, "POST", "/api/auth/admin/revoke-user-sessions", bossU.cookie, { userId: victimU.id })).status !== 200 || sessionsOf().length) throw new Error("revoke-user-sessions left a session");
      if (!auditRows().some((r) => r.verb === "revoke-session" && r.target_email === victim) || !auditRows().some((r) => r.verb === "revoke-sessions" && r.target_email === victim)) throw new Error("no audit entries for the revokes");
      console.log("gate: admin revoke one session then all; audit entries for both");

      // Send link: the server route calls requestPasswordReset (no Turnstile token needed), the mail lands in the dev inbox, the link sets a new password.
      const sent = await call(b, "POST", `/api/admin/users/${victimU.id}/send-link`, bossU.cookie);
      if (sent.status !== 200 || ((await sent.json()) as any).kind !== "reset") throw new Error(`send-link -> ${sent.status}`);
      const [resetLink] = await waitMails(b, "Reset your password", victim, 1);
      if (!resetLink) throw new Error("no reset mail in the dev inbox");
      const token = await h.resetToken(resetLink, "reset", b);
      const NEW_PW = "admin-sent-password-1";
      if (!(await authPost(b, "/api/auth/reset-password", { newPassword: NEW_PW, token })).ok || !(await signIn(b, victim, NEW_PW)).ok) throw new Error("the sent link did not set a new password");
      if (!auditRows().some((r) => r.verb === "send-link" && r.target_email === victim)) throw new Error("no audit entry for the link");
      if (config.inviteOnly) {
        // An unverified user in an invite-only app gets a set-password link with its own subject.
        const pend = addr("pending");
        await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: pend, password: "" });
        const pid = idOf(pend);
        const r = await call(b, "POST", `/api/admin/users/${pid}/send-link`, bossU.cookie);
        if (r.status !== 200 || ((await r.json()) as any).kind !== "set-password") throw new Error(`send-link for an unverified user -> ${r.status}`);
        if ((await waitMails(b, SET_PW, pend, 2)).length < 2) throw new Error("the admin's set-password link was not mailed");
      }
      if ((await call(b, "POST", `/api/admin/users/not-a-user/send-link`, bossU.cookie)).status !== 404) throw new Error("send-link for a missing user was not 404");
      console.log("gate: admin send-link lands in the dev inbox and sets a new password" + (config.turnstile ? " (no Turnstile token)" : "") + (config.inviteOnly ? "; a set-password link for an unverified user" : ""));

      // Self-protection: the plugin refuses a self-ban and self-delete (400); the guard refuses before anything is purged.
      let kept = "";
      if (config.storage) {
        if ((await upload(b, bossU.cookie, "mine.txt", "mine")) !== 201) throw new Error("the admin's own upload failed");
        kept = `users/${bossU.id}/mine.txt`;
      }
      for (const [p, want] of [["ban-user", 400], ["remove-user", 400]] as const) {
        const r = await call(b, "POST", `/api/auth/admin/${p}`, bossU.cookie, { userId: bossU.id });
        if (r.status !== want) throw new Error(`self ${p} -> ${r.status}, expected ${want}`);
      }
      if (!rows("user", "SELECT 1 FROM user WHERE id = ?", bossU.id).length || (kept && !r2Keys().includes(kept)) || !(await sessionUser(b, bossU.cookie))) throw new Error("a refused self-delete changed something");
      await signIn(b, boss); // a second session, so "Revoke all other sessions" is offered
      const own = await html(b, `/admin/users/${bossU.id}`, bossU.cookie);
      if (!own.text.includes("This is you. Use Account settings to delete your own account.") || own.text.includes("Delete user permanently")) throw new Error("own user detail offers Ban or Delete");
      if (!own.text.includes("This device") || !own.text.includes("Revoke all other sessions")) throw new Error("own user detail lacks This device or Revoke all other sessions");
      console.log("gate: admin self-ban and self-delete refused (400), own detail page says 'This is you.' and labels This device");

      // Before-hooks run ahead of the endpoint's own checks: a cross-origin delete with the admin's cookie must be refused before the guard purges anything.
      const keep = await mk(b, addr("keep"));
      if (config.storage && (await upload(b, keep.cookie, "keep.txt", "keep")) !== 201) throw new Error("the kept user's upload failed");
      const evil = await h.request("/api/auth/admin/remove-user", { base: b, method: "POST", body: { userId: keep.id }, origin: { foreign: "https://evil.test" }, cookie: bossU.cookie });
      if (evil.status !== 403) throw new Error(`a cross-origin remove-user -> ${evil.status}, expected 403`);
      if (!rows("user", "SELECT 1 FROM user WHERE id = ?", keep.id).length || (config.storage && !r2Keys().includes(`users/${keep.id}/keep.txt`))) throw new Error("a refused cross-origin remove-user purged files or deleted the user");
      if (auditRows().some((r) => r.verb === "delete-user")) throw new Error("a refused cross-origin remove-user was audited");
      // B1: the plugin coerces userId, so an array must be refused by the guard (400) before the purge or the delete runs.
      const arr = await call(b, "POST", "/api/auth/admin/remove-user", bossU.cookie, { userId: [keep.id] });
      if (arr.status !== 400) throw new Error(`remove-user with an array userId -> ${arr.status}, expected 400`);
      if (!rows("user", "SELECT 1 FROM user WHERE id = ?", keep.id).length || (config.storage && !r2Keys().includes(`users/${keep.id}/keep.txt`)) || auditRows().some((r) => r.verb === "delete-user")) throw new Error("an array-userId remove-user deleted, purged or was audited");

      // Delete: the user row, sessions and files go; no audit entry holds the deleted email once the request is done; the delete itself is recorded without a target.
      const del = await mk(b, addr("doomed"));
      const doomed = addr("doomed");
      if (config.storage) {
        if ((await upload(b, del.cookie, "theirs.txt", "bye")) !== 201) throw new Error("the doomed user's upload failed");
        if (!r2Keys().includes(`users/${del.id}/theirs.txt`)) throw new Error("the doomed user's file is not in R2");
      }
      onUser(doomed, "INSERT INTO onboarding_step (user_id, step, reached_at) VALUES (?, 'example-step', 1700000000000)");
      if (!rows("onboarding_step", "SELECT 1 FROM onboarding_step WHERE user_id = ?", del.id).length) throw new Error("no onboarding row to cascade");
      await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: del.id, banReason: `note about ${doomed}` });
      if ((await call(b, "POST", `/api/admin/users/${del.id}/features/example-feature`, bossU.cookie, { state: "on" })).status !== 200) throw new Error("setting the doomed user's override failed");
      const removed = await call(b, "POST", "/api/auth/admin/remove-user", bossU.cookie, { userId: del.id });
      if (removed.status !== 200) throw new Error(`remove-user -> ${removed.status}`);
      if (rows("user", "SELECT 1 FROM user WHERE id = ?", del.id).length || (await sessionUser(b, del.cookie))) throw new Error("the deleted user row or session is still there");
      if (config.storage && r2Keys().some((k) => k.startsWith(`users/${del.id}/`))) throw new Error("the deleted user's files are still in R2");
      await noMail(doomed);
      if (rows("onboarding_step", "SELECT 1 FROM onboarding_step WHERE user_id = ?", del.id).length) throw new Error("onboarding rows survived the user's deletion");
      console.log("gate: admin delete removes the user's onboarding rows");
      const entry = auditRows().find((r) => r.verb === "delete-user");
      if (!entry || entry.target_user_id !== null || entry.target_email !== null || entry.actor_email !== boss || !String(entry.detail).includes(del.id)) throw new Error(`the delete audit entry is wrong: ${JSON.stringify(entry)}`);
      if (!auditRows().some((r) => r.verb === "ban" && r.target_email === null && r.detail === null && r.target_user_id === null)) throw new Error("the deleted user's earlier audit rows were not redacted to a null email and detail");
      if (!auditRows().some((r) => r.verb === "set-override" && r.target_email === null && r.detail === "example-feature")) throw new Error("deleting a user erased the feature name from their override entry");
      console.log("gate: admin delete removes the user row, sessions" + (config.storage ? " and files" : "") + "; no audit entry holds the deleted email or free text; the delete entry has no target");

      // Audit page: newest first, filter by the affected user, "View audit log" on user detail.
      const audit = await html(b, "/admin/audit", bossU.cookie);
      for (const t of ["<caption>", 'scope="col"', "<time datetime=", `${boss} unbanned ${victim}`, `${boss} banned ${victim}: active → banned (spam signup)`, `${boss} deleted a user`]) if (!audit.text.includes(t)) throw new Error(`/admin/audit lacks ${t}`);
      if (audit.text.indexOf(`${boss} unbanned ${victim}`) > audit.text.indexOf(`${boss} banned ${victim}`)) throw new Error("the audit log is not newest first");
      const mine = await html(b, `/admin/audit?user=${encodeURIComponent(victim.toUpperCase())}`, bossU.cookie);
      if (!mine.text.includes(`${boss} banned ${victim}`) || mine.text.includes("deleted a user") || mine.text.includes("a deleted user")) throw new Error("?user= did not filter to the affected user");
      if (!(await html(b, `/admin/audit?user=nobody-here`, bossU.cookie)).text.includes("No changes for nobody-here.")) throw new Error("the empty filtered audit copy is missing");
      if (!(await html(b, `/admin/users/${victimU.id}`, bossU.cookie)).text.includes(`/admin/audit?user=${encodeURIComponent(victim)}`)) throw new Error("user detail lacks the View audit log link");
      console.log("gate: admin audit log newest first, ?user= filters to the affected user, user detail links to it");
      // Without --payments, nothing billing-related appears in the admin pages (#85).
      if (!config.payments) {
        const detail = (await html(b, `/admin/users/${victimU.id}`, bossU.cookie)).text, features = (await html(b, "/admin/features", bossU.cookie)).text;
        if (/billing|Stripe/i.test(detail) || features.includes("Also on for")) throw new Error("an app without --payments shows billing on the admin user or Features page");
        console.log("gate: admin without --payments: no billing section on user detail, no plan text on Features");
      }

      // The Account page: an Admin link for an admin and nothing about the list for anyone else, an unverified listed user included (#153).
      const acct = (cookie: string) => html(b, "/settings", cookie).then((r) => r.text);
      if (!(await acct(bossU.cookie)).includes('href="/admin"')) throw new Error("an admin's Account page lacks the Admin link");
      if ((await acct(plainU.cookie)).includes('href="/admin"') || (await acct(plainU.cookie)).includes("admin list")) throw new Error("a non-admin's Account page mentions admin");
      if (ownerU) {
        if ((await acct(ownerU.cookie)).includes("admin list")) throw new Error("a listed, unverified user's Account page mentions the admin list");
        // Takeover (#153): the squatter signed up as the owner's address (session, own password); the owner's click on the real verify mail must end that session and
        // password, mail a reset link, and leave only the owner able to sign in, as admin.
        const [verifyLink] = await waitMails(b, "Verify your email", owner2, 1);
        if (!verifyLink) throw new Error("no verify mail for a listed sign-up in the dev inbox");
        await h.follow(verifyLink, b);
        if (!isVerified(owner2)) throw new Error("the owner's verify link did not verify the address");
        if (await sessionUser(b, ownerU.cookie)) throw new Error("the squatter's session survived the owner's verification");
        if ((await signIn(b, owner2)).ok) throw new Error("the squatter's password still signs in after the owner's verification");
        const [ownerLink] = await waitMails(b, "Reset your password", owner2, 1);
        if (!ownerLink) throw new Error("no reset mail after a listed address was verified");
        const OWNER_PW = "owner-chose-this-1";
        if (!(await authPost(b, "/api/auth/reset-password", { newPassword: OWNER_PW, token: await h.resetToken(ownerLink, "owner reset", b) })).ok) throw new Error("the owner's reset link did not set a password");
        const own = await signIn(b, owner2, OWNER_PW);
        if (!own.ok || (await call(b, "GET", "/admin", cookieOf(own))).status !== 200) throw new Error("the owner cannot sign in and open /admin after setting a password");
        console.log("gate: admin takeover: verifying a listed address ends the squatter's session and password; only the owner's reset link gets in");
      }

      // Onboarding (E14): "signed up" and "email verified" come from the user row, declared steps from onboarding_step; the list shows "n of m" and user detail the steps.
      const steps = 3; // signed up, email verified, and the scaffold's one declared step
      const listed = await html(b, `/admin?q=${encodeURIComponent(other)}`, bossU.cookie);
      if (!listed.text.includes('<th scope="col" class="wide">Onboarding</th>') || !listed.text.includes(`>2 of ${steps}</td>`)) throw new Error("the Users list lacks the Onboarding column or a verified user's 2 of 3");
      onUser(other, "INSERT INTO onboarding_step (user_id, step, reached_at) VALUES (?, 'example-step', 1700000000000)");
      if (!(await html(b, `/admin?q=${encodeURIComponent(other)}`, bossU.cookie)).text.includes(`>${steps} of ${steps}</td>`)) throw new Error("a reached step did not show 3 of 3 in the list");
      const otherPage = (await html(b, `/admin/users/${otherU.id}`, bossU.cookie)).text;
      for (const t of [`Onboarding: ${steps} of ${steps}`, "Signed up: Done", "Email verified: Done", "example-step: Done"]) if (!otherPage.includes(t)) throw new Error(`user detail lacks ${t}`);
      if (!(await html(b, `/admin/users/${victimU.id}`, bossU.cookie)).text.includes("example-step: Not yet")) throw new Error("an unreached step did not say Not yet");
      console.log(`gate: admin onboarding: the Users list shows "n of m" (2 of ${steps}, then ${steps} of ${steps} after a step), user detail lists the steps with Done and Not yet`);

      // Feature switches (#54): precedence over HTTP. The scaffold declares "example-feature" and gates routes/api/example-feature.ts on it.
      {
        const F = "example-feature", feat = addr("feat"), featU = await mk(b, feat);
        const gated = (cookie = "") => call(b, "GET", "/api/example-feature", cookie);
        const setGlobal = (state: unknown) => call(b, "POST", `/api/admin/features/${F}`, bossU.cookie, { state });
        const setUser = (u: { id: string }, state: unknown) => call(b, "POST", `/api/admin/users/${u.id}/features/${F}`, bossU.cookie, { state });
        const expectGate = async (what: string, who: string, cookie: string, want: number) => {
          const got = (await gated(cookie)).status;
          if (got !== want) throw new Error(`features: ${what}: ${who} got ${got}, expected ${want}`);
        };
        const auditCount = () => auditRows().length;
        // Nothing set: off for everyone; signed out is 401, signed in is 403.
        await expectGate("nothing set", "signed out", "", 401);
        await expectGate("nothing set", "a user", featU.cookie, 403);
        // Global on and off.
        if ((await setGlobal("on")).status !== 200) throw new Error("features: setting the global state on failed");
        await expectGate("global on", "a user", featU.cookie, 200);
        await expectGate("global on", "signed out", "", 401);
        const onBody = (await (await gated(featU.cookie)).json()) as { features: string[] };
        if (!onBody.features.includes(F)) throw new Error("features(c) did not list a feature that is on");
        if ((await setGlobal("off")).status !== 200) throw new Error("features: setting the global state off failed");
        await expectGate("global off", "a user", featU.cookie, 403);
        // An override in both directions: on beats global off for that user only; off beats global on.
        if ((await setUser(featU, "on")).status !== 200) throw new Error("features: setting an override on failed");
        await expectGate("override on, global off", "the user", featU.cookie, 200);
        await expectGate("override on, global off", "another user", plainU.cookie, 403);
        await setGlobal("on");
        if ((await setUser(featU, "off")).status !== 200) throw new Error("features: setting an override off failed");
        await expectGate("override off, global on", "the user", featU.cookie, 403);
        await expectGate("override off, global on", "another user", plainU.cookie, 200);
        // The kill switch beats an override on, for everyone.
        await setUser(featU, "on");
        await expectGate("override on, global on", "the user", featU.cookie, 200);
        if ((await setGlobal("kill")).status !== 200) throw new Error("features: setting the kill switch failed");
        await expectGate("kill switch", "the user with an override on", featU.cookie, 403);
        await expectGate("kill switch", "another user", plainU.cookie, 403);
        // The pages show the result and the reason, computed by decide().
        const killed = (await html(b, `/admin/users/${featU.id}`, bossU.cookie)).text;
        for (const t of ["Feature overrides", "Use global", `id="override-${F}"`, "Effective: Off: kill switch applies to everyone", `aria-label="Save ${F} for ${feat}"`]) if (!killed.includes(t)) throw new Error(`user detail lacks ${t} under the kill switch`);
        await setGlobal("on");
        if (!(await html(b, `/admin/users/${featU.id}`, bossU.cookie)).text.includes("Effective: On: user override")) throw new Error("user detail does not say On: user override");
        await setUser(featU, "default");
        if (!(await html(b, `/admin/users/${featU.id}`, bossU.cookie)).text.includes("Effective: On: on for everyone")) throw new Error("user detail does not follow the global state once the override is reset");
        await expectGate("override reset, global on", "the user", featU.cookie, 200);
        const page = (await html(b, "/admin/features", bossU.cookie)).text;
        for (const t of ["<h1", F, "<fieldset>", "<legend", 'type="radio"', "Everyone, except users set to off", "No one, except users set to on", "No one. User settings are ignored.", `aria-label="Save ${F}"`, 'href="/admin/features"']) if (!page.includes(t)) throw new Error(`/admin/features lacks ${t}`);
        console.log("gate: features: nothing set is off (401 signed out, 403 signed in), global on and off, an override in both directions, the kill switch beats an override on, and the pages show the effective result and reason");
        // A row for a feature that is no longer declared is dropped: it neither reaches features(c) nor the pages, and nothing fails.
        onUser(feat, "INSERT INTO feature_switch (feature, state, updated_at) SELECT 'ghost', 'on', 1700000000000 WHERE ? IS NOT NULL");
        onUser(feat, "INSERT INTO feature_override (user_id, feature, state, updated_at) VALUES (?, 'ghost', 'on', 1700000000000)");
        const ghost = (await (await gated(featU.cookie)).json()) as { features: string[] };
        if (ghost.features.join() !== F) throw new Error(`features(c) with an undeclared row returned ${ghost.features.join()}`);
        const ghostPage = await html(b, "/admin/features", bossU.cookie), ghostUser = await html(b, `/admin/users/${featU.id}`, bossU.cookie);
        if (ghostPage.status !== 200 || ghostUser.status !== 200 || ghostPage.text.includes("ghost") || ghostUser.text.includes("ghost")) throw new Error("an undeclared feature row reached a page");
        if ((await setGlobal("on")).status !== 200) throw new Error("an undeclared row broke set()");
        console.log("gate: features: an undeclared feature row and override are dropped");
        // Refusals write nothing: a bad state, an undeclared feature, a missing user, a non-admin, no or a foreign Origin.
        const before = auditCount();
        const refused: [string, number][] = [
          [`bad state: ${(await setGlobal("sometimes")).status}`, 400],
          [`no state: ${(await setGlobal(undefined)).status}`, 400],
          [`kill as an override: ${(await setUser(featU, "kill")).status}`, 400],
          [`undeclared feature: ${(await call(b, "POST", "/api/admin/features/ghost", bossU.cookie, { state: "on" })).status}`, 400],
          [`missing user: ${(await call(b, "POST", `/api/admin/users/not-a-user/features/${F}`, bossU.cookie, { state: "on" })).status}`, 404],
          [`non-admin global: ${(await call(b, "POST", `/api/admin/features/${F}`, plainU.cookie, { state: "off" })).status}`, 404],
          [`non-admin override: ${(await call(b, "POST", `/api/admin/users/${featU.id}/features/${F}`, plainU.cookie, { state: "off" })).status}`, 404],
          [`signed out: ${(await call(b, "POST", `/api/admin/features/${F}`, "", { state: "off" })).status}`, 404],
          [`foreign Origin: ${(await h.request(`/api/admin/features/${F}`, { base: b, method: "POST", body: { state: "off" }, origin: { foreign: "https://evil.test" }, cookie: bossU.cookie })).status}`, 403],
          [`no Origin: ${(await h.request(`/api/admin/features/${F}`, { base: b, method: "POST", body: { state: "off" }, origin: "none", cookie: bossU.cookie })).status}`, 403],
        ];
        // A foreign Origin is 403 or 404 (Better Auth ignores the session cookie on it, so the admin looks signed out); either way nothing runs.
        for (const [what, want] of refused) if (Number(what.split(": ")[1]) !== want && !(what.startsWith("foreign Origin") && what.endsWith("404"))) throw new Error(`features: ${what}, expected ${want}`);
        await expectGate("after the refusals", "the user", featU.cookie, 200);
        if (auditCount() !== before) throw new Error("a refused feature change wrote an audit entry");
        if ((await html(b, "/admin/features", plainU.cookie)).status !== 404) throw new Error("a non-admin reached /admin/features");
        console.log("gate: features: a bad state, an undeclared feature, a missing user, a non-admin and a missing or foreign Origin are refused and write no audit entry");
        // Every change is audited, in the same batch as the change, with the old and new value.
        const audited = auditRows().filter((r) => r.verb === "set-feature" || r.verb === "set-override");
        const has = (verb: string, old: string, now: string) => audited.some((r) => r.verb === verb && r.detail === F && r.old_value === old && r.new_value === now);
        if (!has("set-feature", "off", "on") || !has("set-feature", "on", "kill") || !has("set-override", "default", "on") || !has("set-override", "on", "default") || !has("set-override", "on", "off")) throw new Error(`features: the audit log lacks an entry: ${JSON.stringify(audited.map((r) => [r.verb, r.old_value, r.new_value]))}`);
        if (!audited.some((r) => r.verb === "set-override" && r.target_email === feat)) throw new Error("an override entry does not name the user");
        const log = (await html(b, "/admin/audit", bossU.cookie)).text;
        for (const t of [`${boss} set feature ${F}: on → kill`, `${boss} set feature ${F} for ${feat}: default → on`]) if (!log.includes(t)) throw new Error(`/admin/audit lacks ${t}`);
        console.log("gate: features: every global change and override wrote an audit entry with its old and new value");
      }

      // Settings (#55): typed runtime settings. The scaffold declares four examples (text, number 1..100 default 10, on/off, a choice) and routes/api/example-settings.ts reads them.
      {
        const N = "example-number", set = (key: string, value: unknown, cookie = bossU.cookie) => call(b, "POST", `/api/admin/settings/${key}`, cookie, { value });
        const del = (key: string, cookie = bossU.cookie) => call(b, "DELETE", `/api/admin/settings/${key}`, cookie);
        const read = async () => (await (await call(b, "GET", "/api/example-settings", plainU.cookie)).json()) as { text: string; number: number; toggle: boolean; choice: string };
        const changes = () => auditRows().filter((r) => r.verb === "set-setting" || r.verb === "reset-setting");
        const need = (cond: boolean, what: string) => { if (!cond) throw new Error(`settings: ${what}`); };
        const SAVED_COPY = "Saved. Applies on the user's next page load.";
        // Nothing stored: every getter returns its declared default. Signed out is 401.
        need((await call(b, "GET", "/api/example-settings")).status === 401, "the example route answered a signed-out request");
        need(JSON.stringify(await read()) === JSON.stringify({ text: "Hello", number: 10, toggle: false, choice: "medium" }), "the getters did not return the declared defaults");
        let page = (await html(b, "/admin/settings", bossU.cookie)).text;
        for (const t of ["<h1", 'href="/admin/settings"', N, "A number between 1 and 100.", "Default: 10", "Default: Off", "Default: medium", "Default: Hello", 'type="number"', 'min="1"', 'max="100"', 'type="checkbox"', "<select", `aria-label="Save ${N}"`, "<form"]) need(page.includes(t), `/admin/settings lacks ${t}`);
        need(!page.includes("Reset to default") && !page.includes("Stored value is invalid"), "the page offered a reset with nothing stored");
        // Save: the value is read back, the page offers a reset, and the audit entry has the old and new value.
        const saved = await set(N, 25);
        need(saved.status === 200 && ((await saved.json()) as { message: string }).message === SAVED_COPY, "saving a number did not answer 200 with the success copy");
        need((await read()).number === 25, "the getter did not return the saved number");
        need((await set("example-text", "Hi there")).status === 200 && (await set("example-toggle", true)).status === 200 && (await set("example-choice", "large")).status === 200, "saving a text, an on/off and a choice setting failed");
        const now = await read();
        need(now.text === "Hi there" && now.toggle === true && now.choice === "large", `the getters returned ${JSON.stringify(now)} after saving every type`);
        page = (await html(b, "/admin/settings", bossU.cookie)).text;
        need(page.includes(`aria-label="Reset ${N} to default"`) && page.includes("Reset to default") && page.includes('value="25"'), "the page does not show the saved number and its Reset to default");
        const logged = (verb: string, key: string, old: string, now: string) => changes().some((r) => r.verb === verb && r.detail === key && r.old_value === old && r.new_value === now);
        need(logged("set-setting", N, "10", "25") && logged("set-setting", "example-toggle", "false", "true") && logged("set-setting", "example-choice", "medium", "large"), `the audit log lacks a save: ${JSON.stringify(changes().map((r) => [r.verb, r.detail, r.old_value, r.new_value]))}`);
        // Saving the value a setting already has answers 200 and writes no audit entry.
        {
          const n0 = auditRows().length;
          need((await set(N, 25)).status === 200 && (await set("example-toggle", true)).status === 200, "a save of the current value did not answer 200");
          need(auditRows().length === n0, `a save of the current value wrote ${auditRows().length - n0} audit entries`);
        }
        console.log("gate: settings: the getters return the declared defaults, a save of each type is read back, shown with its reset, and audited with the old and new value");
        // Refusals: out of range 400 (both ends), a wrong type, an undeclared key, a missing user's rights, no or a foreign Origin. Nothing is written and the value stands.
        const before = auditRows().length;
        const fetchOrigin = (method: string, key: string, origin?: string) => h.request(`/api/admin/settings/${key}`, { base: b, method, origin: origin ? { foreign: origin } : "none", cookie: bossU.cookie, body: method === "POST" ? { value: 30 } : undefined, headers: { "content-type": "application/json" } });
        const refused: [string, number, number | number[]][] = [
          ["number over the max", (await set(N, 101)).status, 400],
          ["number under the min", (await set(N, 0)).status, 400],
          ["number as text", (await set(N, "abc")).status, 400],
          ["number missing", (await call(b, "POST", `/api/admin/settings/${N}`, bossU.cookie, {})).status, 400],
          ["on/off as text", (await set("example-toggle", "maybe")).status, 400],
          ["choice outside the set", (await set("example-choice", "huge")).status, 400],
          ["text over 1000 characters", (await set("example-text", "x".repeat(1001))).status, 400],
          ["undeclared key", (await set("ghost", 1)).status, 400],
          ["undeclared key reset", (await del("ghost")).status, 400],
          ["non-admin save", (await set(N, 30, plainU.cookie)).status, 404],
          ["non-admin reset", (await del(N, plainU.cookie)).status, 404],
          ["signed-out save", (await set(N, 30, "")).status, 404],
          ["no Origin save", (await fetchOrigin("POST", N)).status, 403],
          ["no Origin reset", (await fetchOrigin("DELETE", N)).status, 403],
          ["foreign Origin save", (await fetchOrigin("POST", N, "https://evil.test")).status, [403, 404]],
          ["foreign Origin reset", (await fetchOrigin("DELETE", N, "https://evil.test")).status, [403, 404]],
        ];
        for (const [what, got, want] of refused) if (Array.isArray(want) ? !want.includes(got) : got !== want) throw new Error(`settings: ${what} answered ${got}, expected ${want}`);
        const refusal = (await set(N, 101).then((r) => r.json())) as { message: string };
        need(refusal.message === "Enter a number from 1 to 100.", `the out-of-range message was "${refusal.message}"`);
        need((await read()).number === 25 && auditRows().length === before, "a refused setting change wrote an audit entry or changed the value");
        need((await html(b, "/admin/settings", plainU.cookie)).status === 404, "a non-admin reached /admin/settings");
        console.log("gate: settings: an out-of-range number, a wrong type, a value outside the set, an undeclared key, a non-admin and a missing or foreign Origin are refused and write no audit entry");
        // Reset to the default: one entry, the getter returns the default again, the page stops offering the reset. A second reset has nothing to do and writes nothing.
        const n = changes().length;
        need((await del(N)).status === 200 && (await read()).number === 10, "reset did not restore the default");
        need(changes().length === n + 1 && logged("reset-setting", N, "25", "10"), "reset did not write exactly one audit entry");
        need(!(await html(b, "/admin/settings", bossU.cookie)).text.includes(`aria-label="Reset ${N} to default"`), "the page still offers a reset at the default");
        const again = await del(N);
        need(again.status === 404 && changes().length === n + 1, `a reset at the default answered ${again.status} or wrote an entry`);
        // Two resets of one setting at once: one wins and writes one entry, the other answers 404 and writes nothing.
        await set(N, 30);
        const m = changes().length;
        const race = (await Promise.all([del(N), del(N)])).map((r) => r.status).sort();
        need(race.join() === "200,404" && changes().length === m + 1 && (await read()).number === 10, `two concurrent resets answered ${race.join()} and left ${changes().length - m} entries`);
        console.log("gate: settings: reset restores the default with one audit entry, a reset at the default and the loser of two concurrent resets write nothing");
        // A stored value that no longer fits (here out of range, as after a declaration changed) reads as the default and says so; reset clears it. A row for an undeclared key is dropped.
        onUser(boss, "INSERT OR REPLACE INTO setting (key, value, updated_at) SELECT 'example-number', '999', 1700000000000 WHERE ? IS NOT NULL");
        onUser(boss, "INSERT OR REPLACE INTO setting (key, value, updated_at) SELECT 'ghost', 'x', 1700000000000 WHERE ? IS NOT NULL");
        need((await read()).number === 10, "an out-of-range stored value was returned instead of the default");
        const stale = (await html(b, "/admin/settings", bossU.cookie)).text;
        need(stale.includes("Stored value is invalid; using the default.") && stale.includes(`aria-label="Reset ${N} to default"`) && !stale.includes("ghost"), "the page did not flag the stored value as invalid, or showed an undeclared row");
        need((await del(N)).status === 200 && !(await html(b, "/admin/settings", bossU.cookie)).text.includes("Stored value is invalid"), "reset did not clear the invalid stored value");
        const log = (await html(b, "/admin/audit", bossU.cookie)).text;
        for (const t of [`${boss} set setting ${N}: 10 → 25`, `${boss} reset setting ${N}: 25 → 10`]) need(log.includes(t), `/admin/audit lacks ${t}`);
        console.log("gate: settings: an invalid stored value reads as the default and is flagged, an undeclared row is dropped, and the audit log reads \"set setting\" and \"reset setting\"");
      }

      if (config.inviteOnly) {
        // Invites in the database (U4, E10): no SIGNUP_ALLOWLIST at all, so the database is the only list and the app still fails closed.
        b = await withAdmins(boss, null);
        const invitedMail = addr("invited"), refusedMail = addr("neither"), domainMail = `dom-${ts}@corp.test`, revokedMail = addr("revoked"), pendMail = addr("pend"), ghostIn = addr("ghostin"), ghostOut = `ghost-${ts}@nowhere.test`;
        const api = (method: string, path: string, cookie = bossU.cookie, body?: object) => call(b, method, path, cookie, body);
        const addInvite = (kind: string, value: string) => api("POST", "/api/admin/invites", bossU.cookie, { kind, value });
        const inviteId = (entry: string) => String(rows("invite", "SELECT id FROM invite WHERE entry = ?", entry.toLowerCase())[0]?.id);
        const said = async (r: Response) => (await r.json()) as { message: string; notes?: string[] };
        if (!(await html(b, "/admin/invites", bossU.cookie)).text.includes("Invites you add here appear below.")) throw new Error("the empty Invites page lacks its empty state");
        await inviteRefused(b, refusedMail); // neither source: refused
        const add = await addInvite("email", invitedMail.toUpperCase());
        if (add.status !== 200 || (await said(add)).message !== `Invited ${invitedMail}.`) throw new Error(`add invite -> ${add.status}`);
        await signUpVerified(b, invitedMail); // admitted at once, no restart
        const domain = await addInvite("domain", "Corp.Test");
        if (domain.status !== 200 || (await said(domain)).message !== "Invited anyone at @corp.test.") throw new Error(`add domain invite -> ${domain.status}`);
        await signUpVerified(b, domainMail);
        for (const a of [`x-${ts}@sub.corp.test`, `x-${ts}@evilcorp.test`, `x-${ts}@corp.test.evil.test`]) await inviteRefused(b, a);
        // Validation, duplicates, and who may call it.
        if ((await addInvite("email", "not-an-email")).status !== 400 || (await addInvite("domain", "a@x.com")).status !== 400 || (await addInvite("email", invitedMail)).status !== 409) throw new Error("a bad or duplicate invite was not refused 400 / 409");
        for (const [who, cookie] of [["signed out", ""], ["non-admin", plainU.cookie]] as const)
          for (const [method, path] of [["GET", "/admin/invites"], ["POST", "/api/admin/invites"], ["POST", `/api/admin/invites/${inviteId(invitedMail)}/revoke`], ["POST", `/api/admin/invites/${inviteId(invitedMail)}/send`]] as const)
            if ((await api(method, path, cookie, method === "POST" ? { kind: "email", value: addr("x") } : undefined)).status !== 404) throw new Error(`${who}: ${method} ${path} was not 404`);
        const evilOrigin = await h.request("/api/admin/invites", { base: b, method: "POST", body: { kind: "email", value: addr("evil") }, origin: { foreign: "https://evil.test" }, cookie: bossU.cookie });
        // No Origin: our 403. A foreign Origin: Void drops the session before our route runs (404); our 403 is the backstop. Either way nothing is added.
        const noOrigin = await h.request("/api/admin/invites", { base: b, method: "POST", body: { kind: "email", value: addr("evil") }, origin: "none", cookie: bossU.cookie });
        if (noOrigin.status !== 403 || ![403, 404].includes(evilOrigin.status) || rows("invite", "SELECT 1 FROM invite WHERE entry LIKE 'evil-%'").length) throw new Error(`add invite with no Origin -> ${noOrigin.status}, a foreign one -> ${evilOrigin.status}`);
        console.log("gate: admin invites with no SIGNUP_ALLOWLIST: an exact and a domain invite admit at once without a restart, a lookalike and no source are refused, bad input 400, duplicate 409, non-admin 404, no or foreign Origin refused");

        // Revoke: refused again; the existing account is untouched; the notes.
        await addInvite("email", revokedMail);
        const revoked = await api("POST", `/api/admin/invites/${inviteId(revokedMail)}/revoke`);
        const revokedBody = await said(revoked);
        if (revoked.status !== 200 || revokedBody.message !== "Invite removed." || revokedBody.notes?.join("|") !== "Existing accounts are not affected. Ban the user to block them.") throw new Error(`revoke -> ${revoked.status} ${JSON.stringify(revokedBody)}`);
        await inviteRefused(b, revokedMail);
        if ((await api("POST", `/api/admin/invites/${inviteId(invitedMail)}/revoke`)).status !== 200 || !(await signIn(b, invitedMail)).ok) throw new Error("revoking an invite touched the existing account");
        if ((await api("POST", "/api/admin/invites/does-not-exist/revoke")).status !== 404) throw new Error("revoking a missing invite was not 404");
        console.log("gate: admin invite revoke: refused again, the existing account still signs in, the note says existing accounts are not affected");

        // The reset-password re-check reads the database: a pending user's set-password link stops working when their database invite is revoked.
        await addInvite("email", pendMail);
        await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: pendMail, password: "" });
        const [pendLink] = await waitMails(b, SET_PW, pendMail, 1);
        if (!pendLink) throw new Error("no set-password mail for a database-invited sign-up");
        await api("POST", `/api/admin/invites/${inviteId(pendMail)}/revoke`);
        const pendSet = await setPassword(b, pendLink, "pending-password-1");
        if (pendSet.ok || isVerified(pendMail)) throw new Error(`a revoked pending user's set-password link -> ${pendSet.status}, verified ${isVerified(pendMail)}`);
        console.log("gate: admin invite: the reset-password re-check reads the database (a revoked pending user's link is refused and does not verify)");

        // Send invite: mail for an exact email, nothing for a domain.
        const sendTo = addr("sendto");
        await addInvite("email", sendTo);
        const sentInvite = await api("POST", `/api/admin/invites/${inviteId(sendTo)}/send`);
        if (sentInvite.status !== 200 || (await said(sentInvite)).message !== `Invite email requested for ${sendTo}.`) throw new Error(`send invite -> ${sentInvite.status}`);
        const [inviteMail] = await waitMails(b, `Your invitation to ${new URL(b).host}`, sendTo, 1);
        if (!inviteMail || inviteMail.pathname !== "/sign-up") throw new Error(`the invite mail is missing or does not link to /sign-up: ${inviteMail}`);
        if ((await api("POST", `/api/admin/invites/${inviteId("@corp.test")}/send`)).status !== 400) throw new Error("send invite for a domain was not 400");
        console.log("gate: admin send-invite mails the sign-up link to an exact email and refuses a domain");
        // A resend inside a minute is refused (429) and neither mails nor records anything.
        const resend = await api("POST", `/api/admin/invites/${inviteId(sendTo)}/send`);
        if (resend.status !== 429 || (await said(resend)).message !== "An invite was just sent. Try again in a minute.") throw new Error(`a resend within a minute -> ${resend.status}`);
        if (auditRows().filter((r) => r.verb === "send-invite" && r.target_email === sendTo).length !== 1) throw new Error("a refused resend wrote an audit entry");
        console.log("gate: admin send-invite refuses a resend within a minute (429) and records nothing");
        // Four sends at once: the slot is claimed before mailing, so exactly one mails and records; the rest are 429.
        const burstTo = addr("burst");
        await addInvite("email", burstTo);
        const burst = await Promise.all(Array.from({ length: 4 }, () => api("POST", `/api/admin/invites/${inviteId(burstTo)}/send`).then((r) => r.status)));
        if (burst.filter((s) => s === 200).length !== 1 || burst.filter((s) => s === 429).length !== 3) throw new Error(`four concurrent sends -> ${burst}, expected one 200 and three 429`);
        if (auditRows().filter((r) => r.verb === "send-invite" && r.target_email === burstTo).length !== 1) throw new Error("four concurrent sends did not write exactly one send-invite entry");
        console.log("gate: admin send-invite: four sends at once mail and record once (the rest 429)");

        // Concurrent requests: four revokes of one invite write exactly one entry (the others are 404); four adds of one entry make one row and one entry (the others are 409, never 500).
        const raceMail = addr("race"), dupMail = addr("dup"), viaDomain = `via-${ts}@corp.test`;
        await addInvite("email", raceMail);
        const raceId = inviteId(raceMail);
        const revokes = await Promise.all([1, 2, 3, 4].map(() => api("POST", `/api/admin/invites/${raceId}/revoke`)));
        const adds = await Promise.all([1, 2, 3, 4].map(() => addInvite("email", dupMail)));
        const tally = (rs: Response[]) => rs.map((r) => r.status).sort().join();
        if (tally(revokes) !== "200,404,404,404") throw new Error(`four concurrent revokes -> ${tally(revokes)}`);
        if (tally(adds) !== "200,409,409,409") throw new Error(`four concurrent adds -> ${tally(adds)}`);
        const count = (verb: string, target: string) => auditRows().filter((r) => r.verb === verb && r.target_email === target).length;
        if (count("revoke-invite", raceMail) !== 1 || count("invite", dupMail) !== 1 || rows("invite", "SELECT 1 FROM invite WHERE entry = ?", dupMail).length !== 1) throw new Error("concurrent requests wrote more than one entry or row");
        console.log("gate: admin invites under concurrency: four revokes write one entry (the rest 404), four duplicate adds make one row and one entry (the rest 409)");

        // Revoking an exact email that a remaining domain invite still admits says so.
        await addInvite("email", viaDomain);
        const viaBody = await said(await api("POST", `/api/admin/invites/${inviteId(viaDomain)}/revoke`));
        if (viaBody.notes?.join("|") !== "Still invited through @corp.test.|Existing accounts are not affected. Ban the user to block them.") throw new Error(`revoke under a domain invite -> ${JSON.stringify(viaBody)}`);
        console.log("gate: admin invite revoke of an email covered by a domain invite says Still invited through @corp.test.");

        // Every change wrote its audit entry (same batch), and the audit page words them.
        for (const [verb, target] of [["invite", invitedMail], ["invite", "@corp.test"], ["revoke-invite", revokedMail], ["send-invite", sendTo]] as const)
          if (!auditRows().some((r) => r.verb === verb && r.target_email === target && r.actor_email === boss)) throw new Error(`no ${verb} audit entry for ${target}`);
        const invAudit = (await html(b, "/admin/audit", bossU.cookie)).text;
        for (const t of [`${boss} invited ${invitedMail}`, `${boss} removed the invite for ${revokedMail}`, `${boss} requested an invite email for ${sendTo}`]) if (!invAudit.includes(t)) throw new Error(`/admin/audit lacks ${t}`);
        console.log("gate: admin invite add, revoke and send each wrote an audit entry");

        // The page, and the Users search for an address with no account.
        const invPage = (await html(b, `/admin/invites?email=${encodeURIComponent(ghostOut)}`, bossU.cookie)).text;
        for (const t of ["Exact email", "Whole domain", "<caption>", 'scope="col"', `aria-label="Revoke ${sendTo}"`, `aria-label="Send invite email to ${sendTo}"`, "@corp.test", "From the SIGNUP_ALLOWLIST secret (edit the secret to change)", "The secret is empty.", `value="${ghostOut}"`]) if (!invPage.includes(t)) throw new Error(`/admin/invites lacks ${t}`);
        if (invPage.includes('aria-label="Send invite email to @corp.test"')) throw new Error("a domain row offers Send invite");
        if (!(await html(b, "/admin", bossU.cookie)).text.includes('href="/admin/invites"')) throw new Error("the admin nav lacks Invites");
        await addInvite("email", ghostIn);
        const notInvited = (await html(b, `/admin?q=${encodeURIComponent(ghostOut)}`, bossU.cookie)).text;
        for (const t of [`No account for ${ghostOut}.`, `${ghostOut} is not invited.`, `/admin/invites?email=${encodeURIComponent(ghostOut)}`, "Invite them"]) if (!notInvited.includes(t)) throw new Error(`the not-invited search lacks ${t}`);
        const invitedNoAccount = (await html(b, `/admin?q=${encodeURIComponent(ghostIn)}`, bossU.cookie)).text;
        if (!invitedNoAccount.includes(`No account for ${ghostIn}.`) || !invitedNoAccount.includes("Invited, but hasn't signed up yet.") || invitedNoAccount.includes("is not invited")) throw new Error("the invited-but-no-account search lacks its copy");
        console.log("gate: admin Invites page lists what was added (domain rows have no Send invite), a search with no account says not invited with an Invite them link, or invited but not signed up");

        // The secret still admits, is shown read-only, and revoking a covered entry says so.
        const secretMail = `secret-${ts}@partner.test`;
        b = await withAdmins(boss, secretMail.toUpperCase());
        await signUpVerified(b, secretMail);
        await signUpVerified(b, `dom2-${ts}@corp.test`); // the database invite still admits beside the secret
        await inviteRefused(b, `other-${ts}@partner.test`);
        if (!(await html(b, "/admin/invites", bossU.cookie)).text.includes(`<li>${secretMail}</li>`)) throw new Error("the secret's entry is not listed read-only");
        await addInvite("email", secretMail);
        const covered = await api("POST", `/api/admin/invites/${inviteId(secretMail)}/revoke`);
        const coveredBody = await said(covered);
        if (covered.status !== 200 || coveredBody.notes?.[0] !== "Still invited through SIGNUP_ALLOWLIST.") throw new Error(`revoking a secret-covered invite -> ${covered.status} ${JSON.stringify(coveredBody)}`);
        console.log("gate: admin invites with a SIGNUP_ALLOWLIST: a secret entry still admits beside the database, is listed read-only, and revoking a covered invite says Still invited through SIGNUP_ALLOWLIST.");
        b = await withAdmins(`${boss},${owner2}`);
      }

      // De-listed on a live session and an empty list. Restart on a list without boss (and with plain): boss's session is 404 on page and API at once; plain's live session now reaches list-users.
      b = await withAdmins(plain);
      await expectAll(b, "de-listed admin", bossU.cookie, victimU.id, () => 404);
      for (const [m, p] of adminPaths(victimU.id).slice(0, 5)) if ((await call(b, m, p, plainU.cookie, m === "POST" ? { userId: victimU.id } : undefined)).status !== (p === "/admin/users" ? 302 : 200)) throw new Error(`a newly listed user's live session: ${m} ${p} was refused`);
      b = await withAdmins("");
      const empty = await call(b, "GET", "/admin", plainU.cookie), root = await call(b, "GET", "/");
      if (empty.status !== 404 || root.status !== 200) throw new Error(`an empty ADMIN_EMAILS: /admin -> ${empty.status}, / -> ${root.status}`);
      if ((await call(b, "GET", "/api/auth/admin/list-users", plainU.cookie)).status !== 404) throw new Error("list-users answered with an empty ADMIN_EMAILS");
      console.log("gate: admin follows ADMIN_EMAILS live: a de-listed session is 404 on pages and API, a newly listed one is let in on its existing session, an empty list is 404 while GET / is 200");
    } finally {
      writeFileSync(envFile, original);
    }
  }
}
