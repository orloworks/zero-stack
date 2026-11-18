import type { Config } from "../flags";

// The root auth.ts, written whole from the enabled features (one owner; add-ons contribute parts here, never patch the file).
// Svelte only: react, vue and solid --auth keep v0.1 output (no auth.ts).
export function composeAuthTs(config: Config): string {
  const options = [
    // Better Auth verifies the password sent to deleteUser; the Account page always sends it (D6).
    ...(config.accountDeletion ? ["  user: { deleteUser: { enabled: true } },"] : []),
  ];
  return `import { defineAuth } from "void/auth";

export default defineAuth(({ defaults }) => ({
  ...defaults,
${options.map((o) => o + "\n").join("")}}));
`;
}
