import { CREATE_VOID } from "./versions";

// Replace the one occurrence of `anchor` in `text`; anything else is a hard error.
export function replaceAnchor(text: string, anchor: string, replacement: string, file: string): string {
  const n = text.split(anchor).length - 1;
  if (n !== 1)
    throw new Error(
      `Anchor ${JSON.stringify(anchor)} ${n === 0 ? "not found" : `found ${n} times`} in ${file} ` +
        `(create-void@${CREATE_VOID}). The generated output changed; update the installer.`,
    );
  return text.replace(anchor, () => replacement);
}
