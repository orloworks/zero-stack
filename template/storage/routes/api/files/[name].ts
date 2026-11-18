import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { storage } from "void/storage";
import { userKey } from "../../../src/storage";

// Per-user files under users/<id>/<name>; the id comes from the signed-in user, never from the request path.
const invalid = () => new Response("Invalid file name.", { status: 400 });

// The body streams to R2 (never buffered in the Worker); R2 needs the length up front.
export const PUT = defineHandler(async (c) => {
  const key = userKey(requireAuth(c).id, c.req.param("name") ?? "");
  if (!key) return invalid();
  const body = c.req.raw.body;
  if (!body || !c.req.header("content-length")) return new Response("Send the file as the request body with a Content-Length.", { status: 411 });
  await storage.put(key, body, { httpMetadata: { contentType: c.req.header("content-type") } });
  return new Response(null, { status: 201 });
});

export const GET = defineHandler(async (c) => {
  const key = userKey(requireAuth(c).id, c.req.param("name") ?? "");
  if (!key) return invalid();
  const object = await storage.get(key);
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Uploaded HTML or SVG must not run as a page on your site.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", "attachment");
  return new Response(object.body, { headers });
});

export const DELETE = defineHandler(async (c) => {
  const key = userKey(requireAuth(c).id, c.req.param("name") ?? "");
  if (!key) return invalid();
  await storage.delete(key);
  return new Response(null, { status: 204 });
});
