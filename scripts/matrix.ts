import { FEATURE_LIST, FRAMEWORKS } from "../src/flags";

// The ci:full permutations. Every framework with all flags valid for it (derived from FEATURE_LIST), plus single-flag and bare runs.
// Add-on runs that exercise an installed add-on are added by the ticket that implements it.
const all = (fw: string) => FEATURE_LIST.filter((f) => !f.frameworks || f.frameworks.includes(fw)).map((f) => `--${f.flag}`);
export const MATRIX: { name: string; args: string[] }[] = [
  ...FRAMEWORKS.map((fw) => ({ name: `${fw}-all`, args: ["--framework", fw, ...all(fw)] })),
  { name: "bare", args: [] },
  { name: "auth", args: ["--auth"] },
  { name: "svelte-auth", args: ["--framework", "svelte", "--auth"] },
  { name: "tailwind", args: ["--tailwind"] },
  { name: "zod-rpc", args: ["--zod-rpc"] },
];
