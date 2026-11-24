# The app's lists live in `src/app/`; scaffold-owned modules keep their paths

The owner's proposal put all scaffold-owned code in one folder (`src/zero/`). We instead give the app one folder, `src/app/`: a data-only declaration file per list (features, settings, onboarding steps, plans) and the auth extension. The scaffold-owned modules stay where they are, import the lists and re-export them under the same names, so no import in pages, routes, tests or app code changes.

A single scaffold-owned folder was never possible: Void fixes where `auth.ts`, `pages/`, `routes/`, `middleware/` and `db/schema` live, so the notice in each file and the ownership rule have to carry the label either way. Moving the modules would rewrite about 40 import sites and make the one-time port of existing apps larger, for no change in behaviour. It stays reversible: a later move can leave one-line re-exports at the old paths.

One file per list, not one file for all: when a newer version adds a list, it arrives as a new file instead of a hunk next to lines the app already edited.
