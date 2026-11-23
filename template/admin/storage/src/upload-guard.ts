// An upload that finishes after its user was deleted (an admin delete or a self-delete racing the PUT) would leave a file no purge sweeps again.
// Called after the R2 put: if the user row is gone, the object is removed. Returns true when it discarded the upload.
export async function discardIfUserGone(key: string, userExists: () => Promise<boolean>, bucket: { delete(key: string): Promise<unknown> }): Promise<boolean> {
  if (await userExists()) return false;
  await bucket.delete(key);
  return true;
}
