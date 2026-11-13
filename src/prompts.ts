import { cancel, confirm, isCancel, text } from "@clack/prompts";
import type { FlagInput } from "./flags";

export type Ui = {
  text(message: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
};

const guard = <T>(v: T | symbol): T => {
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as T;
};

export const clackUi: Ui = {
  text: async (message) => guard(await text({ message })),
  confirm: async (message) => guard(await confirm({ message, initialValue: false })),
};

// Asks only for what flags left undefined; the result goes through validateFlags like flag-only input.
export async function fillPrompts(
  input: Partial<FlagInput>,
  ui: Ui,
): Promise<FlagInput> {
  const out = { ...input };
  out.name ??= await ui.text("Project name");
  if (out.tailwind === undefined && !out.shadcn) out.tailwind = await ui.confirm("Add Tailwind?");
  if (out.shadcn === undefined && (out.framework ?? "react") === "react") out.shadcn = await ui.confirm("Add shadcn/ui?");
  out.zodRpc ??= await ui.confirm("Add typed zod RPC?");
  out.auth ??= await ui.confirm("Add auth?");
  return out as FlagInput;
}
