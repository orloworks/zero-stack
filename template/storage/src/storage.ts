// Per-user object keys and the purge used when an account is deleted. Pure over a bucket so it unit-tests without R2.
export type Bucket = {
  list(o: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
};

export const userPrefix = (userId: string) => `users/${userId}/`;

// The object key for one file name, or null if the name could leave the user's prefix (empty, dot segments, separators, control characters).
export function userKey(userId: string, name: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!name || name === "." || name === ".." || name.length > 200 || /[/\\\u0000-\u001f]/.test(name)) return null;
  return userPrefix(userId) + name;
}

// Pages through the user's prefix and batch-deletes each page; any error propagates (callers fail closed).
export async function purgeUserFiles(userId: string, bucket?: Bucket): Promise<void> {
  // Imported on use: Void's plugin loads auth.ts at startup (vp test included), where a top-level void/storage import fails.
  const b = bucket ?? ((await import("void/storage")).storage as unknown as Bucket);
  let cursor: string | undefined;
  do {
    const page = await b.list({ prefix: userPrefix(userId), cursor });
    if (page.objects.length) await b.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
