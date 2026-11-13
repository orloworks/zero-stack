export const FRAMEWORKS = ["react", "vue", "svelte", "solid"] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export type Config = {
  name: string;
  framework: Framework;
  tailwind: boolean;
  shadcn: boolean;
  zodRpc: boolean;
  auth: boolean;
};
export type FlagInput = Partial<Omit<Config, "framework">> & { name: string; framework?: string };

export function validateFlags(input: FlagInput): { config: Config; notes: string[] } {
  const { name, framework = "react", shadcn = false, zodRpc = false, auth = false } = input;
  let tailwind = input.tailwind ?? false;
  const notes: string[] = [];
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Name "${name}" must be lowercase a-z, 0-9 and "-" only.`);
  if (name.length > 63) throw new Error(`Name must be 63 characters or fewer (got ${name.length}).`);
  if (!(FRAMEWORKS as readonly string[]).includes(framework))
    throw new Error(`--framework must be one of: ${FRAMEWORKS.join(", ")}.`);
  if (shadcn && framework !== "react")
    throw new Error(`--shadcn requires --framework react (got ${framework}); drop --shadcn or use --framework react.`);
  if (shadcn && !tailwind) {
    tailwind = true;
    notes.push("--shadcn implies --tailwind; enabling Tailwind.");
  }
  return { config: { name, framework: framework as Framework, tailwind, shadcn, zodRpc, auth }, notes };
}
