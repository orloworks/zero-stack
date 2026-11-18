// The one owner of the Turnstile widget: script load, render, expiry, load failure and dispose.
// onToken gets the token when one is issued and null when it is gone (expiry, reset, widget error).
type Widget = { render(el: HTMLElement, o: Record<string, unknown>): string; reset(id: string): void; remove(id: string): void };
declare global {
  interface Window { turnstile?: Widget }
}
export type Turnstile = { token(): string | null; reset(): void; dispose(): void };

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | undefined;

function load(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loading = undefined; reject(new Error("turnstile script failed to load")); };
    document.head.appendChild(s);
  });
  return loading;
}

export function mountTurnstile(el: HTMLElement, { onToken, onError }: { onToken: (t: string | null) => void; onError: () => void }): Turnstile {
  let token: string | null = null;
  let id: string | undefined;
  let disposed = false;
  const set = (t: string | null) => { token = t; onToken(t); };
  load().then(async () => {
    const { env } = await import("void/env");
    if (disposed) return;
    id = window.turnstile!.render(el, {
      sitekey: env.VITE_TURNSTILE_SITE_KEY,
      callback: (t: string) => !disposed && set(t),
      "expired-callback": () => !disposed && set(null),
      "error-callback": () => { if (disposed) return; set(null); onError(); },
    });
  }).catch(() => { if (!disposed) onError(); });
  return {
    token: () => token,
    reset() {
      if (disposed) return;
      set(null);
      if (id !== undefined) window.turnstile?.reset(id);
    },
    dispose() {
      disposed = true;
      token = null;
      if (id !== undefined) window.turnstile?.remove(id);
      id = undefined;
    },
  };
}
