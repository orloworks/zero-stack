import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { anchorError, editJson, needKey } from "../anchor";
import { ZOD } from "../versions";

// Void's defineHandler.withValidator accepts any Standard Schema and feeds void/client's types,
// so @hono/zod-validator is not needed (SPEC listed it; see ticket #9 notes).
// Needs a `bun install` afterwards (the pipeline runs one).
export function installZodRpc(dir: string): void {
  if (!existsSync(join(dir, "routes/api"))) throw anchorError("routes/api", "the generated app");
  if (existsSync(join(dir, "routes/api/echo.ts"))) throw anchorError("routes/api/echo.ts", "the generated app", "already exists");
  editJson(dir, "package.json", (pkg) => { Object.assign(needKey(pkg, "dependencies", "package.json"), { zod: ZOD }); });
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
