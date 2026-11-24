# Charter

The owner's recorded voice for unattended planning (`/autopilot plan --auto` and `/autopilot run`). Vocabulary: `GLOSSARY.md`. How the scaffolder works: `SPEC.md`. Verified facts about Void and its libraries: `docs/facts.md`. Decisions already made: `docs/adr/`.

## Destination

`bunx github:orloworks/zero-stack <name>` gives the owner a svelte app on Cloudflare that can sign people up, charge them, write to them, be run from an admin area, be installed on a phone and be upgraded to a newer zero-stack in minutes. Every flag is proven end to end by the local gate, and the whole thing is proven once by a real app the owner builds and deploys with it.

## Features

- **Done (v0.5.0, 2026-11-24)**
  - Payments: subscriptions, cancel before delete, admin billing and plan-gated features (spec #81; #82, #84, #85).
  - `bun run doctor` (spec #94).
- **Must**
  - The dogfood app: one real app built with v0.5.0, `fable-prompt-engine` and `/autopilot run` in its own repo, deployed through the generated setup guide, with the Stripe sandbox checklist. It is the real deploy (#89, #86), and its measurements go in #98.
  - Every break the dogfood app finds, fixed (label `dogfood`; the first is #108).
  - The upgrade seam: app-owned and scaffold-owned files, a manifest, and `zero-stack upgrade` (spec #100; #101, #103, #102, #104, #105).
- **Should**
  - Email expansion (spec #109; #110–#118): a `--marketing` flag with list sign-up by double opt-in, unsubscribe, an admin Subscribers page, templates with preview and test-send, and campaigns; billing notices switched on in Stripe, none sent by the app.
  - Installable web app with push, `--pwa` (#90), starting with its pass/fail push test.
  - Mobile app with Capacitor, `--mobile` (#79), after #90.
- **Won't (until a real app asks)**
  - One-off purchases (#83), Stripe Connect (#68), referrals and affiliates (#17, #18, #19), API-only scaffold (#21), workspace scaffolding (#22).
  - Social or passwordless sign-in for accounts; importing subscribers from a file; an email rendering library; publishing the scaffold's machinery as a package.
  - New work for React, Vue or Solid: they stay frozen at v0.1.

## Users and jobs

- **The owner** scaffolds a new app, follows its setup guide, deploys it, and runs it from `/admin`. They upgrade an older app with `zero-stack upgrade` once it has a manifest, and with `docs/upgrading.md` for the one-time port before that. They write a campaign, test-send it to themselves, and trigger the real send.
- **A coding agent in a generated app** reads `AGENTS.md` and `docs/setup.md`, does every step marked for agents without ever seeing a secret value, runs `bun run doctor` to see what is left, and puts app changes in app-owned files.
- **An end user of a generated app** signs up, pays, manages billing, uses paid features, joins and leaves a mailing list, and can delete their account.
- **A subscriber with no account** joins a list from a form, confirms by email, and can leave with one click.

## Success measures

- `bun run ci` and the full `ci:full` matrix are green on every merge, with the cache off before a release.
- Every PR has a clean independent review; auth, payments, email and secrets changes also have a clean `/cso`.
- The dogfood app (#98) reaches a deployed app with sign-up working in under 4 hours and a first test payment in under 8, and zero-stack causes fewer of its extra review and fix rounds than the app's own design does.
- A paying test user in a Stripe sandbox can subscribe, change plan, cancel and delete their account, and the app's state matches Stripe's each time.
- An app made with one release upgrades to the next with no conflict in its declaration files or its auth extension, and `bun run verify` passes afterwards.
- No mail ever goes to an address that has not confirmed or that has unsubscribed, including part-way through a campaign; the gate proves it.

## Principles

Ranked; ties go to the more reversible option.

1. **Never lose money or data silently, and never mail someone who didn't ask.** Fail closed: a failed deletion beats a deleted user who keeps being billed; Stripe's live state beats an event's snapshot; an upgrade merges and never overwrites an edit; a send that might reach an unsubscribed address doesn't go; an outage is never recorded as "sent".
2. **Library first.** Build on Better Auth plugins, Void primitives and what Stripe already does, and check the paths where the library does nothing (it did not cancel on delete, sync plans, or order events).
3. **Least code.** The smallest change that fully works. No options, abstractions or flags nobody asked for.
4. **Proven by the gate.** A behaviour that the gate doesn't exercise over HTTP isn't done. A check that passes for the wrong reason is a bug (#108).
5. **Svelte first.**
6. **Agents never see secrets, never write to live Stripe, never send to real recipients, never open the owner's browser, and never run a check against the owner's real accounts when a fake will do.**

## Constraints

- Stack: bun, Void on Cloudflare (no wrangler files), Better Auth, D1, R2, Infisical for secrets. A new runtime dependency is a human-tier decision.
- No new paid services without the owner. Stripe sandbox only in tests and dev.
- Cloudflare's email service is transactional only: sign-up, reset, invite and list-confirmation mail may use it; marketing mail needs a provider the owner picks (#110).
- Marketing mail follows the legal minimums: provable opt-in consent, a postal address in every message, a working unsubscribe link and the one-click unsubscribe header.
- Local CI is the gate; GitHub CI is never dispatched by an agent. PRs open as drafts. One push per review round. While a run is active a guard blocks forced pushes, so a pushed branch merges main in and is never rebased.
- Installers edit by anchored replace and fail hard on a missing anchor. The CLI writes only inside the target directory.
- App lists live in app-owned declaration files under `src/app/`; scaffold-owned files keep their paths and say so in their first lines (ADR 0001, ADR 0002).
- The owner dogfoods in the dogfood app's own repo; no dogfood run is scheduled in this repo.

## Design direction

No `DESIGN.md`. Generated pages are plain, accessible HTML with the scaffold's existing styles: labelled inputs, visible focus, `role="alert"` for errors, no sideways scroll at 375 px. "Good" for a core flow means a first-time user finishes it without reading docs and every failure says what to do next. Emails are plain and readable without images, with a text alternative.

## Out of scope

Everything under Won't; hosted services run by zero-stack; in-app purchase; team and seat billing; usage-based billing; refunds or plan changes from the admin area (the Stripe dashboard does those); billing emails sent by the app (Stripe sends them); receiving inbound email; open and click tracking.

## Autonomy

- **agent:** naming, file layout, copy, test shape, a library already in the stack, gate and matrix changes that keep coverage, fixes for `dogfood` bugs that change no data model.
- **panel:** new seams, data model and migrations in generated apps, a core user flow, ticket slicing, what a flag includes, which files are app-owned.
- **human:** a new runtime dependency or paid vendor (the marketing mail provider is one); pricing; anything that reaches real customers, including the first real send of any campaign; merging any payments, auth-model, secrets or consent change (#104, #105, #112, #113, #117, #118); the real deploy and everything in the dogfood app's repo; app-store submissions; lifting a Won't.
- **escalate:** the arbiter is low-confidence and the decision is hard to reverse → human.
- **stop before build:** off for the seam and for `dogfood` bugs. On for the email expansion until the owner has answered its decision list on #92.

## Wayfinder notes

- Fog: whether Capacitor plugins and login cookies work on pages loaded from the deployed domain (#79's first ticket); whether web push can be sent from a Worker (#90's first ticket); whether a Svelte template renders to email HTML inside a Worker (#111); which provider sends the marketing mail (#110). The first two need a deployed app, so they wait on the dogfood app.
- Order: the seam chain first (#101 → #103 → #102 → #104 → #105), then the email chain behind it, because both edit the same files.
- Routes to avoid: a separate bundled mobile client (two UIs); Hotwire Native; Capacitor's `server.url` in release builds; queued or background cancel-on-delete; running one permutation where the full matrix is required; overwriting files on upgrade; a `src/zero/` folder move; counting a ticked box as consent without a confirmation mail; app-sent billing notices.

## Parent

https://github.com/orloworks/zero-stack/issues/92
