// Your runtime settings: declare one by adding it to SETTINGS, with a key, a type (text, number with optional min and max, boolean, or a choice of fixed values),
// a default and a description. Read it on the server with `await setting("key")` (src/settings.ts): it returns the stored value or the default, typed from the
// declaration. An admin edits each one on the Settings page. A setting is never a secret: admins and the audit log see every value; put secrets in env.ts.
// This file holds only the list, so an upgrade never conflicts with it. The scaffold ships four examples (and routes/api/example-settings.ts, which reads
// them): replace them, change that route to match, or empty the list.
import type { SettingDecl } from "../lib/setting-value";

export const SETTINGS = {
  "example-text": { type: "text", default: "Hello", description: "A line of text the app shows somewhere." },
  "example-number": { type: "number", default: 10, min: 1, max: 100, description: "A number between 1 and 100." },
  "example-toggle": { type: "boolean", default: false, description: "An on/off switch." },
  "example-choice": { type: "choice", values: ["small", "medium", "large"], default: "medium", description: "One of a fixed set of values." },
} as const satisfies Record<string, SettingDecl>;
