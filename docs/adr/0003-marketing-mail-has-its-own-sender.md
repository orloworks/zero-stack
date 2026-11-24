---
status: proposed
---

# Marketing mail has its own sender and never uses the transactional one

A generated app sends transactional mail through Void's `sendEmail`, which on the owner's Cloudflare account is Cloudflare's Email Service. That service allows transactional mail only ("Can I use Email Service for marketing emails? No."), and an account with a poor sending reputation can be paused, which would also stop password resets. So marketing mail goes through a second sender with its own provider, chosen by the owner. With no provider set up it refuses to send; it never falls back to the transactional sender. That second sender is the only place that adds the unsubscribe headers and the footer with the unsubscribe link and the postal address, so no email template can leave them out.

Billing notices are the opposite case: Stripe already sends them, so the app sends none.

## Considered options

- **Send marketing mail through `sendEmail` as well.** Rejected: against the service's terms, and it puts the app's sign-in mail at risk.
- **Use the provider's own broadcast product and only sync subscribers to it.** Less code, but the consent records, the unsubscribe state and the list would live in a second place the app cannot read before it sends. Left for the owner to confirm with the provider choice.
- **An email rendering library (`better-svelte-email`).** Rejected for now: six runtime dependencies and an open issue about deploying to Cloudflare. Templates use Svelte's own server render if a probe shows it works in a Worker, else plain functions.

## Consequences

Two mail providers to set up for an app that sends marketing mail, and a second secret. The provider is the owner's decision and is not made yet; this record becomes accepted when it is.
