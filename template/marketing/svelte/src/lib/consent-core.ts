// The consent rules, with no database and no clock: what state a subscriber's consent for one list moves to, and whether it may receive mail.
// src/consent.ts reads the facts, calls this, and writes the answer. Every fail-closed rule lives here so a table can test all of it.
//
// Invariant: every way of adding an address needs a confirmation from that inbox before any marketing mail goes to it. Only two events reach
// "confirmed": a Confirm press with a valid token, and a verified user's own choice (a user whose email is verified chooses the list on their Account page).

export type ConsentState = "pending" | "confirmed" | "unsubscribed";

// One mailing list, as declared in src/app/lists.ts.
export type ListDecl = { name: string; label: string; description: string };

export type ConsentEvent =
  | { kind: "request" } // the form, "Subscribe again", an admin adding an address: asks for a confirmation mail
  | { kind: "confirm-press"; tokenValid: boolean } // the Confirm button on the confirm page (valid = known, unexpired, still pending)
  | { kind: "own-choice"; subscribe: boolean } // a signed-in user ticking or unticking the list
  | { kind: "unsubscribe" };

export type ConsentFacts = {
  verifiedUser?: boolean; // the choice comes from a signed-in user whose email is verified and is this address
  mailedRecently?: boolean; // a confirmation mail for this address and list went out in the last ten minutes
  ceilingHit?: boolean; // the app-wide hourly ceiling on confirmation mails is reached
};

// `state` is what the row holds afterwards (null: no row, and none is written); `mail` is whether a confirmation mail goes out.
export type ConsentNext = { state: ConsentState | null; mail: boolean };

export function nextConsent(current: ConsentState | null, event: ConsentEvent, facts: ConsentFacts = {}): ConsentNext {
  const same: ConsentNext = { state: current, mail: false };
  switch (event.kind) {
    case "request":
      // Already confirmed: nothing changes and nothing is sent, so a stranger typing the address learns nothing and causes nothing.
      if (current === "confirmed") return same;
      if (facts.mailedRecently || facts.ceilingHit) return same;
      return { state: "pending", mail: true };
    case "confirm-press":
      return current === "pending" && event.tokenValid ? { state: "confirmed", mail: false } : same;
    case "own-choice":
      if (!facts.verifiedUser) return same;
      if (event.subscribe) return { state: "confirmed", mail: false };
      return current === null ? same : { state: "unsubscribed", mail: false };
    case "unsubscribe":
      return current === null ? same : { state: "unsubscribed", mail: false };
  }
}

// Fail closed: anything but "confirmed" (a missing row, pending, unsubscribed, a value nobody expected) may not receive marketing mail.
export const mayReceive = (state: unknown): boolean => state === "confirmed";
