# Documentation

Developer documentation. The app's Documentation route renders only the
household guide in [`guide/`](guide/README.md); everything else here stays in
the repository.

## Where to start

- [Development](development.md) covers architecture, commands, testing,
  deployment, and the HTTP API.
- [Entities](entities.md) and [Application framework](application-framework/README.md)
  describe the compiled entity architecture.
- [Inventory audit](inventory-audit.md), [Garden](garden.md), and [Photos library
  deduplication](photo-library-dedup.md) explain household workflows.
- [CI](ci.md), [Infrastructure](infrastructure.md), and the operational
  runbooks cover operations. Check the relevant code and deployed
  state before following an operational procedure.
- [Work list](todos.md) is the active backlog. Items there are proposals until
  implementation evidence says otherwise.

## Document roles

| Folder                   | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `adr/`                   | Durable decisions and their reasoning; keep even after implementation. |
| `agents/`                | Current agent rules and validation contracts.                          |
| `application-framework/` | Entity framework design and ownership records.                         |
| `guide/`                 | Household-facing guide bundled into the app's Documentation route.     |
| `plans/`                 | Proposed or in-progress work; status at the top of each plan governs.  |
| `runbooks/`              | Operational procedures that require current-environment checks.        |

## Ownership and pruning

Keep each fact at one authoritative home. Executable declarations, manifests,
lockfiles and configuration own versions, command composition, rosters and
numeric settings; prose links to those sources and records the rationale or trap
they cannot explain. Maintained behavior docs own contracts, ADRs own decisions,
and the work list owns remaining work. A pointer names the condition for loading
its target instead of copying the rule.

Delete completed plans and dated reports after moving durable rationale to its
behavior owner and unresolved work to the backlog. Verify status against
implementation before removing active work. Git history is the archive; this
policy requires no new drift checks.
