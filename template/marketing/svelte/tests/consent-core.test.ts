import { expect, it } from "vite-plus/test";
import { type ConsentEvent, type ConsentFacts, type ConsentState, mayReceive, nextConsent } from "../src/lib/consent-core";

// The pure rules, no database: a table over state, event and facts, and the one property the consent record rests on.
type Row = [string, ConsentState | null, ConsentEvent, ConsentFacts, ConsentState | null, boolean];
const request: ConsentEvent = { kind: "request" };
const press = (tokenValid: boolean): ConsentEvent => ({ kind: "confirm-press", tokenValid });
const choice = (subscribe: boolean): ConsentEvent => ({ kind: "own-choice", subscribe });
const leave: ConsentEvent = { kind: "unsubscribe" };

const TABLE: Row[] = [
  // a request asks for a confirmation mail, never for consent itself
  ["a new address is pending and mailed", null, request, {}, "pending", true],
  ["a pending address is mailed again", "pending", request, {}, "pending", true],
  ["an unsubscribed address is pending again and mailed", "unsubscribed", request, {}, "pending", true],
  ["a confirmed address changes nothing and is not mailed", "confirmed", request, {}, "confirmed", false],
  ["a mail inside ten minutes changes nothing", "pending", request, { mailedRecently: true }, "pending", false],
  ["a new address inside the hourly ceiling gets no row", null, request, { ceilingHit: true }, null, false],
  ["an unsubscribed address stays unsubscribed under the ceiling", "unsubscribed", request, { ceilingHit: true }, "unsubscribed", false],
  ["a verified user's facts do not turn a request into consent", null, request, { verifiedUser: true }, "pending", true],
  // only a Confirm press with a valid token confirms
  ["a valid Confirm press confirms a pending row", "pending", press(true), {}, "confirmed", false],
  ["an invalid or expired token confirms nothing", "pending", press(false), {}, "pending", false],
  ["a Confirm press on no row does nothing", null, press(true), {}, null, false],
  ["a Confirm press on an unsubscribed row does nothing", "unsubscribed", press(true), {}, "unsubscribed", false],
  ["a Confirm press on a confirmed row keeps it", "confirmed", press(true), {}, "confirmed", false],
  // a verified user's own choice
  ["a verified user's tick confirms", null, choice(true), { verifiedUser: true }, "confirmed", false],
  ["an unverified user's tick does nothing", null, choice(true), {}, null, false],
  ["an unverified user's tick does not touch a pending row", "pending", choice(true), { verifiedUser: false }, "pending", false],
  ["a verified user's untick unsubscribes", "confirmed", choice(false), { verifiedUser: true }, "unsubscribed", false],
  ["an untick with no row writes nothing", null, choice(false), { verifiedUser: true }, null, false],
  ["an unverified user's untick does nothing", "confirmed", choice(false), {}, "confirmed", false],
  // leaving
  ["unsubscribe ends a confirmed row", "confirmed", leave, {}, "unsubscribed", false],
  ["unsubscribe ends a pending row", "pending", leave, {}, "unsubscribed", false],
  ["unsubscribe is repeatable", "unsubscribed", leave, {}, "unsubscribed", false],
  ["unsubscribe with no row writes nothing", null, leave, {}, null, false],
];

it.each(TABLE)("%s", (_name, current, event, facts, state, mail) => {
  expect(nextConsent(current, event, facts)).toEqual({ state, mail });
});

it("nothing reaches confirmed without a Confirm press or a verified user's own choice (every state, event and facts)", () => {
  const states: (ConsentState | null)[] = [null, "pending", "confirmed", "unsubscribed"];
  const events: ConsentEvent[] = [request, press(true), press(false), choice(true), choice(false), leave];
  const bools = [false, true];
  let checked = 0;
  for (const current of states)
    for (const event of events)
      for (const verifiedUser of bools)
        for (const mailedRecently of bools)
          for (const ceilingHit of bools) {
            const facts = { verifiedUser, mailedRecently, ceilingHit };
            const next = nextConsent(current, event, facts);
            checked++;
            if (next.state === "confirmed" && current !== "confirmed") {
              const pressed = event.kind === "confirm-press" && event.tokenValid && current === "pending";
              const own = event.kind === "own-choice" && event.subscribe && verifiedUser;
              expect([current, event, facts, pressed || own]).toEqual([current, event, facts, true]);
            }
            // A mail goes only for a request, and only to a pending row.
            if (next.mail) expect([event.kind, next.state]).toEqual(["request", "pending"]);
            // A confirmed row is never mailed or changed by a request.
            if (current === "confirmed" && event.kind === "request") expect(next).toEqual({ state: "confirmed", mail: false });
          }
  expect(checked).toBe(4 * 6 * 8);
});

it("only confirmed may receive; a missing row, any other state and anything unexpected fail closed", () => {
  expect(mayReceive("confirmed")).toBe(true);
  for (const s of [null, undefined, "pending", "unsubscribed", "Confirmed", "", 1, {}]) expect(mayReceive(s)).toBe(false);
});
