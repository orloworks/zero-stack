import { defineHandler, type InferProps } from "void";
import { readConfirmation } from "../src/consent";

export type Props = InferProps<typeof loader>;

// A read: opening the link (or a mail scanner doing it) changes nothing. Only the Confirm button's POST records consent.
export const loader = defineHandler(async (c) => {
  const token = c.req.query("token") ?? "";
  const { status, list } = await readConfirmation(token);
  return { token, status, label: list?.label ?? "" };
});
