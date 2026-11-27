import { expect, test } from "bun:test";
import { firstLink, linkByPath, mailIds } from "../../scripts/gate/inbox";

const row = (id: string, subject: string, to: string) =>
  `<tr><td><a href="/__void/inbox/${id}?x=1">${subject}</a></td><td>${to}</td></tr>`;
const list = (...rows: string[]) => `<table><tr><th>Subject</th></tr>${rows.join("")}</table>`;

test("mailIds keeps the rows with this subject and this recipient, in order", () => {
  const html = list(
    row("a1", "Set your password", "Ann@Example.com"),
    row("b2", "Verify your email", "ann@example.com"),
    row("c3", "Set your password", "bob@example.com"),
    row("d4", "Set your password", "ann@example.com"),
  );
  expect(mailIds(html, "Set your password", "ann@example.com")).toEqual(["a1", "d4"]);
  expect(mailIds(html, "Verify your email", "ANN@example.com")).toEqual(["b2"]);
});

test("mailIds finds nothing for an unknown subject, an unknown recipient or an empty inbox", () => {
  const html = list(row("a1", "Set your password", "ann@example.com"));
  expect(mailIds(html, "Reset your password", "ann@example.com")).toEqual([]);
  expect(mailIds(html, "Set your password", "nobody@example.com")).toEqual([]);
  expect(mailIds("", "Set your password", "ann@example.com")).toEqual([]);
});

test("mailIds skips a matching row that has no detail link", () => {
  expect(mailIds(list("<tr><td><a>Set your password</a></td><td>ann@example.com</td></tr>"), "Set your password", "ann@example.com")).toEqual([]);
});

test("firstLink returns the first http(s) link with &amp; decoded", () => {
  const html = "<pre>Hello\nOpen https://app.test/api/auth/reset-password/tok?callbackURL=%2Freset&amp;x=1 now\nor http://other.test/x</pre>";
  expect(firstLink(html)).toBe("https://app.test/api/auth/reset-password/tok?callbackURL=%2Freset&x=1");
});

test("firstLink stops at whitespace and at a tag, and is undefined with no link", () => {
  expect(firstLink("<p>http://a.test/p</p>")).toBe("http://a.test/p");
  expect(firstLink("<p>no link here</p>")).toBeUndefined();
});

test("linkByPath takes the link with exactly that path, not the first link, and decodes &amp;", () => {
  const html = "<pre>Confirm:\nhttp://app.test/confirm?token=abc&amp;x=1\n\nUnsubscribe: http://app.test/unsubscribe?token=u1&amp;list=newsletter\nhttps://other.test/confirm</pre>";
  expect(firstLink(html)).toBe("http://app.test/confirm?token=abc&x=1");
  expect(linkByPath(html, "/unsubscribe")).toBe("http://app.test/unsubscribe?token=u1&list=newsletter");
  expect(linkByPath(html, "/confirm")).toBe("http://app.test/confirm?token=abc&x=1");
});

test("linkByPath matches the whole path, and is undefined with no such link or no links", () => {
  const html = "<pre>http://app.test/confirm-later?t=1 http://app.test/x/confirm</pre>";
  expect(linkByPath(html, "/confirm")).toBeUndefined();
  expect(linkByPath("<p>nothing</p>", "/confirm")).toBeUndefined();
  expect(linkByPath("<p>http://[bad</p>", "/confirm")).toBeUndefined();
});
