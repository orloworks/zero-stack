import { cancel, confirm, isCancel, text } from "@clack/prompts";
import { FEATURE_LIST, type FlagInput } from "./flags";

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
  text: async (message) => guard<string>(await text({ message })),
  confirm: async (message) => guard<boolean>(await confirm({ message, initialValue: false })),
};

// Asks only for what flags left undefined; the result goes through validateFlags like flag-only input.
export async function fillPrompts(
  input: Partial<FlagInput>,
  ui: Ui,
): Promise<FlagInput> {
  const out = { ...input };
  out.name ??= await ui.text("Project name");
  for (const f of FEATURE_LIST) {
    // Skipped when a feature already on implies this one, when the framework excludes it, or when what it requires is not on.
    const implied = FEATURE_LIST.some((g) => g.requires === f.key && out[g.key]);
    const allowed = !f.frameworks || f.frameworks.includes(out.framework ?? "react");
    if (out[f.key] === undefined && !implied && allowed && (!f.requires || out[f.requires as keyof FlagInput]))
      (out as Record<string, unknown>)[f.key] = await ui.confirm(f.prompt);
  }
  return out as FlagInput;
}
