import type { Config } from "../flags";

// The root auth.ts, written whole from the enabled features (one owner; add-ons contribute parts here, never patch the file).
// Svelte only: react, vue and solid --auth keep v0.1 output (no auth.ts).
export function composeAuthTs(_config: Config): string {
  return `import { defineAuth } from "void/auth";

export default defineAuth(({ defaults }) => ({
  ...defaults,
}));
`;
}
