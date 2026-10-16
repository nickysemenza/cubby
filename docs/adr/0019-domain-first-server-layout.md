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
  and capability folders contain only role entries, feature domains
  included. Tests sit beside their file.
  Existing `.server.ts` suffixes stay; nothing keys on them.
- **Layer direction.** `cubby/domain-layers` (oxlint) allows imports only to the
  same or a lower role — `operations` → `service` → `repo` → `db` — in any
  domain. The entry points `http/`, `mcp/`, and `workflows/` import like
  `operations` but are imported as platform infrastructure
  (`workflows/runtime`, `http/request-context`). `ai/repo/` ranks as `repo`.
  `repo` never imports `ai/` except `ai/repo/` and `ai/policy/`: the model-free
  declarations (feature identities, prompt builders, field-suggest rules,
  catalog field rows and the AI refresh manifest) that repos read to stamp
  and check decision provenance. `ai/policy/` value-imports only itself and
  packages, so no repo reaches model code. A service value-imports nothing from `db/` but
  `db/freshness/`, and never imports `db/helpers` or a `db/*schema*` file,
  even for types; it reaches tables through a repo, and computed SQL lives
  in `db/computed/`. Other platform code and `generic/*` never import a
  domain's `service` or `operations`; where they must call one, the domain
  registers a callback at startup. On the client, `ui/` imports neither
  `entity/` nor `features/`, and `entity/` does not import `features/`. The
  rule has no baseline: the codebase is at zero violations.
- **Client.** `src/app/` and `src/features/` merged into
  `src/features/<domain>/` using the server's domain names; `src/entity/` is
  the generic entity platform (including `display/`, `fields/`, `model/`,
  `problems/`, `hooks/`, the entity-aware `table/`, `picker/`, `navigation/`,
  `preview/`, and `suggestions/`, and the developer screens in `platform/`);
  `src/ui/` is the entity-free kit. Per-entity slot fills (list columns,
  actions, renderers, detail sections) live in their `features/<domain>/`
  folder; `features/registry.tsx` composes them into the registry typed in
  `entity/feature-registry.ts`, and `installFeatures()` runs from the
  code-split `_authenticated` layout, the home route, and the command menu so
  the tables stay out of the Worker's first-request chunk. Client and server
  trees stay separate.
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
- Remaining burn-down work (oversized files, remaining barrels) is tracked in
  [GitHub Issues](https://github.com/nickysemenza/cubby/issues?q=is%3Aissue%20is%3Aopen%20label%3Aarea%3Atooling).
