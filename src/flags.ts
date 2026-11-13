export const FRAMEWORKS = ["react", "vue", "svelte", "solid"] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export type Config = { name: string; framework: Framework };

export function validateFlags(input: { name: string; framework?: string }): Config {
  const { name, framework = "react" } = input;
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Name "${name}" must be lowercase a-z, 0-9 and "-" only.`);
  if (name.length > 63) throw new Error(`Name must be 63 characters or fewer (got ${name.length}).`);
  if (!(FRAMEWORKS as readonly string[]).includes(framework))
    throw new Error(`--framework must be one of: ${FRAMEWORKS.join(", ")}.`);
  return { name, framework: framework as Framework };
}
