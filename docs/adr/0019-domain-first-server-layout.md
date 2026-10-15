# ADR 0019: Domain-first server layout

Status: Accepted; implemented.

Server code used to be grouped by technical layer — `server/repo/` (~650
files), `server/services/`, `server/operations/` — with one entity's code
spread across all three and a long tail of top-level files. Finding everything
that touches one entity meant name-prefix searches that also matched
neighbours (`product` vs `product-category`). The web client split the same
domains between `src/app/` and `src/features/` under different names.

## Decision

- **Domains.** `apps/web/src/server/domains/<entity>/` holds one manifest
  entity, named exactly by its kebab-case manifest name. Child rows live with
  their parent (meal preparations in `meal`, recipe sections in `recipe`, unit
  mappings in `product`, growing guides in `plant`); `planting` and
  `garden-entry` share `domains/garden/`. Cross-entity workflows are
  sibling feature folders in `domains/` (`purchase-import`, `purchase-agent`,
  `photo-import`, `calendar`, `usda-release`, `statement-import`,
  `household-contribution`, `mail`, `image-processing`, `garden`,
  `dashboard`, `recommendation`).
- **Generic capabilities.** Entity-agnostic capabilities live in
  `apps/web/src/server/generic/<capability>/` (merge, removal, relatedness,
  data-quality, problems, entity-report, entity-graph, embedding, search,
  collection, work-queue, field-explanation, suggestions, assessment,
  audit-log, activity, inheritance, entity-links, entity-timeline, shortcode,
  list, integrity).
- **Platform.** The remaining top level is a fixed allowlist: `db/` (with
  `db/helpers/`), `entity-kernel/`, `http/`, `operation-runtime/`,
  `workflows/`, `observability/`, `mcp/`, `ai/`, `clients/`, `errors/`,
  `generated/`, `lib/`, `testing/`, plus `db.ts`, `cf-env.ts`, and
  `worker-bindings.ts`.
- **Roles by path segment.** Inside a domain or capability the role is
  `repo`, `service`, or `operations`: a `<role>.ts` file (`repo.ts`,
  `service.ts`, `operations.server.ts`) when the role holds one module, a
  `<role>/` folder keeping the original file names when it holds more. Entity
  domain folders contain only role entries; feature-domain folders may also
  hold role-less workflow files. Tests sit beside their file.
  Existing `.server.ts` suffixes stay; nothing keys on them.
- **Layer direction.** `cubby/domain-layers` (oxlint) allows imports only to the
  same or a lower role — `operations` → `service` → `repo` → `db` — in any
  domain; `repo` never imports `ai/`; a service imports neither
  `db/schema` nor `db/helpers` (it reaches tables through a repo); platform and generic code never import a domain's `service`
  or `operations`. Role-less feature-domain files are not ranked yet
  (`docs/todos.md`). On the client, `ui/` imports neither `entity/` nor
  `features/`, and `entity/` does not import `features/`. Violations that
  existed when the rule landed are counted per file in
  `tools/oxlint/cubby/domain-layers-baseline.json`, which may only shrink.
- **Client.** `src/app/` and `src/features/` merged into
  `src/features/<domain>/` using the server's domain names; `src/entity/` is
  the generic entity platform (including `display/`, `fields/`, `model/`,
  `problems/`, `hooks/`, and the developer screens in `platform/`), `src/ui/`
  the shared kit. Client and server trees
  stay separate.
- **Naming and shape guards.** Under `apps/web/{src,tests,generator}`, TS/TSX
  files and all folders are kebab-case,
  except TanStack route files (their `$param` names are URL contract). No new
  `index.ts` re-export barrels in `domains/`, `generic/`, or `features/`
  (`cubby/no-domain-barrel`). `apps/web/tooling/layout.unit.test.ts` enforces
  kebab-case, the server top-level allowlist, entity role entries, and at most
  40 direct source files per folder (existing offenders baselined).
- `~/` stays the only import alias.

## Consequences

- Moved `createServerFn` files would change their server-function IDs, so the
  three that exist (`lib/auth-guard.ts`, `lib/build-metadata.ts`,
  `features/ai/server-functions/ai-smoke.ts`) kept their paths.
- Git history for moved files needs rename detection (`git log --follow`); the
  restructure's squash commit goes in `.git-blame-ignore-revs` right after it
  merges.
- Burn-down work (layer baseline, oversized files, remaining barrels, client
  boundary inversions) is tracked in `docs/todos.md`.
