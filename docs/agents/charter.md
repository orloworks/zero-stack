# Charter

The owner's recorded voice for unattended planning (`/autopilot plan --auto` and `/autopilot run`). Vocabulary: `GLOSSARY.md`. How the scaffolder works: `SPEC.md`. Verified facts about Void and its libraries: `docs/facts.md`.

## Destination

`bunx github:orloworks/zero-stack <name>` gives the owner a svelte app on Cloudflare that can sign people up, charge them, be run from an admin area and be installed on a phone, with every flag proven end to end by the local gate and by one real deploy.

## Features

- **Must**
  - Payments: subscriptions (#82), cancel before delete (#84), admin billing and plan-gated features (#85). Spec #81.
  - One real deploy through the generated setup guide, with the Stripe sandbox checklist (#89, #86).
  - A release once payments is merged.
- **Should**
  - Installable web app with push, `--pwa` (#90), starting with its pass/fail push test.
  - Mobile app with Capacitor, `--mobile` (#79), after #90.
  - `bun run doctor`: a generated app checks its own setup (secrets by name, migrations, bindings).
- **Won't (until a real app asks)**
  - One-off purchases (#83), Stripe Connect (#68), referrals and affiliates (#17, #18, #19), API-only scaffold (#21), workspace scaffolding (#22), a `zero-stack upgrade` command.
  - New work for React, Vue or Solid: they stay frozen at v0.1.

## Users and jobs

- **The owner** scaffolds a new app, follows its setup guide, deploys it, and runs it from `/admin`. They also upgrade an older app with `docs/upgrading.md`.
- **A coding agent in a generated app** reads `AGENTS.md` and `docs/setup.md` and does every step marked for agents without ever seeing a secret value.
- **An end user of a generated app** signs up, pays, manages billing, uses paid features, and can delete their account.

## Success measures

- `bun run ci` and the full `ci:full` matrix are green on every merge, with the cache off before a release.
- Every PR has a clean independent review; auth, payments, email and secrets changes also have a clean `/cso`.
- One scaffold has been deployed through its own setup guide, with every break filed as a bug.
- A paying test user in a Stripe sandbox can subscribe, change plan, cancel and delete their account, and the app's state matches Stripe's each time.

## Principles

Ranked; ties go to the more reversible option.

1. **Never lose money or data silently.** Fail closed: a failed deletion beats a deleted user who keeps being billed; Stripe's live state beats an event's snapshot.
2. **Library first.** Build on Better Auth plugins and Void primitives, and check the paths where the library does nothing (it did not cancel on delete, sync plans, or order events).
3. **Least code.** The smallest change that fully works. No options, abstractions or flags nobody asked for.
4. **Proven by the gate.** A behaviour that the gate doesn't exercise over HTTP isn't done.
5. **Svelte first.**
6. **Agents never see secrets, never write to live Stripe, never open the owner's browser.**

## Constraints

- Stack: bun, Void on Cloudflare (no wrangler files), Better Auth, D1, R2, Infisical for secrets. A new runtime dependency is a human-tier decision.
- No new paid services. Stripe sandbox only in tests and dev.
- Local CI is the gate; GitHub CI is never dispatched by an agent. PRs open as drafts. One push per review round.
- Installers edit by anchored replace and fail hard on a missing anchor. The CLI writes only inside the target directory.
- The owner dogfoods in their own app; no dogfood run is scheduled in this repo.

## Design direction

No `DESIGN.md`. Generated pages are plain, accessible HTML with the scaffold's existing styles: labelled inputs, visible focus, `role="alert"` for errors, no sideways scroll at 375 px. "Good" for a core flow means a first-time user finishes it without reading docs and every failure says what to do next.

## Out of scope

Everything under Won't; hosted services run by zero-stack; in-app purchase; team and seat billing; usage-based billing; refunds or plan changes from the admin area (the Stripe dashboard does those).

## Autonomy

- **agent:** naming, file layout, copy, test shape, a library already in the stack, gate and matrix changes that keep coverage.
- **panel:** new seams, data model and migrations in generated apps, a core user flow, ticket slicing, what a flag includes.
- **human:** a new runtime dependency or paid vendor; pricing; anything that reaches real customers; merging any payments, auth-model or secrets change; the real deploy (#89); app-store submissions; lifting a Won't.
- **escalate:** the arbiter is low-confidence and the decision is hard to reverse → human.
- **stop before build:** off. Specs may be built as soon as they are planned; merges still follow the human tier above, so payments PRs stack and wait for one yes.

## Wayfinder notes

- Fog: whether Capacitor plugins and login cookies work on pages loaded from the deployed domain (#79's first ticket); whether web push can be sent from a Worker (#90's first ticket). Both need a deployed app, so they wait on #89.
- Routes to avoid: a separate bundled mobile client (two UIs); Hotwire Native; Capacitor's `server.url` in release builds; queued or background cancel-on-delete; running one permutation where the full matrix is required.

## Parent

https://github.com/orloworks/zero-stack/issues/92
