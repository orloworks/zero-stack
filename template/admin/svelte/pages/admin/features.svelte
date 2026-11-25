<script lang="ts">
  import { useRouter } from "@void/svelte";
  import { type ActionState, runAction } from "../../src/lib/admin-action";
  import { SAVED } from "../../src/lib/admin-display";
  import type { Props } from "./features.server";

  let { features, loadError }: Props = $props();
  const router = useRouter();

  const OPTIONS = [
    { value: "on", label: "On", hint: "Everyone, except users set to off" },
    { value: "off", label: "Off", hint: "No one, except users set to on" },
    { value: "kill", label: "Kill switch", hint: "No one. User settings are ignored." },
  ] as const;

  // svelte-ignore state_referenced_locally
  let choice = $state<Record<string, string>>(Object.fromEntries(features.map((f) => [f.name, f.state])));
  let results = $state<Record<string, ActionState>>({});
  const pending = (name: string) => results[name]?.status === "pending";
  const saved = (name: string) => results[name]?.status === "done" || results[name]?.status === "done-unaudited";
  const failure = (name: string) => {
    const r = results[name];
    return r?.status === "error" ? r.message : "";
  };

  async function save(e: SubmitEvent, name: string) {
    e.preventDefault();
    const out = await runAction(
      (s) => { results[name] = s; },
      () => fetch(`/api/admin/features/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: choice[name] }) }),
      "Couldn't save the feature.",
    );
    if (out.status !== "error") router.refresh();
  }
</script>

<h1 tabindex="-1">Features</h1>

{#if loadError}
  <p role="alert">Couldn't load features. <a href="/admin/features">Retry</a></p>
{:else if features.length === 0}
  <p>Nothing declared yet. Add features in <code>src/app/features.ts</code>.</p>
{:else}
  <p class="hint">Each feature is saved on its own. A kill switch beats every user's setting.</p>
  {#each features as f (f.name)}
    <section aria-labelledby={`${f.name}-title`}>
      <form onsubmit={(e) => save(e, f.name)}>
        <fieldset>
          <legend id={`${f.name}-title`}>{f.name}</legend>
          {#each OPTIONS as o (o.value)}
            <label class="radio">
              <input id={`${f.name}-${o.value}`} type="radio" name={f.name} value={o.value} bind:group={choice[f.name]} aria-describedby={`${f.name}-${o.value}-hint`} />
              {o.label}
              <span id={`${f.name}-${o.value}-hint`} class="hint">{o.hint}</span>
            </label>
          {/each}
        </fieldset>
        <p><button type="submit" aria-label={`Save ${f.name}`} disabled={pending(f.name)}>{pending(f.name) ? "Saving…" : "Save"}</button></p>
        {#if saved(f.name)}<p role="status">{SAVED}</p>{/if}
        {#if failure(f.name)}<p role="alert">{failure(f.name)}</p>{/if}
      </form>
    </section>
  {/each}
{/if}
