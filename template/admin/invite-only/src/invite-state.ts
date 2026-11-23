import { env } from "void/env";
import { inviteAllowed } from "./invites";

export type InviteState = "invited" | "not-invited" | null;

// For a search with no account (D7): is this address invited (the secret or a database invite)? Null for anything that is not an email address.
export async function inviteState(email: string): Promise<InviteState> {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  return (await inviteAllowed(email, env.SIGNUP_ALLOWLIST)) ? "invited" : "not-invited";
}
