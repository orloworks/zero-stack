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
  // On, or implied by a feature that is on, however many steps away (invite-only -> email -> auth).
  const isOn = (key: string): boolean => !!out[key as keyof typeof out] || FEATURE_LIST.some((g) => g.requires === key && isOn(g.key));
  const needsAuth = (key: string): boolean => {
    const req = FEATURE_LIST.find((g) => g.key === key)?.requires;
    return key === "auth" || (!!req && needsAuth(req));
  };
  for (const f of FEATURE_LIST) {
    // Skipped when a feature already on implies this one, when the framework excludes it, or when auth (add-ons) is off.
    // shadcn is asked even when Tailwind was declined; choosing it implies Tailwind (validateFlags).
    const implied = FEATURE_LIST.some((g) => g.requires === f.key && isOn(g.key));
    const allowed = !f.frameworks || f.frameworks.includes(out.framework ?? "react");
    if (out[f.key] === undefined && !implied && allowed && (f.key === "auth" || !needsAuth(f.key) || isOn("auth")))
      (out as Record<string, unknown>)[f.key] = await ui.confirm(f.prompt);
  }
  return out as FlagInput;
}
