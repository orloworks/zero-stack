import { argv, FEATURE_LIST, FRAMEWORKS } from "../src/flags";

// The ci:full permutations. Every framework with all flags valid for it (derived from FEATURE_LIST), plus single-flag and bare runs.
// Add-on runs that exercise an installed add-on are added by the ticket that implements it.
const all = (fw: string) => FEATURE_LIST.filter((f) => !f.frameworks || f.frameworks.includes(fw)).flatMap(argv);
export const MATRIX: { name: string; args: string[] }[] = [
  ...FRAMEWORKS.map((fw) => ({ name: `${fw}-all`, args: ["--framework", fw, ...all(fw)] })),
  { name: "bare", args: [] },
  { name: "auth", args: ["--auth"] },
  { name: "svelte-auth", args: ["--framework", "svelte", "--auth"] },
  { name: "svelte-account-deletion", args: ["--framework", "svelte", "--account-deletion"] },
  { name: "svelte-email", args: ["--framework", "svelte", "--auth", "--email"] },
  { name: "svelte-turnstile", args: ["--framework", "svelte", "--auth", "--turnstile"] },
  { name: "svelte-invite-only", args: ["--framework", "svelte", "--auth", "--invite-only"] },
  { name: "svelte-admin", args: ["--framework", "svelte", "--admin"] },
  { name: "svelte-admin-storage", args: ["--framework", "svelte", "--admin", "--storage"] },
  { name: "svelte-admin-invite-only", args: ["--framework", "svelte", "--admin", "--invite-only"] },
  { name: "svelte-payments", args: ["--framework", "svelte", "--auth", "--payments", "--account-deletion"] }, // deletion without --admin (#84)
  { name: "storage", args: ["--storage"] },
  { name: "svelte-secrets", args: ["--framework", "svelte", ...argv(FEATURE_LIST.find((f) => f.flag === "secrets")!)] },
  { name: "svelte-storage-deletion", args: ["--framework", "svelte", "--storage", "--account-deletion"] },
  { name: "tailwind", args: ["--tailwind"] },
  { name: "zod-rpc", args: ["--zod-rpc"] },
];
