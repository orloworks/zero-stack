export const FRAMEWORKS = ["react", "vue", "svelte", "solid"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

// The single list of installer flags. CLI parsing, usage, prompts, the gate argv and the ci:full matrix all derive from it.
// `requires` is the key (or keys) of other features that this one implies; `frameworks` limits where it is valid (omitted = any).
export const FEATURES = [
  { flag: "tailwind", key: "tailwind", label: "Tailwind", prompt: "Add Tailwind?" },
  { flag: "shadcn", key: "shadcn", label: "shadcn/ui", prompt: "Add shadcn/ui?", requires: "tailwind", frameworks: ["react"] },
  { flag: "zod-rpc", key: "zodRpc", label: "typed zod RPC", prompt: "Add typed zod RPC?" },
  { flag: "auth", key: "auth", label: "auth", prompt: "Add auth?" },
  { flag: "account-deletion", key: "accountDeletion", label: "account deletion", prompt: "Add account deletion?", requires: "auth", frameworks: ["svelte"] },
  { flag: "email", key: "email", label: "email", prompt: "Add email?", requires: "auth", frameworks: ["svelte"] },
  { flag: "turnstile", key: "turnstile", label: "Turnstile", prompt: "Add Turnstile?", requires: "auth", frameworks: ["svelte"] },
  { flag: "invite-only", key: "inviteOnly", label: "invite-only signup", prompt: "Restrict sign-up to invited emails?", requires: "email", frameworks: ["svelte"] },
  { flag: "admin", key: "admin", label: "admin area", prompt: "Add an admin area?", requires: "email", frameworks: ["svelte"] },
  { flag: "payments", key: "payments", label: "Stripe payments", prompt: "Add Stripe payments?", requires: "auth", frameworks: ["svelte"] },
  { flag: "storage", key: "storage", label: "storage", prompt: "Add storage?", requires: "auth" },
  { flag: "secrets", key: "secrets", label: "Infisical secrets", prompt: "Sync secrets with Infisical?", requires: "auth", value: "infisical" },
  { flag: "marketing", key: "marketing", label: "marketing mail", prompt: "Add marketing mail (lists, consent, unsubscribe)?", requires: ["admin", "turnstile"], frameworks: ["svelte"] },
] as const satisfies readonly {
  flag: string; key: string; label: string; prompt: string; requires?: string | readonly string[]; frameworks?: readonly Framework[]; value?: string;
}[];
export type Feature = { flag: string; key: FeatureKey; label: string; prompt: string; requires?: FeatureKey | readonly FeatureKey[]; frameworks?: readonly string[]; value?: string };
export type FeatureKey = (typeof FEATURES)[number]["key"];
export const FEATURE_LIST: readonly Feature[] = FEATURES;

// The keys a feature implies, however its `requires` is written (none, one or several).
export const impliedKeys = (f: Feature): readonly FeatureKey[] => (f.requires === undefined ? [] : typeof f.requires === "string" ? [f.requires] : f.requires);

// The one place a feature's CLI form is derived: usage, parseArgs, the gate and the ci:full matrix all use it.
// A feature with `value` is `--flag value` (config key stays a boolean); the rest are bare `--flag`.
export const argv = (f: Feature): string[] => (f.value ? [`--${f.flag}`, f.value] : [`--${f.flag}`]);

// Raw parseArgs value -> the config boolean (undefined = flag not given). A valued feature accepts only its value.
export function parseFeature(f: Feature, raw: string | boolean | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (f.value && raw !== f.value) throw new Error(`--${f.flag} accepts only "${f.value}" (got "${raw}").`);
  return true;
}

// Add-on keys are optional so hand-built configs (test fixtures) need not list them; validateFlags always sets every key.
// Every feature that implies another, except shadcn (which implies Tailwind and stays required), however many keys its `requires` lists.
type AddOnKey = (typeof FEATURES)[number] extends infer R ? (R extends { key: infer K; requires: infer Q } ? ([Q] extends ["tailwind"] ? never : K) : never) : never;
export type Config = { name: string; framework: Framework } & Record<Exclude<FeatureKey, AddOnKey>, boolean> & Partial<Record<AddOnKey, boolean>>;
export type FlagInput = Partial<Omit<Config, "framework">> & { name: string; framework?: string };

export function validateFlags(input: FlagInput): { config: Config; notes: string[] } {
  const { name, framework = "react" } = input;
  const notes: string[] = [];
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Name "${name}" must be lowercase a-z, 0-9 and "-" only.`);
  if (name.startsWith("-")) throw new Error(`Name "${name}" must not start with "-": it would read as a flag.`);
  if (name === "upgrade") throw new Error('Name "upgrade" is reserved: "upgrade" is the command that upgrades the app in the current folder. Pick another name.');
  if (name.length > 63) throw new Error(`Name must be 63 characters or fewer (got ${name.length}).`);
  if (!(FRAMEWORKS as readonly string[]).includes(framework))
    throw new Error(`--framework must be one of: ${FRAMEWORKS.join(", ")}.`);
  for (const f of FEATURE_LIST) if (input[f.key] !== undefined && typeof input[f.key] !== "boolean") throw new Error(`${f.key} must be true or false (got ${JSON.stringify(input[f.key])}).`);
  const on = Object.fromEntries(FEATURE_LIST.map((f) => [f.key, input[f.key] ?? false])) as Record<FeatureKey, boolean>;
  for (const f of FEATURE_LIST)
    if (on[f.key] && f.frameworks && !f.frameworks.includes(framework))
      throw new Error(`--${f.flag} requires --framework ${f.frameworks.join("|")} (got ${framework}); drop --${f.flag} or use --framework ${f.frameworks[0]}.`);
  // Repeat until stable: --invite-only implies --email, which in turn implies --auth.
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of FEATURE_LIST)
      for (const key of impliedKeys(f)) {
        const req = FEATURE_LIST.find((r) => r.key === key)!;
        if (on[f.key] && !on[req.key]) {
          on[req.key] = true;
          changed = true;
          notes.push(`--${f.flag} implies --${req.flag}; enabling ${req.label}.`);
        }
      }
  }
  return { config: { name, framework: framework as Framework, ...on }, notes };
}
