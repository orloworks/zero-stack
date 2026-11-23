import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { setting } from "../../src/settings";

// Reading settings: `await setting("key")` is typed from its declaration. An example: delete this file when you replace the examples in src/settings.ts.
export const GET = defineHandler(async (c) => {
  requireAuth(c);
  return c.json({
    text: await setting("example-text"),
    number: await setting("example-number"),
    toggle: await setting("example-toggle"),
    choice: await setting("example-choice"),
  });
});
