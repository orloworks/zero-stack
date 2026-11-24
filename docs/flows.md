# Flows

User flows the product serves, with the features that hang on each step. Vocabulary: `GLOSSARY.md`. Updated in place by `flows`; one section per flow.

## Upgrade an app

The owner (or a coding agent in the app): when a newer zero-stack has a fix or a feature, they want their app to have it without redoing their own work · Starts: a newer zero-stack release · Ends: the app runs on the new scaffold-owned files, `bun run verify` passes, and the change is one commit the owner reviewed.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Run the upgrade in the app | `zero-stack upgrade`; the manifest | no manifest (an older app, or a react, vue or solid app): point to the one-time port and the manual method · uncommitted changes: refuse and say to commit first · scaffolding the new version fails: nothing in the app changed | 1 |
| Read what changed | the upgrade's summary: files replaced, added and removed; edited scaffold-owned files called out; app-owned files with upstream changes | nothing changed: say so and exit 0 | 1 |
| Resolve conflicts | three-way merge into the working tree, never committed | no conflicts: skip · a conflict: markers in the file, the file listed, non-zero exit · the owner wants out: `git checkout .` and `git clean -fd` restore everything | 2 |
| Migrate the database | a reminder to run `void db generate` and read the migration when the schema changed | schema unchanged: no reminder · running the migration is always the owner's call | 2 |
| Verify and commit | `bun run verify` | red: the summary says which upgraded files to look at first | 1 |

## Change an app without breaking upgrades

The owner (or a coding agent in the app): while building the app, they want to add features, settings, plans, onboarding steps, auth plugins and their own pages without making the next upgrade harder · Starts: any change to a generated app · Ends: the change lives in app-owned files only.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Declare a feature, setting, onboarding step or plan | declaration files | an invalid declaration: the app's tests and build say which one | 1 (one list), 3 (the rest) |
| Add an auth plugin or a trusted origin | the auth extension file | an unsupported key, or a plugin that would replace or switch off a scaffold protection: startup and build fail, naming the plugin and the reason | 4 |
| Restyle or rewrite a user-facing page | app-owned pages | upstream later changes the same lines: a conflict at the next upgrade | 2 |
| Need to change scaffold-owned behaviour | the "scaffold-owned" header; `AGENTS.md` rule | edited anyway: the next upgrade merges it and calls it out | 2 |

## Port an older app (once)

The owner: their app was made before the manifest existed and they want it on the upgrade path · Starts: an app made with zero-stack 0.4.x or earlier · Ends: the app has a manifest and `zero-stack upgrade` reports nothing to do.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Apply the template changes by hand | `docs/upgrading.md` (the manual diff method) | conflicts: resolved by hand, as today | 5 |
| Move the lists into the declaration files and auth edits into the extension file | `docs/upgrading.md` port section | | 5 |
| Adopt the manifest | copy the manifest from a fresh scaffold of the same version and flags | a leftover difference: `zero-stack upgrade` lists the file | 5 |

## Get billing notices

An end user who pays: when a payment succeeds, is about to renew, fails, or a card or trial is about to end, they want to hear about it in time to act · Starts: a Stripe billing event · Ends: the user got the notice from Stripe, once.

| Step | Features | Branches | Slice |
|---|---|---|---|
| The owner turns the notices on | the live-Stripe step of the setup guide: Stripe's own customer emails, the cancellation automation, the custom email domain | a toggle left off: no notice, and no command can detect it · sandbox: Stripe sends no customer emails | 1 |
| The user gets the notice and acts | Stripe's email and its hosted update-card page | the app sends no billing notice of its own, so there is never a duplicate | 1 |

## Join a list

A visitor or a user: when they want product news, they want to ask for it once and get nothing until they have said yes from their own inbox · Starts: a subscribe form, the sign-up checkbox or the Account page · Ends: confirmed consent for one list, with how, where and when on record.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Ask to join without an account | the public subscribe form with Turnstile | already subscribed, unsubscribed or unknown: the same "Check your inbox to confirm" · Turnstile fails: say so · asked again within minutes, or the hourly ceiling is hit: same answer, no second mail | 2 |
| Ask to join from another site | the form snippet for the owner's marketing site | an origin that is not on the app's list, or none: refused · the other site's hostname missing from the Turnstile widget: the token fails | 4 |
| Confirm from the inbox | the confirmation mail; the confirm page and its Confirm button | a mail scanner opens the link: nothing changes · the link is older than 7 days: ask again · never confirmed: no marketing mail, ever | 2 |
| Tick the box when signing up | the unticked checkbox on the sign-up page; the same confirmation mail | verifying the account or setting its password confirms nothing: only the Confirm press does · the sign-up is refused, or the address already has an account: nothing is recorded or mailed | 6 |
| Choose lists on the Account page | email preferences on the Account page | email not verified: "Verify your email to manage email preferences." · the address subscribed before the account existed: the same subscriber, shown as it stands | 6 |
| Be added by an admin | Add on the admin Subscribers page | the person still has to confirm from their inbox · no import | 3 |

## Leave a list

A subscriber: when they no longer want a list, they want out in one step, without signing in, and to stay out · Starts: any marketing mail, or the Account page · Ends: consent withdrawn; no later campaign reaches them.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Unsubscribe from the mail app's own button | the one-click unsubscribe headers and endpoint | no cookies and no sign-in: still works · repeated: same result | 2 |
| Unsubscribe from the link in the mail | the unsubscribe page: this list, or everything | a scanner opens the link: nothing changes · an unknown link: the same neutral page | 2 |
| Change their mind | "Subscribe again" on the same page, which mails a confirmation; the Account page | a forwarded copy of the mail: its holder can ask, only the inbox owner can confirm | 2 |
| Ask the owner by reply or by post | Unsubscribe on the admin Subscribers page, audited | | 3 |
| Delete their account | account deletion removes the subscriber and its consent first | removal fails: the account is not deleted and nothing else about it has changed | 2 |
| A campaign is being sent meanwhile | consent is read immediately before each message | the read fails: that message is not sent | 7 |

## Manage subscribers

An admin: when someone asks whether, when and how they subscribed, or the owner wants the list elsewhere, they want the answer in the admin area · Starts: the admin Subscribers page · Ends: the admin saw or changed one subscriber's consent, and the change is an audit entry.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Find a subscriber | search by email; filter by list and state | none yet: say how people join |3 |
| See how they consented | source, page, wording and times on the row | |3 |
| Add or unsubscribe one address | Add (confirmation mail) and Unsubscribe, both audited | |3 |
| Take the list out | CSV export of confirmed subscribers | |3 |

## Send a campaign

The owner, as an admin: when there is news, they want to send one good-looking mail to a list, see it first, and be sure nobody gets it twice or after unsubscribing · Starts: a campaign declared in the app · Ends: every confirmed subscriber of the list got it once, or the page says who did not and why.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Add an email template and declare the campaign (a coding agent) | app-owned email templates on the shipped layout; the campaigns declaration file | a template with a style block or class attributes: the app's tests fail | 5 |
| Preview it | the admin Campaigns page | | 5 |
| Send a test to myself | "Send a test to me" | no provider set up on a deployed app: "Marketing mail isn't set up yet." | 5 |
| Send | recipient count, typed campaign name, the cap | over the cap: refused · no provider: refused, never sent through the transactional sender | 7 |
| Watch it go and recover | batches driven by the open page; the send log | the provider refuses: the batch stops, "Provider refused: retry later" · tab closed: resume later · a failed or uncertain message: listed, retried only by the admin | 7 |

## Open questions

- Which provider sends marketing mail. Cloudflare's Email Service, which the app's transactional mail uses, does not allow it. Waits on the owner (spec "email expansion", decision list).
- Whether an email template can be a Svelte component rendered inside the Worker. A probe ticket answers it; plain functions returning HTML are the fallback.
- "Standard signup mechanisms" was read as ways to join a list. If the owner meant more ways to sign in to an account (social login, magic links), that is a separate plan.

Settled by the planning panel: every branch of the upgrade flows (spec #100) and the email flows above other than these three.
