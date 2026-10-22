# Documentation

Developer documentation. The app's Documentation route renders only the
household guide in [`guide/`](guide/README.md); everything else here stays in
the repository.

## Where to start

- [Development](development.md) covers architecture, commands, testing,
  deployment, and the HTTP API.
- [Entities](entities.md) describes the compiled entity architecture,
  workflows, and relationship contracts.
- [Household taxonomy vocabulary](../GLOSSARY.md) defines classification terms.
- [Inventory audit](inventory-audit.md), [Garden](garden.md), and [Photos library
  deduplication](photo-library-dedup.md) explain household workflows.
- [CI](ci.md), [Infrastructure](infrastructure.md), and the operational
  runbooks cover operations. Check the relevant code and deployed
  state before following an operational procedure.
- [Sentry triage](runbooks/sentry-triage.md) links to error views, GitHub-linked
  issues, Release Health, and ingestion statistics.
- [GitHub Issues](https://github.com/nickysemenza/cubby/issues) is the active backlog;
  [issue workflow](agents/issues.md) explains selection and updates. Items are proposals until
  implementation evidence says otherwise.

## Document roles

| Folder                     | Purpose                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `adr/`                     | Durable decisions and their reasoning; keep even after implementation. [Index](adr/README.md).              |
| `agents/`                  | Cross-app agent rules and validation contracts.                                                             |
| `guide/`                   | Household-facing guide bundled into the app's Documentation route.                                          |
| `runbooks/`                | Operational procedures that require current-environment checks.                                             |
| `apps/*/docs/` (repo root) | Rules for one app only (web runtime and UI, Xcode MCP); that app's `AGENTS.md` names when to load each one. |

## Ownership and pruning

Keep each fact at one authoritative home. Executable declarations, manifests,
lockfiles and configuration own versions, command composition, rosters and
numeric settings; prose links to those sources and records the rationale or trap
they cannot explain. Maintained behavior docs own contracts, ADRs own decisions,
and GitHub Issues owns remaining work. A pointer names the condition for loading
its target instead of copying the rule.

Delete completed plans and dated reports after moving durable rationale to its
behavior owner and unresolved work to the backlog. Verify status against
implementation before removing active work. Git history is the archive; this
policy requires no new drift checks.

Keep always-loaded `AGENTS.md` files as short contracts and conditional pointers.
Skill descriptions route tasks; their bodies own workflow steps. Put app-specific
rules in app references, and keep global preferences out of repository copies.
Use section anchors for large references so a narrow task does not require a
whole-file read. Add a document only for a distinct audience, behavior owner or
loading branch; extend the existing owner otherwise. File count alone is not a
pruning criterion: merging independent references can increase context loaded.

Mechanical rules belong in the existing formatter, linter or checks; prose
records judgment and rationale. Before adding a rule after an incident, check
whether an existing rule or unwired check already owns it. Fix that owner
instead of adding another reminder. Keep ADRs as decision history, household
guides as product content, and connector skill entry points as discovery paths.
