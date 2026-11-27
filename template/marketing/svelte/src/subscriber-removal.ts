import { APIError } from "better-auth/api";
import { removeSubscriber, SUBSCRIBER_REMOVAL_FAILED } from "./consent";

// The one removal both account-deletion paths call (auth.ts: the self-delete hook and the admin guard's `removeSubscriber` option). It runs before the
// subscription cancel and the file purge, so a failed removal refuses the deletion with its own code and message, which the Account page and the admin user
// page show, and leaves the account, its billing and its files as they were.
export const removeSubscriberOrRefuse = (user: { id: string; email: string }): Promise<void> =>
  removeSubscriber(user.email).catch((e) => {
    console.error(`subscriber removal failed for ${user.id}`, e);
    throw APIError.from("INTERNAL_SERVER_ERROR", SUBSCRIBER_REMOVAL_FAILED);
  });
