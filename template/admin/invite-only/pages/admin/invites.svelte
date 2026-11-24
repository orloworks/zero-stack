<script lang="ts">
  import { useRouter } from "@void/svelte";
  import { type ActionState, runAction, UNAUDITED_WARNING } from "../../src/lib/admin-action";
  import { type InviteKind, parseInvite, previewDomain } from "../../src/lib/invite-entry";
  import type { Props } from "./invites.server";

  let { prefill, secret, invites, loadError }: Props = $props();
  const router = useRouter();

  let kind = $state<InviteKind>("email");
  // svelte-ignore state_referenced_locally
  let value = $state(prefill);
  let touched = $state(false);
  let add = $state<ActionState>({ status: "idle" });
  let row = $state<ActionState>({ status: "idle" });
  let busy = $state("");
  // What the server confirmed, shown as it said it (D6): the success line and the notes after a revoke.
  let said = $state({ message: "", notes: [] as string[] });

  const parsed = $derived(parseInvite(kind, value));
  const error = $derived(touched && "error" in parsed ? parsed.error : "");
  const pending = (s: ActionState) => s.status === "pending";
  const date = (d: Date) => d.toISOString().slice(0, 10);

  // The server's reply, kept for the message; the helper only needs the Response.
  const post = (url: string, body?: object) => async () => {
    const res = await fetch(url, { method: "POST", ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    said = (await res.clone().json().catch(() => ({}))) as typeof said;
    return res;
  };

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    touched = true;
    if ("error" in parsed) return;
    said = { message: "", notes: [] };
    row = { status: "idle" };
    if ((await runAction((s) => (add = s), post("/api/admin/invites", { kind, value }), "Couldn't add the invite.")).status !== "error") {
      value = "";
      touched = false;
      router.refresh();
    }
  }
  async function act(id: string, path: string, fallback: string) {
    busy = id;
    said = { message: "", notes: [] };
    add = { status: "idle" };
    const out = await runAction((s) => (row = s), post(`/api/admin/invites/${id}/${path}`), fallback);
    busy = "";
    if (out.status !== "error") router.refresh();
  }
</script>

<h1 tabindex="-1">Invites</h1>

<section aria-labelledby="add-title">
  <h2 id="add-title">Invite someone</h2>
  <form onsubmit={submit} novalidate>
    <fieldset>
      <legend>Invite</legend>
      <label class="choice"><input id="kind-email" type="radio" name="kind" value="email" bind:group={kind} onchange={() => (add = { status: "idle" })} /> Exact email</label>
      <label class="choice"><input id="kind-domain" type="radio" name="kind" value="domain" bind:group={kind} onchange={() => (add = { status: "idle" })} /> Whole domain</label>
    </fieldset>
    <label for="invite-value">{kind === "domain" ? "Domain" : "Email address"}</label>
    <input
      id="invite-value"
      type={kind === "domain" ? "text" : "email"}
      name="value"
      bind:value
      onblur={() => (touched = true)}
      autocomplete="off"
      placeholder={kind === "domain" ? "example.com" : "name@example.com"}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? "invite-error" : kind === "domain" ? "invite-preview" : undefined}
    />
    {#if error}<p id="invite-error" role="alert">{error}</p>{/if}
    {#if kind === "domain" && !error && "entry" in parsed}<p id="invite-preview" class="hint">{previewDomain(parsed.entry)}</p>{/if}
    <p><button type="submit" disabled={pending(add)}>{pending(add) ? "Inviting…" : "Invite"}</button></p>
  </form>
  {#if add.status === "done" || add.status === "done-unaudited"}<p role="status">{said.message}</p>{/if}
  {#if add.status === "done-unaudited"}<p role="alert">{UNAUDITED_WARNING}</p>{/if}
  {#if add.status === "error"}<p role="alert">{add.message}</p>{/if}
</section>

{#if loadError}
  <p role="alert">Couldn't load invites. <a href="/admin/invites">Retry</a></p>
{:else}
  <section aria-labelledby="added-title">
    <h2 id="added-title">Added here</h2>
    {#if invites.length === 0}
      <p>Invites you add here appear below.</p>
    {:else}
      <table>
        <caption>Invites added here, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Invite</th>
            <th scope="col" class="wide">Added</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {#each invites as i (i.id)}
            <tr>
              <td>{i.entry}{#if i.entry.startsWith("@")}<span class="hint"> (anyone at this domain)</span>{/if}</td>
              <td class="wide"><time datetime={i.createdAt.toISOString()}>{date(i.createdAt)}</time>{i.addedBy ? ` by ${i.addedBy}` : ""}{#if i.lastSentAt}<span class="hint"> · email requested {date(i.lastSentAt)}</span>{/if}</td>
              <td>
                {#if !i.entry.startsWith("@")}
                  <button type="button" aria-label={`Send invite email to ${i.entry}`} onclick={() => act(i.id, "send", "Couldn't request the invite email.")} disabled={pending(row)}>
                    {busy === i.id && pending(row) ? "Sending…" : "Send invite"}
                  </button>
                {/if}
                <button type="button" aria-label={`Revoke ${i.entry}`} onclick={() => act(i.id, "revoke", "Couldn't remove the invite.")} disabled={pending(row)}>
                  {busy === i.id && pending(row) ? "Revoking…" : "Revoke"}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if row.status === "done" || row.status === "done-unaudited"}
      <p role="status">{said.message}</p>
      {#each said.notes as note (note)}<p role="status">{note}</p>{/each}
    {/if}
    {#if row.status === "done-unaudited"}<p role="alert">{UNAUDITED_WARNING}</p>{/if}
    {#if row.status === "error"}<p role="alert">{row.message}</p>{/if}
  </section>

  <section aria-labelledby="secret-title">
    <h2 id="secret-title">From the SIGNUP_ALLOWLIST secret (edit the secret to change)</h2>
    {#if secret.length === 0}
      <p>The secret is empty.</p>
    {:else}
      <ul>
        {#each secret as e (e)}<li>{e}</li>{/each}
      </ul>
    {/if}
  </section>
{/if}
