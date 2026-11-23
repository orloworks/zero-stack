<script lang="ts">
  import { Link, useRouter } from "@void/svelte";
  import type { Href } from "void/routes";
  import "./admin.css";

  let { children } = $props();

  const APP_NAME = "__APP_NAME__";
  // The nav is one array; later admin pages append to it.
  const NAV = [
    { href: "/admin", label: "Users" },
    { href: "/admin/audit", label: "Audit log" },
  ];

  // After a page change, focus moves to the page's heading (not on the first render).
  const router = useRouter();
  let first = true;
  $effect(() => {
    void router.path;
    if (first) return void (first = false);
    queueMicrotask(() => document.querySelector<HTMLElement>("main.admin h1")?.focus());
  });
</script>

<main class="admin">
  <header class="admin-bar">
    <strong>{APP_NAME} Admin</strong>
    <nav aria-label="Admin">
      <ul>
        {#each NAV as item (item.href)}
          <li><Link href={item.href as Href}>{item.label}</Link></li>
        {/each}
      </ul>
    </nav>
    <a href="/">Back to app</a>
  </header>
  {@render children()}
</main>
