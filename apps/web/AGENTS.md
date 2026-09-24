# apps/web agent rules

Root rules apply. This file is loaded for `apps/web` work; load the focused
reference below before changing the matching surface. Read [DESIGN.md](DESIGN.md)
only when making UI or visual decisions.

- **React hooks, queries, mutations, client/server boundaries, SSR:**
  [web runtime rules](../../docs/agents/web-runtime.md).
- **Colors, images, spacing, layout, tables, entity names, page shell:**
  [web UI contracts](../../docs/agents/web-ui.md).
- A hand-written `interface`/`type` for data that crosses a runtime boundary
  (an API response, persisted JSON, a Zod-validated row) is allowed only when
  no `z.object` schema exists for that exact shape — otherwise derive it with
  `z.infer`. A narrower subset of a schema is `Pick`/`Omit` of the inferred
  type, not a re-typed copy.

Use an affected browser E2E scenario when it observes the changed behavior.
Keep a focused UI or unit test for a distinct failure the browser scenario
cannot reasonably catch.

Verify browser work by reading, not by looking: `read_page`, `get_page_text`,
`read_console_messages`, and `javascript_tool` answer almost every question and
cost a few hundred tokens. A screenshot averages ~11k tokens — measured, they
are a third of everything the agent reads across a session, and context that
large is what makes each turn slower. Take one only when the question is
genuinely visual (layout, spacing, colour) or as a single final proof for the
user; never to confirm text, structure, or that a page loaded. Two preview-pane
traps: a hidden tab has `visibilityState: "hidden"` (rAF suspended, blank
below-the-fold screenshots, a fake "freeze") — verify with a tall viewport and a
fresh navigation; and a ref-click can fail to fire a React `onClick` (silent
no-op) where a coordinate click works.
