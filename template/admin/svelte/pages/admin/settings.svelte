<script lang="ts">
  import { useRouter } from "@void/svelte";
  import { type ActionState, runAction } from "../../src/lib/admin-action";
  import { SAVED } from "../../src/lib/admin-display";
  import type { Props } from "./settings.server";

  let { settings, loadError }: Props = $props();
  const router = useRouter();

  // Each setting is its own form with its own Save, so the draft and the outcome are kept per key.
  // svelte-ignore state_referenced_locally
  let draft = $state<Record<string, string | number | boolean | null>>(Object.fromEntries(settings.map((s) => [s.key, s.value])));
  let results = $state<Record<string, ActionState>>({});
  const pending = (key: string) => results[key]?.status === "pending";
  const saved = (key: string) => results[key]?.status === "done" || results[key]?.status === "done-unaudited";
  const failure = (key: string) => {
    const r = results[key];
    return r?.status === "error" ? r.message : "";
  };

  async function save(e: SubmitEvent, key: string) {
    e.preventDefault();
    const out = await runAction(
      (s) => { results[key] = s; },
      () => fetch(`/api/admin/settings/${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: draft[key] }) }),
      "Couldn't save the setting.",
    );
    if (out.status !== "error") router.refresh();
  }

  async function reset(key: string, to: string | number | boolean) {
    const out = await runAction(
      (s) => { results[key] = s; },
      () => fetch(`/api/admin/settings/${encodeURIComponent(key)}`, { method: "DELETE" }),
      "Couldn't reset the setting.",
    );
    if (out.status !== "error") {
      draft[key] = to;
      router.refresh();
    }
  }
</script>

<h1 tabindex="-1">Settings</h1>

{#if loadError}
  <p role="alert">Couldn't load settings. <a href="/admin/settings">Retry</a></p>
{:else if settings.length === 0}
  <p>Nothing declared yet. Add settings in <code>src/app/settings.ts</code>.</p>
{:else}
  <p class="hint">Each setting is saved on its own. Settings are plain text that every admin sees: never put a secret here.</p>
  {#each settings as s (s.key)}
    <section aria-labelledby={`${s.key}-title`}>
      <form novalidate onsubmit={(e) => save(e, s.key)}>
        <h2 id={`${s.key}-title`}>{s.key}</h2>
        <p id={`${s.key}-desc`} class="hint">{s.description}</p>
        {#if s.type === "boolean"}
          <p><label><input id={s.key} type="checkbox" bind:checked={draft[s.key] as boolean} aria-describedby={`${s.key}-desc`} /> {s.key} on</label></p>
        {:else if s.type === "choice"}
          <p>
            <label for={s.key}>{s.key} value</label>
            <select id={s.key} bind:value={draft[s.key]} aria-describedby={`${s.key}-desc`}>
              {#each s.values as v (v)}<option value={v}>{v}</option>{/each}
            </select>
          </p>
        {:else if s.type === "number"}
          <p>
            <label for={s.key}>{s.key} value</label>
            <input id={s.key} type="number" min={s.min ?? undefined} max={s.max ?? undefined} bind:value={draft[s.key]} aria-invalid={failure(s.key) ? "true" : undefined} aria-describedby={`${s.key}-desc${failure(s.key) ? ` ${s.key}-error` : ""}`} />
          </p>
        {:else}
          <p>
            <label for={s.key}>{s.key} value</label>
            <input id={s.key} type="text" bind:value={draft[s.key]} aria-invalid={failure(s.key) ? "true" : undefined} aria-describedby={`${s.key}-desc${failure(s.key) ? ` ${s.key}-error` : ""}`} />
          </p>
        {/if}
        <p class="hint">Default: {s.defaultText}</p>
        {#if s.invalid}<p class="hint">Stored value is invalid; using the default.</p>{/if}
        <p>
          <button type="submit" aria-label={`Save ${s.key}`} disabled={pending(s.key)}>{pending(s.key) ? "Saving…" : "Save"}</button>
          {#if s.canReset}
            <button type="button" aria-label={`Reset ${s.key} to default`} disabled={pending(s.key)} onclick={() => reset(s.key, s.defaultValue)}>Reset to default</button>
          {/if}
        </p>
        {#if saved(s.key)}<p role="status">{SAVED}</p>{/if}
        {#if failure(s.key)}<p id={`${s.key}-error`} role="alert">{failure(s.key)}</p>{/if}
      </form>
    </section>
  {/each}
{/if}
