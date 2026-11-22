import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "void/client/svelte";

// The admin pages' auth client: Better Auth's admin plugin calls (ban, sessions, delete). The Account and sign-in pages keep `auth` from void/client.
export const adminAuth = createAuthClient({ basePath: "/api/auth", plugins: [adminClient()] });
