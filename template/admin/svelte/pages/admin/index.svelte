<script lang="ts">
  import { onMount } from "svelte";
  import { UNAUDITED_WARNING } from "../../src/lib/admin-action";
  import type { Props } from "./index.server";

  let { users, total, q, page, pageSize, deleted, unaudited, loadError }: Props = $props();

  let heading = $state<HTMLElement>();
  // After a delete's redirect, focus moves to the heading.
  onMount(() => deleted && heading?.focus());

  const href = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return s ? `/admin?${s}` : "/admin";
  };
  const detail = (id: string) => {
    const s = href(page).split("?")[1];
    return `/admin/users/${id}${s ? `?${s}` : ""}`;
  };
  const date = (d: Date) => d.toISOString().slice(0, 10);
  const from = $derived((page - 1) * pageSize + 1);
  const to = $derived(Math.min(page * pageSize, total));
</script>

<h1 tabindex="-1" bind:this={heading}>Users</h1>
{#if deleted}
  <p role="status">Deleted {deleted} and their files.</p>
  {#if unaudited}<p role="alert">{UNAUDITED_WARNING}</p>{/if}
{/if}

<form method="get" action="/admin" role="search">
  <label for="q">Search email or name</label>
  <!-- svelte-ignore a11y_autofocus -->
  <input id="q" type="search" name="q" value={q} autocomplete="off" autofocus />
  <button type="submit">Search</button>
</form>

{#if loadError}
  <p role="alert">Couldn't load users. <a href={href(page)}>Retry</a></p>
{:else if !q && total <= 1}
  <p>Just you so far.</p>
{:else if users.length === 0}
  <p>{q ? `No account for ${q}.` : "No users on this page."}</p>
{:else}
  <table>
    <caption>Users, newest first</caption>
    <thead>
      <tr>
        <th scope="col">Email</th>
        <th scope="col" class="wide">Name</th>
        <th scope="col">Status</th>
        <th scope="col" class="wide">Signed up</th>
        <th scope="col" class="wide">Last sign-in</th>
      </tr>
    </thead>
    <tbody>
      {#each users as u (u.id)}
        <tr>
          <td><a href={detail(u.id)}>{u.email}</a></td>
          <td class="wide">{u.name}</td>
          <td class={`status-${u.status.word.toLowerCase()}`}>{u.status.word}</td>
          <td class="wide"><time datetime={u.createdAt.toISOString()}>{date(u.createdAt)}</time></td>
          <td class="wide">{#if u.lastSignInAt}<time datetime={u.lastSignInAt.toISOString()}>{date(u.lastSignInAt)}</time>{:else}Never{/if}</td>
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
