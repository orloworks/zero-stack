import type { GenericEndpointContext } from "better-auth";

// Sign-up signs the person in before their inbox is proven, so someone who signs up as a listed (admin) address owns a session and a password for it.
// When the real owner then clicks the verify link, the account becomes verified, and with it admin, under the attacker's session. So the moment a listed address
// is verified by /verify-email: every session ends, the password is replaced by one nobody knows (first, then the sessions are swept twice), and the address is mailed a set-password (reset) link.
// Only the inbox owner can get in. Not used with --invite-only, which never lets an unproven address have a password.
// If the mail fails the verification stands and the user can use Forgot password; the failure is logged. If ending the sessions or replacing the password fails,
// the verification is taken back (the app must not be left with a verified attacker) and the request fails.
type User = { id: string; email: string; emailVerified: boolean };

export const revokeUnprovenSessions = (isAdmin: (user: User) => boolean) => async (user: User, ctx: GenericEndpointContext | null) => {
  if (ctx?.path !== "/verify-email" || !isAdmin(user)) return;
  const { internalAdapter, password, baseURL, options } = ctx.context;
  try {
    // Password first, so a sign-in that lands after it fails; then sweep twice, the second catching a sign-in that read the old password before it changed.
    await internalAdapter.updatePassword(user.id, await password.hash(crypto.randomUUID() + crypto.randomUUID()));
    await internalAdapter.deleteUserSessions(user.id);
    await internalAdapter.deleteUserSessions(user.id);
  } catch (e) {
    await internalAdapter.updateUser(user.id, { emailVerified: false });
    throw e;
  }
  const token = crypto.randomUUID().replaceAll("-", "");
  const identifier = `reset-password:${token}`;
  const expiresIn = options.emailAndPassword?.resetPasswordTokenExpiresIn ?? 3600;
  try {
    await internalAdapter.createVerificationValue({ value: user.id, identifier, expiresAt: new Date(Date.now() + expiresIn * 1000) });
    await options.emailAndPassword?.sendResetPassword?.({ user: user as never, url: `${baseURL}/reset-password/${token}?callbackURL=%2Freset-password`, token }, undefined);
  } catch (e) {
    // Hand-minted because Better Auth's requestPasswordReset needs the auth instance, which a database hook does not have; so an unsent token is deleted here.
    await internalAdapter.deleteVerificationByIdentifier(identifier).catch(() => {});
    console.error("could not mail the set-password link after verifying an admin address:", e instanceof Error ? e.message : "unknown error");
  }
};
