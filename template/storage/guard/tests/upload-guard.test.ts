import { expect, it } from "vite-plus/test";
import { discardIfUserGone } from "../src/upload-guard";

const bucket = () => {
  const deleted: string[] = [];
  return { deleted, delete: async (k: string) => void deleted.push(k) };
};

it("keeps the upload while the user still exists", async () => {
  const b = bucket();
  expect(await discardIfUserGone("users/u1/a", async () => true, b)).toBe(false);
  expect(b.deleted).toEqual([]);
});

it("deletes the object when the user row is gone after the put", async () => {
  const b = bucket();
  expect(await discardIfUserGone("users/u1/a", async () => false, b)).toBe(true);
  expect(b.deleted).toEqual(["users/u1/a"]);
});

it("lets a failing existence check through, so the upload is not reported as stored", async () => {
  await expect(discardIfUserGone("users/u1/a", async () => Promise.reject(new Error("db down")), bucket())).rejects.toThrow("db down");
});
