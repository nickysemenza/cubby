# ADR 0009: Load one entity's generated model per client route

Status: Accepted.

## Context

The generator emitted each consumer's view of the entity declarations as one
all-entities module: the field models (`entity-field-model.gen.ts`), the
summary (`entity-summary.gen.ts`), the manifest descriptors
(`entity-manifest-data.gen.ts`) and the inspector metadata
(`entity-inspector.gen.ts`). Browser code imported these maps directly, and
because the app shell and most generic components did, every entity's model
loaded with the first page. The detail and list UI was gathered the same way:
four global registries (`detail-slots`, `list-slots`, `section-actions`,
`collection-actions`) mapped every entity to its slots and verbs behind
`lazy()` boundaries, and `report-slot.tsx` and `detail-action-bar.tsx` imported
each other through them.

## Decision

- The generator emits one model module per entity
  (`@cubby/schemas/entity-models/<entity>`: field model, summary and manifest
  descriptor), one inspector module per entity, and a slim always-loaded
  index (`@cubby/schemas/entity-index`: names, icons, wayfinding, capability
  traits, relation keys and targets, the list's opening views and filter).
  Saved views have their own module (`@cubby/schemas/entity-saved-views`) for
  the view and problem registries.
- The all-entities aggregates are re-collected from the per-entity modules
  and stay server-side. `cubby/no-client-entity-aggregate` rejects a value
  import of them from `apps/web/src` outside server code; `import type` stays
  allowed.
- Each routed entity gets a generated client module per surface
  (`apps/web/src/entity/generated/clients/<entity>.{detail,list}.gen.ts`). It
  registers the entity's model in `~/entity/entity-model`, starts loading the
  models its relation sections render, and binds the entity's typed hook
  module (`apps/web/src/entity/clients/<entity>.{detail,list}.tsx`): detail
  slots, header actions, section and collection verbs, or list slots. The
  generator refuses a declared slot without its hook module, and
  `DetailHooks<E>` / `ListHooks<E>` key the fills by the declared ids.
- The generated route passes its client to `detailPage` / `listPage`. The
  route's component chunk imports the client statically: the router loads
  that chunk in parallel with the loader and before hydration renders, so the
  model is registered with no extra request and no added waterfall.
  Generic components read the hooks from `DetailHooksProvider` and the model
  through `entityFieldModel` / `entitySummaryOf` / `entityDescriptorOf`.
- A surface that renders another entity waits for that entity's model:
  `EntityModelBoundary` (edit dialog, preview, relation table) or
  `useEntityModel(s)` (calendar, shelf, schema pages) suspends until the
  module arrives. Any other read of an unloaded model during render suspends
  the nearest boundary the same way (an enum option or filter spec for a
  second entity); outside render it throws, naming the entity. Loader-time
  code (list loaders, `resolveListView`) reads only the index, because a
  loader runs before the route's component chunk registers its model.
- The four global registries and their `lazy()` calls are deleted. Detail
  actions live in the `detail-action-context.tsx` leaf, which breaks the
  report-slot cycle.

## Considered options

- **A route loader `import()` of the client module**: the brief's first
  shape. The router already loads the component chunk in parallel with the
  loader, so a loader import adds nothing but a second code path, and the
  model must be registered before hydration renders anyway.
- **Static per-entity imports of every related model**: a product page would
  statically import a dozen models through its relation tables and lose most
  of the saving. The client prefetches relation targets instead, and the
  relation table waits on its boundary.
- **Keeping the summary as the eager index**: it carries every entity's
  detail sections and list presentation, most of which only that entity's
  pages read.

## Consequences

- Detail pages carry one entity's model and hooks, not all of them; route
  pages shrink accordingly. The app shell still carries the generated
  contract and filter maps (`entity-lists.gen.ts`,
  `entity-filter-bindings.gen.ts`, `entity-search.gen.ts`) because every list
  route's eager `validateSearch` and loader reads them.
- List slots load with their list page rather than behind `lazy()`, so a
  slot-heavy list (meals' calendar) loads that UI with the page.
- A new cross-entity surface must render under `EntityModelBoundary` or call
  `useEntityModel(s)` before reading a model it does not own. Tests register
  every model up front (`tooling/entity-models-test-setup.ts`).
