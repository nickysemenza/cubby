# Documentation

The app's Documentation sidebar renders every Markdown file in this tree. The
file remains the source of truth; the app groups it by folder and links between
these pages stay within Documentation.

## Where to start

- [Terminology](terminology.md) defines the product and data vocabulary.
- [Inventory audit](inventory-audit.md), [Garden](garden.md), and [Photos library
  deduplication](photo-library-dedup.md) explain household workflows.
- [How values are determined](how-values-are-determined.md) is generated from
  entity field explanations. Edit its generator, not its output.
- [Entities](entities.md) and [Application framework](application-framework/README.md)
  describe the compiled entity architecture.
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
| `plans/`                 | Proposed or in-progress work; status at the top of each plan governs.  |
| `runbooks/`              | Operational procedures that require current-environment checks.        |

Current behavior lives in code and maintained contracts. Historical experiment
tables removed during cleanup remain available in Git history.
