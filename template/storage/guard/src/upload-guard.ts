// An upload that finishes after its user was deleted (a self-delete or an admin delete racing the PUT) would leave a file no purge sweeps again.
// Called after the R2 put: if the user row is gone, the object is removed. Returns true when it discarded the upload.
export async function discardIfUserGone(key: string, userExists: () => Promise<boolean>, bucket: { delete(key: string): Promise<unknown> }): Promise<boolean> {
  if (await userExists()) return false;
  await bucket.delete(key);
  return true;
}

// Read on use: Void's plugin loads auth.ts at startup, where bindings are not available.
export async function userExists(id: string): Promise<boolean> {
  const { db, eq, userTable } = { ...(await import("void/db")), ...(await import("../.void/better-auth-schema")) };
  return (await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, id)).limit(1)).length > 0;
}
