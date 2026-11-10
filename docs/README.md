# Documentation

Developer documentation. The app's Documentation route renders only the
household guide in [`guide/`](guide/README.md); everything else here stays in
the repository.

## Where to start

- [Development](development.md) covers architecture, commands, testing,
  deployment, and the HTTP API.
- [Entities](entities.md) describes the compiled entity architecture,
  workflows, and relationship contracts.
- [Durable Jobs](jobs.md) owns background execution: lanes, waiting-on,
  fairness, retries, image processing leases, the queue watchdog and retention.
- [Terminology](guide/terminology.md) defines household and classification
  terms.
- [Inventory audit](inventory-audit.md), [Garden](garden.md), and [Photos library
  deduplication](photo-library-dedup.md) explain household workflows.
- [CI](ci.md), [Infrastructure](infrastructure.md), and the operational
  runbooks cover operations. Check the relevant code and deployed
  state before following an operational procedure.
- [Sentry triage](runbooks/sentry-triage.md) links to error views, GitHub-linked
  issues, Release Health, and ingestion statistics.
- [GitHub Issues](https://github.com/nickysemenza/cubby/issues) is the active backlog;
  [issue workflow](agents/issues.md) explains labels, Status and closing. Items
  are proposals until implementation evidence says otherwise.

## Document roles

| Folder                     | Purpose                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `adr/`                     | Decisions and their reasoning; superseded ones shrink to stubs. [Index](adr/README.md).                     |
| `agents/`                  | Cross-app agent rules and validation contracts.                                                             |
| `guide/`                   | Household-facing guide bundled into the app's Documentation route.                                          |
| `runbooks/`                | Operational procedures that require current-environment checks.                                             |
| `apps/*/docs/` (repo root) | Rules for one app only (web runtime and UI, Xcode MCP); that app's `AGENTS.md` names when to load each one. |

## Ownership and pruning

Docs describe the current contract. Keep contracts, invariants, ownership,
where code lives, commands, and traps that still bite. Leave out history: PR
and issue numbers, dates, "no longer", "retired", "previously", cutover steps,
test-coverage rationale, experiment write-ups and changelog lines. The PR body
and git history hold those. Link to code rather than restating it, and prefer
short, direct prose.

Keep each fact at one authoritative home. Executable declarations, manifests,
lockfiles and configuration own versions, command composition, rosters and
numeric settings; prose links to those sources and records the rationale or trap
they cannot explain. Maintained behavior docs own contracts, ADRs own decisions,
and GitHub Issues owns remaining work. A pointer names the condition for loading
its target instead of copying the rule.

When a change alters a contract, edit the contract in place in its owner in the
same change. Delete completed plans, dated reports and stale sections rather than
marking them; first move durable rationale to its behavior owner and unresolved
work to an issue. Verify status against implementation before removing active
work.

An ADR records one decision and its reasoning. When a later ADR supersedes it,
move any still-live policy to its behavior owner, repoint links to it, and shrink
the ADR to a stub: title, status, date, superseding ADR, a one-paragraph
decision, and a note that the full text is in git history.

Keep always-loaded `AGENTS.md` files as short contracts and conditional pointers.
Skill descriptions route tasks; their bodies own workflow steps. Put app-specific
rules in app references, and keep global preferences out of repository copies.
Use section anchors for large references so a narrow task does not require a
whole-file read; CI checks every relative link and anchor. Add a document only
for a distinct audience, behavior owner or loading branch; extend the existing
owner otherwise. File count alone is not a pruning criterion: merging
independent references can increase context loaded.

Mechanical rules belong in the existing formatter, linter or checks; prose
records judgment and rationale. Before adding a rule after an incident, check
whether an existing rule or unwired check already owns it. Fix that owner
instead of adding another reminder. Keep household guides as product content and
connector skill entry points as discovery paths.
