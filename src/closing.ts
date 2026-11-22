import type { Config } from "./flags";

// What the CLI prints after "Done." for the features that need a first step.
export function closingLines(config: Config): string[] {
  return [
    ...(config.auth && config.framework === "svelte" ? ["Account page: /settings (link it from your nav)."] : []),
    ...(config.admin ? ["To use /admin, sign in with an email on ADMIN_EMAILS and verify it."] : []),
  ];
}
