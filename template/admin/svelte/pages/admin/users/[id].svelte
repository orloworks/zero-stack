<script lang="ts">
  import { useRouter } from "@void/svelte";
  import { auth } from "void/client";
  import { adminAuth } from "../../../src/lib/admin-client";
  import { type ActionState, runAction, UNAUDITED_WARNING } from "../../../src/lib/admin-action";
  import { SAVED } from "../../../src/lib/admin-display";
  import type { Props } from "./[id].server";

  let { user, isMe, isAdmin, kind, status, sessions, onboarding, features, back }: Props = $props();
  const router = useRouter();

  const idle: ActionState = { status: "idle" };
  let unban = $state<ActionState>(idle);
  let link = $state<ActionState>(idle);
  let sessionsOne = $state<ActionState>(idle);
  let sessionsAll = $state<ActionState>(idle);
  let ban = $state<ActionState>(idle);
  let del = $state<ActionState>(idle);
  let revoking = $state("");
  let revokedCount = $state(0);
  let reason = $state("");
  let typed = $state("");

  // svelte-ignore state_referenced_locally
  let choice = $state<Record<string, string>>(Object.fromEntries(features.map((f) => [f.name, f.override])));
  let overrides = $state<Record<string, ActionState>>({});
  const overridePending = (name: string) => overrides[name]?.status === "pending";
  const overrideSaved = (name: string) => overrides[name]?.status === "done" || overrides[name]?.status === "done-unaudited";
  const overrideFailure = (name: string) => {
    const r = overrides[name];
    return r?.status === "error" ? r.message : "";
  };
  async function saveOverride(e: SubmitEvent, name: string) {
    e.preventDefault();
    const out = await runAction(
      (s) => { overrides[name] = s; },
      () => fetch(`/api/admin/users/${user.id}/features/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: choice[name] }) }),
      "Couldn't save the override.",
    );
    if (out.status !== "error") refresh();
  }

  const pending = (s: ActionState) => s.status === "pending";
  const refresh = () => router.refresh();
  const others = $derived(sessions.filter((s) => !s.current));
  const day = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  async function doUnban() {
    if ((await runAction((s) => (unban = s), () => adminAuth.admin.unbanUser({ userId: user.id }))).status !== "error") refresh();
  }
  async function doBan(e: SubmitEvent) {
    e.preventDefault();
    if ((await runAction((s) => (ban = s), () => adminAuth.admin.banUser({ userId: user.id, ...(reason.trim() && { banReason: reason.trim() }) }))).status !== "error") {
      reason = "";
      refresh();
    }
  }
  async function sendLink() {
    await runAction((s) => (link = s), () => fetch(`/api/admin/users/${user.id}/send-link`, { method: "POST" }), "Couldn't request the link.");
  }
  async function revokeOne(id: string) {
    revoking = id;
    const out = await runAction((s) => (sessionsOne = s), () => fetch(`/api/admin/users/${user.id}/sessions/${id}/revoke`, { method: "POST" }), "Couldn't revoke the session.");
    revoking = "";
    if (out.status !== "error") refresh();
  }
  async function revokeAll() {
    const n = isMe ? others.length : sessions.length;
    // Revoking your own sessions through the admin call would end this one too, so "other sessions" is the account call.
    const out = await runAction((s) => (sessionsAll = s), () => (isMe ? auth.revokeOtherSessions() : adminAuth.admin.revokeUserSessions({ userId: user.id })));
    revokedCount = n;
    if (out.status !== "error") refresh();
  }
  async function doDelete(e: SubmitEvent) {
    e.preventDefault();
    const out = await runAction((s) => (del = s), () => adminAuth.admin.removeUser({ userId: user.id }), "Couldn't delete the user.");
    if (out.status !== "error") location.href = `/admin?deleted=${encodeURIComponent(user.email)}${out.status === "done-unaudited" ? "&unaudited=1" : ""}`;
  }
</script>

<p><a href={back}>Back to users</a></p>
<h1 tabindex="-1">{user.email}</h1>
<p>{user.name}</p>
<p id="status" class={`status-${status.word.toLowerCase()}`}>{status.line}</p>

<section aria-labelledby="fix-title">
  <h2 id="fix-title">{user.banned ? "Blocked" : kind === "set-password" ? "Set password" : "Password"}</h2>
  {#if user.banned}
    <button type="button" onclick={doUnban} disabled={pending(unban)}>{pending(unban) ? "Unbanning…" : "Unban"}</button>
  {:else}
    <button type="button" onclick={sendLink} disabled={pending(link)}>{pending(link) ? "Sending…" : kind === "set-password" ? "Send set-password link" : "Send reset link"}</button>
  {/if}
  {#if unban.status === "done" || unban.status === "done-unaudited"}<p role="status">Unbanned {user.email}. They can sign in again.</p>{/if}
  {#if unban.status === "done-unaudited"}<p role="alert">{UNAUDITED_WARNING}</p>{/if}
  {#if unban.status === "error"}<p role="alert">{unban.message}</p>{/if}
  {#if link.status === "done" || link.status === "done-unaudited"}<p role="status">{kind === "set-password" ? "Set-password" : "Reset"} link requested for {user.email}.</p>{/if}
  {#if link.status === "done-unaudited"}<p role="alert">{UNAUDITED_WARNING}</p>{/if}
  {#if link.status === "error"}<p role="alert">{link.message}</p>{/if}
</section>

<section aria-labelledby="sessions-title">
  <h2 id="sessions-title">Sessions</h2>
  {#if sessions.length === 0}
    <p>No active sessions.</p>
  {:else}
    <table>
      <caption>Active sessions</caption>
      <thead>
        <tr>
          <th scope="col">Device</th>
          <th scope="col">Signed in</th>
          <th scope="col">Expires</th>
          <th scope="col">Action</th>
        </tr>
      </thead>
      <tbody>
        {#each sessions as s (s.id)}
          <tr>
            <td>{s.device}</td>
            <td><time datetime={s.createdAt.toISOString()}>{day(s.createdAt)}</time></td>
            <td><time datetime={s.expiresAt.toISOString()}>{day(s.expiresAt)}</time></td>
            <td>
              {#if s.current}
                This device
              {:else}
                <button type="button" aria-label={`Revoke session on ${s.device}`} onclick={() => revokeOne(s.id)} disabled={pending(sessionsOne)}>
                  {revoking === s.id ? "Revoking…" : "Revoke"}
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if (isMe ? others.length : sessions.length) > 0}
      <p>
        <button type="button" onclick={revokeAll} disabled={pending(sessionsAll)}>
          {pending(sessionsAll) ? "Revoking…" : isMe ? "Revoke all other sessions" : "Revoke all sessions"}
        </button>
      </p>
    {/if}
  {/if}
  {#if sessionsOne.status === "done" || sessionsOne.status === "done-unaudited"}<p role="status">Session revoked.</p>{/if}
  {#if sessionsAll.status === "done" || sessionsAll.status === "done-unaudited"}<p role="status">{revokedCount} {revokedCount === 1 ? "session" : "sessions"} revoked. They're signed out.</p>{/if}
  {#if sessionsOne.status === "done-unaudited" || sessionsAll.status === "done-unaudited"}<p role="alert">{UNAUDITED_WARNING}</p>{/if}
  {#if sessionsOne.status === "error"}<p role="alert">{sessionsOne.message}</p>{/if}
  {#if sessionsAll.status === "error"}<p role="alert">{sessionsAll.message}</p>{/if}
</section>

{#if onboarding}
  <section aria-labelledby="onboarding-title">
    <h2 id="onboarding-title">{`Onboarding: ${onboarding.text}`}</h2>
    <ul>
      {#each onboarding.steps as s (s.label)}
        <li>{s.label}: {s.done ? "Done" : "Not yet"}{#if s.at}<span class="hint"> (<time datetime={s.at.toISOString()}>{s.at.toISOString().slice(0, 10)}</time>)</span>{/if}</li>
      {/each}
    </ul>
  </section>
{/if}

<section aria-labelledby="features-title">
  <h2 id="features-title">Feature overrides</h2>
  {#if features.length === 0}
    <p>Nothing declared yet. Add features in <code>src/app/features.ts</code>.</p>
  {:else}
    {#each features as f (f.name)}
      <form onsubmit={(e) => saveOverride(e, f.name)}>
        <label for={`override-${f.name}`}>{f.name}</label>
        <select id={`override-${f.name}`} name={f.name} bind:value={choice[f.name]} aria-describedby={`effective-${f.name}`}>
          <option value="default">Use global</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <button type="submit" aria-label={`Save ${f.name} for ${user.email}`} disabled={overridePending(f.name)}>{overridePending(f.name) ? "Saving…" : "Save"}</button>
        <p id={`effective-${f.name}`} class="hint">Effective: {f.effective}</p>
        {#if overrideSaved(f.name)}<p role="status">{SAVED}</p>{/if}
        {#if overrideFailure(f.name)}<p role="alert">{overrideFailure(f.name)}</p>{/if}
      </form>
    {/each}
  {/if}
</section>

<p><a href={`/admin/audit?user=${encodeURIComponent(user.email)}`}>View audit log</a></p>

<section class="danger-zone" aria-labelledby="danger-title">
  <h2 id="danger-title">Danger zone</h2>
  {#if isMe}
    <p>This is you. Use Account settings to delete your own account.</p>
  {:else}
    {#if !user.banned}
      <form onsubmit={doBan}>
        <label for="ban-reason">Reason (optional)</label>
        <input id="ban-reason" type="text" name="reason" bind:value={reason} maxlength="500" aria-describedby="ban-hint" autocomplete="off" />
        <p id="ban-hint" class="hint">Only admins see this.</p>
        {#if isAdmin}<p class="hint">Admin access comes from ADMIN_EMAILS. Banning only blocks their sign-in.</p>{/if}
        <p><button type="submit" aria-label={`Ban ${user.email}`} disabled={pending(ban)}>{pending(ban) ? "Banning…" : "Ban"}</button></p>
      </form>
    {/if}
    {#if ban.status === "done" || ban.status === "done-unaudited"}<p role="status">Banned {user.email}. Their sessions are ended.</p>{/if}
    {#if ban.status === "done-unaudited"}<p role="alert">{UNAUDITED_WARNING}</p>{/if}
    {#if ban.status === "error"}<p role="alert">{ban.message}</p>{/if}
    <form onsubmit={doDelete}>
      <p>Deletes {user.email}, their sessions and their uploaded files. This can't be undone.</p>
      <label for="delete-confirm">Type {user.email} to confirm</label>
      <input id="delete-confirm" type="text" name="confirm" bind:value={typed} autocomplete="off" aria-describedby={del.status === "error" ? "delete-error" : undefined} aria-invalid={del.status === "error" || undefined} />
      <p>
        <button type="submit" disabled={typed.trim().toLowerCase() !== user.email.toLowerCase() || pending(del)}>
          {pending(del) ? "Deleting…" : "Delete user permanently"}
        </button>
      </p>
      {#if del.status === "error"}<p id="delete-error" role="alert">{del.message}</p>{/if}
    </form>
  {/if}
</section>
