# apps/web agent rules

Root rules apply. This file is loaded for `apps/web` work; load the focused
reference below before changing the matching surface. Read [DESIGN.md](DESIGN.md)
only when making UI or visual decisions.

- **React hooks, queries, mutations, client/server boundaries, SSR:**
  [web runtime rules](../../docs/agents/web-runtime.md).
- **Colors, images, spacing, layout, tables, entity names, page shell:**
  [web UI contracts](../../docs/agents/web-ui.md).

Run the narrowest affected web test tier; browser seams earn E2E only when lower
tiers cannot observe the failure.
