export const FRAMEWORKS = ["react", "vue", "svelte", "solid"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

// The single list of installer flags. CLI parsing, usage, prompts, the gate argv and the ci:full matrix all derive from it.
// `requires` is another feature's key that this one implies; `frameworks` limits where it is valid (omitted = any).
export const FEATURES = [
  { flag: "tailwind", key: "tailwind", label: "Tailwind", prompt: "Add Tailwind?" },
  { flag: "shadcn", key: "shadcn", label: "shadcn/ui", prompt: "Add shadcn/ui?", requires: "tailwind", frameworks: ["react"] },
  { flag: "zod-rpc", key: "zodRpc", label: "typed zod RPC", prompt: "Add typed zod RPC?" },
  { flag: "auth", key: "auth", label: "auth", prompt: "Add auth?" },
  { flag: "account-deletion", key: "accountDeletion", label: "account deletion", prompt: "Add account deletion?", requires: "auth", frameworks: ["svelte"] },
  { flag: "email", key: "email", label: "email", prompt: "Add email?", requires: "auth", frameworks: ["svelte"] },
  { flag: "turnstile", key: "turnstile", label: "Turnstile", prompt: "Add Turnstile?", requires: "auth", frameworks: ["svelte"] },
  { flag: "storage", key: "storage", label: "storage", prompt: "Add storage?", requires: "auth" },
] as const satisfies readonly {
  flag: string; key: string; label: string; prompt: string; requires?: string; frameworks?: readonly Framework[];
}[];
export type Feature = { flag: string; key: FeatureKey; label: string; prompt: string; requires?: FeatureKey; frameworks?: readonly string[] };
export type FeatureKey = (typeof FEATURES)[number]["key"];
export const FEATURE_LIST: readonly Feature[] = FEATURES;

// Add-on keys are optional so hand-built configs (test fixtures) need not list them; validateFlags always sets every key.
type AddOnKey = Extract<(typeof FEATURES)[number], { requires: "auth" }>["key"];
export type Config = { name: string; framework: Framework } & Record<Exclude<FeatureKey, AddOnKey>, boolean> & Partial<Record<AddOnKey, boolean>>;
export type FlagInput = Partial<Omit<Config, "framework">> & { name: string; framework?: string };

export function validateFlags(input: FlagInput): { config: Config; notes: string[] } {
  const { name, framework = "react" } = input;
  const notes: string[] = [];
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Name "${name}" must be lowercase a-z, 0-9 and "-" only.`);
  if (name.length > 63) throw new Error(`Name must be 63 characters or fewer (got ${name.length}).`);
  if (!(FRAMEWORKS as readonly string[]).includes(framework))
    throw new Error(`--framework must be one of: ${FRAMEWORKS.join(", ")}.`);
  const on = Object.fromEntries(FEATURE_LIST.map((f) => [f.key, input[f.key] ?? false])) as Record<FeatureKey, boolean>;
  for (const f of FEATURE_LIST)
    if (on[f.key] && f.frameworks && !f.frameworks.includes(framework))
      throw new Error(`--${f.flag} requires --framework ${f.frameworks.join("|")} (got ${framework}); drop --${f.flag} or use --framework ${f.frameworks[0]}.`);
  for (const f of FEATURE_LIST) {
    const req = FEATURE_LIST.find((r) => r.key === f.requires);
    if (on[f.key] && req && !on[req.key]) {
      on[req.key] = true;
      notes.push(`--${f.flag} implies --${req.flag}; enabling ${req.label}.`);
    }
  }
  return { config: { name, framework: framework as Framework, ...on }, notes };
}
