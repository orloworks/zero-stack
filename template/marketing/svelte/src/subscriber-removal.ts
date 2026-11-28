import { APIError } from "better-auth/api";
import { removeSubscriber, SUBSCRIBER_REMOVAL_FAILED } from "./consent";

// The one removal both account-deletion paths call (auth.ts: the self-delete hook and the admin guard's `removeSubscriber` option). It runs before the
// subscription cancel and the file purge, so a failed removal refuses the deletion with its own code and message, which the Account page and the admin user
// page show, and leaves the account, its billing and its files as they were.
// Only a verified account owns its address: sign-up does not wait for verification, so anyone can register someone else's address, and deleting that account
// must not wipe the real owner's subscription. An unverified account's deletion leaves the subscriber alone.
export const removeSubscriberOrRefuse = (user: { id: string; email: string; emailVerified?: boolean | null }): Promise<void> =>
  user.emailVerified !== true
    ? Promise.resolve()
    : removeSubscriber(user.email).catch((e) => {
        console.error(`subscriber removal failed for ${user.id}`, e);
        throw APIError.from("INTERNAL_SERVER_ERROR", SUBSCRIBER_REMOVAL_FAILED);
      });
