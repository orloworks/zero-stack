<script lang="ts">
  import { ago } from "../../src/lib/admin-display";
  import type { Props } from "./audit.server";

  let { entries, user, page, pageSize, total, loadError }: Props = $props();

  const href = (p: number) => {
    const params = new URLSearchParams();
    if (user) params.set("user", user);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return s ? `/admin/audit?${s}` : "/admin/audit";
  };
  const from = $derived((page - 1) * pageSize + 1);
  const to = $derived(Math.min(page * pageSize, total));
</script>

<h1 tabindex="-1">Audit log</h1>

<form method="get" action="/admin/audit" role="search">
  <label for="user">Filter by the affected user's email</label>
  <input id="user" type="search" name="user" value={user} autocomplete="off" />
  <button type="submit">Filter</button>
</form>

{#if loadError}
  <p role="alert">Couldn't load the audit log. <a href={href(page)}>Retry</a></p>
{:else if entries.length === 0}
  <p>{user ? `No changes for ${user}.` : "No changes yet."}</p>
{:else}
  <table>
    <caption>Changes admins made, newest first</caption>
    <thead>
      <tr>
        <th scope="col">When</th>
        <th scope="col">Change</th>
      </tr>
    </thead>
    <tbody>
      {#each entries as e (e.id)}
        <tr>
          <td><time datetime={e.createdAt.toISOString()} title={e.createdAt.toISOString()}>{ago(e.createdAt)}</time></td>
          <td>{e.text}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <nav class="paging" aria-label="Pages">
    <span>Showing {from}–{to} of {total}</span>
    {#if page > 1}<a href={href(page - 1)}>Newer</a>{/if}
    {#if to < total}<a href={href(page + 1)}>Older</a>{/if}
  </nav>
{/if}
