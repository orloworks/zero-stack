// Your mailing lists: declare one by adding it to LISTS, with a lower-case name, a label and a description. People join a list on the subscribe page and
// leave it from the link in a mail; the label and description are what they are shown and what the consent record keeps as the wording they agreed to.
// Every address needs a confirmation from its own inbox before it receives anything. Marketing mail never goes through the sign-in mail sender.
// This file holds only the list, so an upgrade never conflicts with it. Rows for a list that is no longer declared are ignored.
import type { ListDecl } from "../lib/consent-core";

export const LISTS = [{ name: "newsletter", label: "Newsletter", description: "Product news from us, now and then." }] as const satisfies readonly ListDecl[];
