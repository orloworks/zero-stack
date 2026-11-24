import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./flags";

// Who can do a step: an agent from a CLI/API, an agent driving the user's signed-in browser, or only the human.
export type Who = "agent" | "agent-browser" | "human";

// One setup step. `action` is markdown (commands in backticks); `verify` is a plain shell command whose exit code proves the step is done
// (the wizard runs it to skip a done step). `covers` lists the env names the step puts in production. Human steps drive the wizard:
// `capture` reads that secret name (hidden) and stores it, else `exec` is run.
export type Step = {
  id: string;
  on: (c: Config) => boolean;
  title: string;
  why: string;
  who: Who;
  action: string | ((c: Config) => string);
  verify: string;
  covers?: string[];
  click?: string[];
  exec?: string;
  capture?: string;
  // Cannot be proven by a command: the wizard never skips it and does not check it afterwards (the human confirms).
};

const WHO: Record<Who, string> = { agent: "Agent", "agent-browser": "Agent with browser", human: "Human only" };
const SECRET_LIST = "void secret list | grep -q";
const EMAIL_STATUS = "void email status --platform cloudflare";

// Dependency order: sign-ins, values a deploy needs, the deploy, then what it provisions. Every step is checked against the pinned Void's docs (last: 1.11.0)
// (reference/cli/{auth,secrets,email,deploy}.md, guide/{env-vars,auth,email/domains}.md) or `--help` of cf and infisical.
export const STEPS: Step[] = [
  {
    id: "cloudflare-login", on: () => true, title: "Sign in to Cloudflare", who: "human",
    why: "Void deploys to your own Cloudflare account. Sign-in opens a browser and needs an interactive terminal.",
    action: "`void cloudflare login`", exec: "void cloudflare login", verify: "void cloudflare status",
  },
  {
    id: "cloudflare-connect", on: () => true, title: "Connect the app to Cloudflare", who: "agent",
    why: "A new app has `.void/project.json` set to `platform: none`, and every `void secret` command refuses until a platform is saved. `void connect` saves it and pins the account. Not yet confirmed on a real account: that `void secret put` then works before the first deploy, on a Worker that does not exist yet. If it fails, the wizard reports the value as still to do instead of aborting; tell the owner.",
    action: "`void connect --platform cloudflare`", verify: "grep -q cloudflare .void/project.json",
  },
  {
    id: "infisical-login", on: (c) => !!c.secrets, title: "Sign in to Infisical", who: "human",
    why: "The `infisical` CLI needs a session before the folder can be linked or production values stored.",
    action: "`infisical login`", exec: "infisical login", verify: "infisical user get token >/dev/null 2>&1",
  },
  {
    id: "infisical-link", on: (c) => !!c.secrets, title: "Link this folder to an Infisical project", who: "agent",
    why: "`secrets:pull`, `secrets:push` and the production route read the link file.",
    action: "Run the `secret-sync` skill, or `infisical init --project-id <id>`", verify: "test -f .infisical.yaml -o -f .infisical.json",
  },
  {
    id: "cf-login", on: (c) => !!c.turnstile || !!c.storage, title: "Sign in to the cf CLI", who: "human",
    why: "The `cf` CLI has its own sign-in, separate from `void cloudflare login`. The Turnstile widget and the bucket check use it.",
    action: "`cf auth login`", exec: "cf auth login", verify: "cf auth whoami | grep -Eq '\"authenticated\": *true'",
  },
  {
    id: "email-from", on: (c) => !!c.email, title: "Set the sending address", who: "agent",
    why: "`email.from` ships as `noreply@example.com`, which Void cannot send from. It must be an address on a zone in your Cloudflare account (a subdomain such as `mail.acme.com` keeps existing mail working).",
    action: "Set `email.from` in `void.config.ts` to an address on your mail domain", verify: "test -f void.config.ts && ! grep -q noreply@example.com void.config.ts",
  },
  {
    id: "turnstile-widget", on: (c) => !!c.turnstile, title: "Create the Turnstile widget and store its secret", who: "agent",
    why: "Needs `jq` and the `cf` sign-in. Local dev uses Cloudflare's always-pass test keys, and `auth.ts` refuses to start with the test secret off localhost. The widget JSON stays in a shell variable (never a file), the secret goes straight into `void secret put`, and only the public site key is printed; it goes in the build shell of the deploy. If the put fails, do not create another widget: the site key is printed, so run `cf turnstile widgets rotate-secret <site key>` and put the new secret.",
    action: (c) => {
      const sec = "printf '%s' \"$out\" | jq -rj '(.result // .).secret'";
      const key = "printf '%s' \"$out\" | jq -r '(.result // .).sitekey'";
      const inf = c.secrets ? ` { printf 'TURNSTILE_SECRET_KEY='; ${sec}; printf '\\n'; } | infisical secrets set --file /dev/stdin --env=prod --silent; infisical secrets set "VITE_TURNSTILE_SITE_KEY=$(${key})" --env=prod --silent;` : "";
      return `\`out=$(cf turnstile widgets create --body '{"name":"<app-name>","domains":["<app-host>"],"mode":"managed"}') && { ${sec} | void secret put TURNSTILE_SECRET_KEY || echo "put failed: rotate the secret, do not create another widget" >&2;${inf} ${key}; }\`${c.secrets ? " With Infisical, the secret and the site key also go in Infisical `prod` (done above), so the production route's `infisical run` exposes `VITE_TURNSTILE_SITE_KEY` to the build." : ""}`;
    },
    verify: `${SECRET_LIST} TURNSTILE_SECRET_KEY`, covers: ["TURNSTILE_SECRET_KEY", "VITE_TURNSTILE_SITE_KEY"],
  },
  {
    id: "signup-allowlist", on: (c) => !!c.inviteOnly, title: "Set the sign-up allowlist", who: "human",
    why: "Only these emails can create an account. With `--admin` it is optional (invites also live in the database); without it, an unset value fails every request.",
    action: "`void secret put SIGNUP_ALLOWLIST` (masked prompt), or run the wizard", capture: "SIGNUP_ALLOWLIST",
    click: ["Exact emails (a@x.com) and whole domains (@x.com), separated by commas.", "No quotes, $, # or backslashes."],
    verify: `${SECRET_LIST} SIGNUP_ALLOWLIST`, covers: ["SIGNUP_ALLOWLIST"],
  },
  {
    id: "admin-emails", on: (c) => !!c.admin, title: "Set the admin emails", who: "human",
    why: "An admin is a signed-in user with a verified email on this list. Unset means no admins and `/admin` answers 404. The local `.env` value is the placeholder `@example.com`.",
    action: "`void secret put ADMIN_EMAILS` (masked prompt), or run the wizard", capture: "ADMIN_EMAILS",
    click: ["Your own email, or several separated by commas.", "No quotes, $, # or backslashes."],
    verify: `${SECRET_LIST} ADMIN_EMAILS`, covers: ["ADMIN_EMAILS"],
  },
  {
    id: "stripe-sandbox", on: (c) => !!c.payments, title: "Try billing in the Stripe sandbox", who: "agent",
    why: "Local billing runs against your Stripe sandbox only; agents never write to live Stripe. `.env` ships placeholder keys, so the Billing page says \"Stripe isn't set up yet.\" until real sandbox keys are there. Put the repo's sandbox key (from the repo's Stripe CLI profile, never printed) in `.env` as `STRIPE_SECRET_KEY`, write the secret from `stripe listen --print-secret` into `.env` as `STRIPE_WEBHOOK_SECRET` without printing it, then forward events with `stripe listen --forward-to localhost:5173/api/auth/stripe/webhook` while `vp dev` runs. `STRIPE_API_URL` is for tests against a fake Stripe only and is never set in production. A restricted key (`rk_test_`) needs read access to subscriptions, customers and prices, and write access to Checkout sessions and Customer portal sessions (plus write on customers, which the first checkout creates, and on prices and products for `stripe:seed`).",
    action: "`bun run stripe:seed` (creates the plans in `src/plans.ts` by lookup key, skips existing ones, refuses live keys)", verify: "grep -Eq '^STRIPE_SECRET_KEY=[sr]k_test_' .env && ! grep -q '^STRIPE_SECRET_KEY=sk_test_placeholder' .env && grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' .env && ! grep -q '^STRIPE_WEBHOOK_SECRET=whsec_placeholder' .env",
    covers: ["STRIPE_API_URL"],
  },
  {
    id: "stripe-live-key", on: (c) => !!c.payments, title: "Set up live Stripe and store the secret key", who: "human",
    why: "Live mode charges real cards, so only you touch it. The deploy fails until the key is stored.",
    action: "In the Stripe dashboard (live mode), then `void secret put STRIPE_SECRET_KEY` (masked prompt), or run the wizard", capture: "STRIPE_SECRET_KEY",
    click: [
      "Create each plan in src/plans.ts as a product with a recurring price whose lookup key matches the file.",
      "Billing, Revenue recovery: when all retries fail, cancel the subscription (so a failed payment always ends).",
      "Set up the Customer portal, and Stripe Tax and branding if you use them.",
      "Developers, API keys: copy the secret key (sk_live_...) or a restricted key.",
    ],
    verify: `${SECRET_LIST} STRIPE_SECRET_KEY`, covers: ["STRIPE_SECRET_KEY"],
  },
  {
    id: "stripe-webhook", on: (c) => !!c.payments, title: "Create the live webhook endpoint and store its secret", who: "human",
    why: "The webhook is the only way subscription changes reach the app. Create the endpoint first, then store its signing secret.",
    action: "In the Stripe dashboard (live mode), then `void secret put STRIPE_WEBHOOK_SECRET` (masked prompt), or run the wizard", capture: "STRIPE_WEBHOOK_SECRET",
    click: [
      "Developers, Webhooks, Add endpoint: https://<app-host>/api/auth/stripe/webhook",
      "Events: checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted.",
      "Copy the signing secret (whsec_...).",
    ],
    verify: `${SECRET_LIST} STRIPE_WEBHOOK_SECRET`, covers: ["STRIPE_WEBHOOK_SECRET"],
  },
  {
    id: "deploy", on: () => true, title: "Deploy", who: "agent",
    why: "Builds, provisions the database and any other resource the code uses, applies migrations and publishes. It fails until every required server key exists remotely, and never uploads `.env`. Run it in a terminal you watch: the first deploy can ask you to pick an account or accept a setup prompt.",
    action: (c) => `\`${c.turnstile ? "VITE_TURNSTILE_SITE_KEY=<site key> " : ""}void deploy --platform cloudflare\`${c.secrets ? "; with Infisical, the production route in the Secrets section (it ends in `infisical run --env=prod -- void deploy`)" : ""}`,
    verify: "curl -fsS -o /dev/null https://<app-host>/",
  },
  {
    id: "auth-secret", on: (c) => !!c.auth, title: "Check the Better Auth secret", who: "agent",
    why: "Void creates `BETTER_AUTH_SECRET` on deploy if it is missing and reuses it later, so there is nothing to enter. `BETTER_AUTH_URL` is a local `.env` value only: Void sets the auth base URL and trusted origin from the request origin, so nothing sets or needs it in production.",
    action: "Nothing to run; confirm after the deploy", verify: `${SECRET_LIST} BETTER_AUTH_SECRET`, covers: ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"],
  },
  {
    id: "storage-bucket", on: (c) => !!c.storage, title: "Confirm the R2 bucket", who: "agent",
    why: "Void sees `void/storage` in the code and provisions the bucket on deploy; there is no separate step.",
    action: "Nothing to run; confirm after the deploy", verify: "cf r2 buckets list --name-contains <app-name> | grep -q storage",
  },
  {
    id: "email-setup", on: (c) => !!c.email, title: "Turn on Email Sending", who: "agent",
    why: "Sends from your domain. Mail to any recipient needs the Workers Paid plan; if you don't have it, `void email setup` says so. After upgrading to Workers Paid, run `void email setup --platform cloudflare` again. The guide never opens the plans page for you.",
    action: "`void email setup --platform cloudflare`", verify: `${EMAIL_STATUS} >/dev/null 2>&1`,
  },
  {
    id: "email-dns", on: (c) => !!c.email, title: "Check mail DNS is verified", who: "agent-browser",
    why: "Void sets up routing and sending records when the zone is on Cloudflare. A dashboard checklist can still list a step, and records at an outside registrar are yours to add.",
    action: "In the signed-in browser, open Email, then Settings, then Subdomains, and confirm every item is verified", verify: EMAIL_STATUS,
  },
];

export const stepsFor = (c: Config): Step[] => STEPS.filter((s) => s.on(c));
const hasHuman = (c: Config) => stepsFor(c).some((s) => s.who === "human");
const cell = (s: string) => s.replace(/\|/g, "\\|");
const act = (s: Step, c: Config) => (typeof s.action === "function" ? s.action(c) : s.action);
const code = (s: string) => "`" + s + "`";
const ver = (s: Step) => code(s.verify);

// The `## Setup` section of AGENTS.md: a compact table, in order.
export function composeSetupSection(c: Config): string {
  const rows = stepsFor(c).map((s, i) => `| ${i + 1} | ${cell(s.title)} | ${WHO[s.who]} | ${cell(act(s, c))} | ${cell(ver(s))} |`);
  return `\n\n## Setup

From scaffold to production, in order. Why each step is needed: \`docs/setup.md\`. Run \`bun run doctor\` to see what is left; it prints names and PASS/FAIL only, and you may run it.${hasHuman(c) ? " Human-only steps go through \`scripts/setup-wizard.sh\` (the human runs it with \`!\`); it is re-runnable and skips what is done. Do step 2 (connect) before it: its secret stages need a saved platform. Never ask for, read or print a secret value." : ""}

| # | Step | Who | Action | Verify (exit 0 when done) |
| - | ---- | --- | ------ | ------------------------- |
${rows.join("\n")}\n`;
}

// docs/setup.md: the full guide for humans.
export function composeSetupDoc(c: Config): string {
  const body = stepsFor(c).map((s, i) => {
    const lines = [`## ${i + 1}. ${s.title}`, "", `Who: ${WHO[s.who]}`, "", s.why, "", `Do: ${act(s, c)}`];
    if (s.click?.length) lines.push("", ...s.click.map((l) => `- ${l}`));
    lines.push("", `Verify (exit 0 when done): ${ver(s)}`);
    return lines.join("\n");
  });
  return `# Setup

Run \`bun run doctor\` to see what is left (set \`APP_HOST\` to your deployed host for the Deploy row).

Every step from scaffold to production for the flags this app was made with, in order. "Agent" steps have a CLI or API an agent can run. "Agent with browser" steps are dashboard-only; an agent can drive your signed-in browser while you watch. "Human only" steps need you${hasHuman(c) ? `: run \`bash scripts/setup-wizard.sh\`, which prints each link, says what to click, and stores values straight into ${c.secrets ? "Infisical and Void" : "Void"} without printing them` : ""}.

${body.join("\n\n")}
`;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Both scripts run from any directory in the app; void is a devDependency, not on PATH outside package scripts.
const ROOT = `cd "$(dirname "$0")/.."
PATH="$PWD/node_modules/.bin:$PATH"
`;

// The wizard library: the \`wizard\` skill's helper names, trimmed to what these steps need (no .env or GitHub writes).
const LIB = `set -euo pipefail
${ROOT}
TOTAL=__TOTAL__
N=0
TODO=()
say()  { printf '  %s\\n' "$1"; }
warn() { printf '  ! %s\\n' "$1"; }
# The wizard never opens a browser itself.
# todo TITLE VERIFY: announce the stage; false when VERIFY already passes, so a re-run skips done steps.
todo() {
  N=$((N + 1))
  printf '\\n> Stage %s/%s: %s\\n' "$N" "$TOTAL" "$1"
  if bash -c "$2" >/dev/null 2>&1; then say "already done, skipping"; return 1; fi
}
# check VERIFY TITLE: after the human acts, confirm it, or remember what is left.
check() {
  if bash -c "$1" >/dev/null 2>&1; then say "done"; else warn "not detected yet"; TODO+=("$2"); fi
}
# put_secret NAME: read a value without echoing it, then store it. Only the entry count is printed. A failure is reported, not fatal;
# the stage's check lists the step as still to do.
put_secret() {
  local v
  read -rs -p "  Value for $1 (hidden): " v || true
  printf '\\n'
  if [[ -z "$v" || "$v" == *[\\'\\"\\\\$#]* ]]; then warn "empty, or has a quote, backslash, \\$ or #: skipped"; return; fi
__INFISICAL__  printf '%s' "$v" | void secret put "$1" >/dev/null 2>&1 || { warn "void secret put $1 failed (is the app connected? see the Cloudflare connect step)"; return; }
  say "stored $1 (\${#v} characters)"
}
`;

const INFISICAL = `  if [[ -f .infisical.yaml || -f .infisical.json ]]; then
    printf '%s=%s\\n' "$1" "$v" | infisical secrets set --file /dev/stdin --env=prod --silent >/dev/null || { warn "Infisical refused it"; return; }
  fi
`;

// scripts/setup-wizard.sh: one stage per human step, null when the app has none. Never prints what the human types.
export function composeWizard(c: Config): string | null {
  const human = stepsFor(c).filter((s) => s.who === "human");
  if (!human.length) return null;
  const stages = human.map((s) => {
    const t = sq(s.title);
    const verify = sq(s.verify);
    const body = [`say ${sq(s.why)}`, ...(s.click ?? []).map((l) => `say ${sq(l)}`)];
    if (s.capture) body.push(`put_secret ${s.capture}`);
    else body.push(`${s.exec} || warn "exited non-zero"`);
    return `  if todo ${t} ${verify}; then\n${body.map((l) => `    ${l}`).join("\n")}\n    check ${verify} ${t}\n  fi`;
  });
  return `#!/usr/bin/env bash
# Human-only setup steps (generated; the list is docs/setup.md). Re-run any time: a done step is skipped. Never prints what you type.
${LIB.replace("__TOTAL__", String(human.length)).replace("__INFISICAL__", c.secrets ? INFISICAL : "")}
run_wizard() {
${stages.join("\n")}
  if (( \${#TODO[@]} )); then printf '\\nStill to do:\\n'; printf '  - %s\\n' "\${TODO[@]}"; exit 1; fi
  printf '\\nAll human-only steps are done.\\n'
}

run_wizard "$@"; exit
`;
}

// A guide verify's placeholders become environment variables in the doctor; a row that needs APP_HOST is not run without it.
const PLACEHOLDER = { "<app-host>": "$APP_HOST", "<app-name>": "$APP_NAME" } as const;
const doctorCmd = (s: Step) => {
  const cmd = Object.entries(PLACEHOLDER).reduce((v, [k, e]) => v.replaceAll(k, e), s.verify);
  const left = cmd.match(/<[A-Za-z][^<>]*>/);
  if (left) throw new Error(`doctor: step ${s.id} verify still holds ${left[0]}`);
  return cmd;
};

// scripts/doctor.sh: the local Void checks, then every applicable step's verify, then the remote env names. Prints PASS, FAIL (one fix line) or
// NOT CHECKED per row, never a command's output. After a failed sign-in step every later row is NOT CHECKED (a signed-out CLI fails every check).
export function composeDoctor(c: Config): string {
  const row = (label: string, fix: string, cmd: string, extra = "") => `row ${sq(label)} ${sq(fix)} ${sq(cmd)}${extra}`;
  const steps = stepsFor(c).map((s, i) =>
    row(`${i + 1}. ${s.title}`, `docs/setup.md step ${i + 1}, ${s.title}${s.who === "human" ? "; then: bash scripts/setup-wizard.sh" : ""}`, doctorCmd(s),
      ` ${s.exec ? 1 : 0} ${s.verify.includes("<app-host>") ? "APP_HOST" : "-"}`));
  return `#!/usr/bin/env bash
# Setup self-check (generated; the step rows are docs/setup.md). Reads names and exit codes only: every command's output is discarded.
set -uo pipefail
${ROOT}export APP_NAME="\${APP_NAME:-${c.name}}"
LIMIT="\${DOCTOR_LIMIT:-30}"
PASSED=0; FAILED=0; UNCHECKED=0; BLOCK=""

# tree PID: PID and every descendant, listed before anything is signalled (a killed parent would orphan its children from pgrep).
tree() { local c; for c in $(pgrep -P "$1"); do tree "$c"; done; printf '%s ' "$1"; }
# probe CMD: exit 0 when CMD passes. No stdin, no output. After LIMIT seconds the whole process tree gets TERM, then KILL a second later for
# whatever is still alive. The watcher leaves a marker before it kills, so a timeout is what the watcher did, not a guess from elapsed time:
# a timed-out probe always fails, even when the CLI caught TERM and exited 0.
probe() {
  TIMEDOUT=0
  bash -c "$1" </dev/null >/dev/null 2>&1 &
  local p=$! x
  local mark="\${TMPDIR:-/tmp}/doctor.$$.$p"
  ( i=0; while kill -0 "$p" && (( i < LIMIT )); do sleep 1; i=$((i + 1)); done
    if kill -0 "$p"; then all=$(tree "$p"); : > "$mark"; kill $all; sleep 1; for x in $all; do kill -0 "$x" && kill -9 "$x"; done; fi ) >/dev/null 2>&1 &
  local w=$!
  wait "$p" 2>/dev/null; local rc=$?
  if [[ -e "$mark" ]]; then TIMEDOUT=1; wait "$w" 2>/dev/null; rm -f "$mark"; return 1; fi
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; rm -f "$mark"
  return $rc
}
# row LABEL FIX CMD [SIGNIN [NEEDS_ENV]]: SIGNIN=1 blocks every later row when it fails; NEEDS_ENV is an env var CMD cannot run without.
row() {
  if [[ -n "$BLOCK" ]]; then printf 'NOT CHECKED  %s\\n               sign in first: %s\\n' "$1" "$BLOCK"; UNCHECKED=$((UNCHECKED + 1)); return; fi
  local fix=$2
  TIMEDOUT=0
  if [[ "\${5:--}" != "-" && -z "\${!5:-}" ]]; then fix="$5=<your host> bun run doctor"
  elif probe "$3"; then printf 'PASS         %s\\n' "$1"; PASSED=$((PASSED + 1)); return; fi
  if (( TIMEDOUT )); then fix="timed out after \${LIMIT}s"; fi
  printf 'FAIL         %s\\n               fix: %s\\n' "$1" "$fix"; FAILED=$((FAILED + 1))
  if [[ "\${4:-0}" == 1 ]]; then BLOCK="step \${1%%.*} \${1#*. }"; fi
}

${row("Local env (void env check)", "void env check", "void env check")}
${row("Local migrations (void db status)", "void db migrate", `out=$(void db status) && ! grep -q 'pending locally' <<<"$out" && ! grep -qi 'drift detected' <<<"$out" && grep -Eq '^ *[0-9]+ migrations?$' <<<"$out"`)}
${steps.join("\n")}
${row("Remote env names (void env check --remote)", "void env check --remote", "void env check --remote")}

printf '\\n%s passed, %s failed, %s not checked.\\n' "$PASSED" "$FAILED" "$UNCHECKED"
if (( FAILED + UNCHECKED )); then printf 'Start with the first FAIL.\\n'; exit 1; fi
`;
}

// docs/setup.md and scripts/doctor.sh always; scripts/setup-wizard.sh only when a human step applies.
export function writeSetupFiles(dir: string, c: Config): void {
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "docs/setup.md"), composeSetupDoc(c));
  for (const [n, body] of [["doctor.sh", composeDoctor(c)], ["setup-wizard.sh", composeWizard(c)]] as const) {
    if (body === null) continue;
    writeFileSync(join(dir, "scripts", n), body);
    chmodSync(join(dir, "scripts", n), 0o755);
  }
}
