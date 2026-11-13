import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CREATE_VOID, ZOD } from "../versions";

// Void's defineHandler.withValidator accepts any Standard Schema and feeds void/client's types,
// so @hono/zod-validator is not needed (SPEC listed it; see ticket #9 notes).
// Needs a `bun install` afterwards (the pipeline runs one).
export function installZodRpc(dir: string): void {
  if (!existsSync(join(dir, "routes/api"))) throw new Error(`routes/api anchor missing (create-void@${CREATE_VOID})`);
  if (existsSync(join(dir, "routes/api/echo.ts"))) throw new Error(`routes/api/echo.ts already exists (create-void@${CREATE_VOID})`);
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { ...pkg.dependencies, zod: ZOD };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "routes/api/echo.ts"),
    `import { defineHandler } from "void";
import { z } from "zod";

export const POST = defineHandler.withValidator({
  body: z.object({ name: z.string().min(1) }),
})((c, { body }) => ({ greeting: \`Hello, \${body.name}\` }));
`,
  );
  writeFileSync(
    join(dir, "src/rpc.ts"),
    `import { fetch } from "void/client";

// The body type comes from the zod schema in routes/api/echo.ts; a wrong body fails the type check.
export const greet = (name: string) => fetch("/api/echo", { method: "POST", body: { name } });
`,
  );
}
