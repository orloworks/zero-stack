import { defineHandler, type InferProps } from "void";
import { findList } from "../src/consent";

export type Props = InferProps<typeof loader>;

// No database read at all: opening the link (or a mail scanner doing it) changes nothing, and the page looks the same for any token.
export const loader = defineHandler((c) => {
  const list = findList(c.req.query("list"));
  return { token: c.req.query("token") ?? "", list: list?.name ?? "", label: list?.label ?? "" };
});
