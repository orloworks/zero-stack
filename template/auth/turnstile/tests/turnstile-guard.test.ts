import { expect, it } from "vite-plus/test";
import { turnstileSecret } from "../src/turnstile-guard";

const TEST = "1x0000000000000000000000000000000AA";

it("a test secret is allowed on localhost", () => {
  expect(turnstileSecret(TEST, "http://localhost:5173")).toBe(TEST);
});

it("a test secret is rejected for any other URL, or none", () => {
  for (const url of ["https://app.example.com", "http://localhost.evil.com", "", undefined])
    expect(() => turnstileSecret(TEST, url)).toThrow(/test secret/);
});

it("a real secret is allowed anywhere; an absent one stays empty so the plugin fails closed", () => {
  expect(turnstileSecret("0x4AAAAAAAreal", "https://app.example.com")).toBe("0x4AAAAAAAreal");
  expect(turnstileSecret(undefined, "https://app.example.com")).toBe("");
});
