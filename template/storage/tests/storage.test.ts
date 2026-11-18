import { expect, it } from "vite-plus/test";
import { purgeUserFiles, userKey, type Bucket } from "../src/storage";

it("userKey keeps names under the user's prefix and rejects anything that could leave it", () => {
  expect(userKey("u1", "a.txt")).toBe("users/u1/a.txt");
  for (const bad of ["", ".", "..", "../u2/a", "a/b", "a\\b", "a\u0000b", "x".repeat(201)]) expect(userKey("u1", bad)).toBeNull();
});

// A bucket of keys that lists two per page; the cursor is the last key seen, like R2's, so deleting while paging is safe.
const fake = (keys: string[], failDelete = false) => {
  const deleted: string[][] = [];
  const bucket: Bucket = {
    async list({ prefix, cursor }) {
      const all = keys.filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
      const objects = all.slice(0, 2).map((key) => ({ key }));
      return all.length > 2 ? { objects, truncated: true, cursor: objects[1]!.key } : { objects, truncated: false };
    },
    async delete(ks) {
      if (failDelete) throw new Error("r2 down");
      deleted.push(ks);
      for (const k of ks) keys.splice(keys.indexOf(k), 1);
    },
  };
  return { bucket, deleted, keys };
};

it("purgeUserFiles batch-deletes every page of the user's prefix and nothing else", async () => {
  const { bucket, deleted, keys } = fake(["users/u1/a", "users/u1/b", "users/u1/c", "users/u10/a", "users/u2/a"]);
  await purgeUserFiles("u1", bucket);
  expect(deleted.flat().sort()).toEqual(["users/u1/a", "users/u1/b", "users/u1/c"]);
  expect(keys.sort()).toEqual(["users/u10/a", "users/u2/a"]);
});

it("purgeUserFiles lets a storage error through", async () => {
  await expect(purgeUserFiles("u1", fake(["users/u1/a"], true).bucket)).rejects.toThrow("r2 down");
});
