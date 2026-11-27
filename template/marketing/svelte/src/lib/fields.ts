// The string fields of a request body, whichever way it was sent: JSON, a form (urlencoded) or multipart. Mail providers send the one-click unsubscribe as a form,
// the pages send JSON, and a plain HTML form sends either form kind. A body that cannot be read, or a field that is not a string, is simply absent.
type Req = { header(name: string): string | undefined; json(): Promise<unknown>; parseBody(): Promise<Record<string, unknown>> };

export async function fields(c: { req: Req }): Promise<Record<string, string>> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  try {
    const raw = type.includes("application/json") ? await c.req.json() : type.includes("form") ? await c.req.parseBody() : {};
    return Object.fromEntries(Object.entries(raw && typeof raw === "object" ? raw : {}).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  } catch {
    return {};
  }
}
