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
| `reports/`               | Dated measurements and audits; a snapshot, not current behavior.       |
| `runbooks/`              | Operational procedures that require current-environment checks.        |

Current behavior lives in code and maintained contracts. Historical experiment
tables removed during cleanup remain available in Git history.
