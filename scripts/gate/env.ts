// The one rule for editing an app's `.env` between dev-server restarts (pure; no imports).
// A string value replaces the key's line in place, or is appended when the key is not there; null deletes the line.
// Each key is written once, so the order of keys in the file cannot change what the app reads.
export function editEnv(text: string, edits: Record<string, string | null>): string {
  for (const [key, value] of Object.entries(edits)) {
    const at = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (value === null) text = text.replace(new RegExp(`^${at}=.*(\\n|$)`, "m"), "");
    else if (new RegExp(`^${at}=`, "m").test(text)) text = text.replace(new RegExp(`^${at}=.*$`, "m"), () => `${key}=${value}`);
    else text += `${text && !text.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
  }
  return text;
}
