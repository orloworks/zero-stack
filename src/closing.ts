import type { Config } from "./flags";

// What the CLI prints after "Done." for the features that need a first step.
export function closingLines(config: Config): string[] {
  return [
    ...(config.auth && config.framework === "svelte" ? ["Account page: /settings (link it from your nav)."] : []),
    ...(config.payments ? ["Billing page: /billing. Put sandbox Stripe keys in .env, then bun run stripe:seed (docs/setup.md)."] : []),
    ...(config.admin
      ? [config.inviteOnly
          ? "To use /admin, sign up with an email on ADMIN_EMAILS and set your password from the link mailed to it."
          : "To use /admin, sign up with an email on ADMIN_EMAILS, open the verification link, then set your password from the link that follows."]
      : []),
  ];
}
