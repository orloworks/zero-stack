import type { Config } from "./flags";

// What the CLI prints after "Done." for the features that need a first step.
export function closingLines(config: Config): string[] {
  return [
    ...(config.auth && config.framework === "svelte" ? ["Account page: /settings (link it from your nav)."] : []),
    ...(config.payments ? ["Billing page: /billing. Put sandbox Stripe keys in .env, then bun run stripe:seed (docs/setup.md)."] : []),
    ...(config.admin ?["To use /admin, sign in with an email on ADMIN_EMAILS and verify it."] : []),
  ];
}
