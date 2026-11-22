import { defineHandler, type InferProps } from "void";
import { describeAudit, listAudit, PAGE_SIZE, requireAdmin } from "../../src/admin";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  requireAdmin(c);
  const user = (c.req.query("user") ?? "").trim().slice(0, 200);
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  try {
    const { rows, total } = await listAudit(user, page);
    return {
      user, page, pageSize: PAGE_SIZE, total, loadError: false,
      entries: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, text: describeAudit(r) })),
    };
  } catch (e) {
    console.error("admin audit load failed", e);
    return { user, page, pageSize: PAGE_SIZE, total: 0, loadError: true, entries: [] };
  }
});
