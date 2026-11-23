import { defineHandler } from "void";
import { features, requireFeature } from "../../src/access";

// A gated route: requireFeature replaces requireAuth(c), returns the signed-in user, and answers 401 signed out or 403 when the feature is off for them.
// An example: delete this file when you replace "example-feature" in src/access.ts.
export const GET = defineHandler(async (c) => {
  await requireFeature(c, "example-feature");
  return c.json({ feature: "example-feature", features: [...(await features(c))] });
});
