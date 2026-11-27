// Pure parsers for Void's dev inbox pages (no I/O, no imports: a unit test loads this file alone).

// Ids of the mails with this subject sent to this address: list rows carry the subject, the recipient and a detail link.
export const mailIds = (listHtml: string, subject: string, to: string): string[] =>
  listHtml.split("<tr>").filter((r) => r.includes(`>${subject}</a>`) && r.toLowerCase().includes(to.toLowerCase()))
    .flatMap((r) => r.match(/href="\/__void\/inbox\/([^/?"]+)\?/)?.[1] ?? []);

// The first link in a mail's detail page whose path is exactly `path` (a mail with several links: a confirm link and a footer link); `&amp;` is decoded.
export const linkByPath = (detailHtml: string, path: string): string | undefined =>
  (detailHtml.match(/https?:\/\/[^\s<]+/g) ?? []).map((l) => l.replaceAll("&amp;", "&")).find((l) => {
    try { return new URL(l).pathname === path; } catch { return false; }
  });

// The first link in a mail's detail page; the page shows the text body escaped, so `&amp;` is decoded.
export const firstLink = (detailHtml: string): string | undefined =>
  detailHtml.match(/https?:\/\/[^\s<]+/)?.[0]?.replaceAll("&amp;", "&");
