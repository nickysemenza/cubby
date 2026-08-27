import type { Entity } from "@cubby/schemas/entity";
import type { ReactNode } from "react";
import { createContext, Fragment, useContext, useMemo, useRef } from "react";
import type {
  BulkAction,
  BulkActionResult,
} from "../data-table/bulk-actions.types";
import type { ActionSurface } from "./action-items";
import { VerbButton, verbBulkAction } from "./action-verb-ui";
import type { ActionVerbId } from "./action-verbs";
import { useAddToInventoryAction } from "./use-add-to-inventory-action";

/**
 * The entity action registry: which verbs an entity offers, and what running
 * one does.
 *
 * ## Why this is not the rejected `run`-union sketch
 *
 * `action-verbs.ts` documents an earlier attempt to model the whole action as
 * data with a `run` union, which degenerated into "a handler id the call site
 * had to resolve anyway". This registry stores the *implementation* — a hook
 * that owns its own dialog state and mutation and hands back a ready
 * `BulkAction`, a row-menu node, and the dialog to render. The call site
 * resolves nothing; it renders `dialogs`.
 *
 * That contract is not new: `useOptimisticDelete` has satisfied it for one
 * hard-coded verb since bulk delete shipped, returning
 * `{ deleteBulkAction, combinedExtraActions, deleteDialog, requestDelete }`.
 * All this does is make the list of such hooks resolvable by entity, so a verb
 * declared once reaches every surface that renders that entity.
 *
 * `action-verbs.ts` stays presentation-only — label, icon and tone still come
 * from `verbDef`, and nothing here re-spells them.
 */

/**
 * The minimum a row must carry for a registered action to act on it.
 *
 * Definitions are written against this rather than each list's row type, and
 * `useEntityActions` hands the result back at the caller's row type. That is
 * sound without a cast: an `onExecute` that accepts the wider row is usable
 * where one accepting the narrower row is expected.
 */
export interface EntityActionRow {
  id: string;
  /** Used for display only; absent where a surface knows only the code. */
  name?: string | null;
}

/**
 * The record a row is *about*, when that differs from the row itself.
 *
 * An inventory entry is about its product; an expense line is about the
 * product it names. Declaring that is what lets an action registered for one
 * entity be reached from a table of another, without every such table
 * re-declaring the action.
 */
export interface EntityActionSubject extends EntityActionRow {
  entity: Entity;
}

/** Where a registered action is allowed to appear. */
type EntityActionSurface = "row" | "bar" | "detail" | ActionSurface;

const DEFAULT_SURFACES: readonly EntityActionSurface[] = [
  "row",
  "bar",
  "detail",
];

/**
 * How many rows an action means anything on.
 *
 * Declared rather than inferred, because the two failure modes look identical
 * from the outside: `merge` is `multi` (merging one record is a no-op) and
 * `discard` is `single` on purpose (it writes one ledger line against one
 * product). Recording that keeps a row-only verb an intentional decision
 * instead of an omission nobody got round to.
 */
type EntityActionArity = "single" | "multi" | "both";

export interface EntityActionHandles {
  /**
   * Runs the action over a selection. Null when this invocation has nothing to
   * offer — a missing context the surface could not supply, say.
   *
   * Takes row values, not the table's `Row` wrappers: a definition should not
   * have to know it is being rendered by TanStack Table, and `Row<T>` is
   * invariant, so threading it here would force every consumer to cast.
   */
  run: ((rows: readonly EntityActionRow[]) => Promise<BulkActionResult>) | null;
  /** Row-menu entry. Returns null for a row the action does not apply to. */
  rowMenuItem: (row: EntityActionRow) => ReactNode;
  /** Rendered once by the consuming surface, outside the table. */
  dialog: ReactNode;
}

export interface EntityActionDefinition {
  /** Presentation (label/icon/tone) resolves through `verbDef(verb)`. */
  verb: ActionVerbId;
  /** Rosters that offer this action. */
  entities: readonly Entity[];
  arity: EntityActionArity;
  /** Extra floor beyond what `arity` implies. */
  minSelection?: number;
  /** Defaults to row + bar + detail. */
  surfaces?: readonly EntityActionSurface[];
  /** Keep the selection after a successful run (e.g. a refusable batch). */
  preserveSelection?: boolean;
  /**
   * The implementation. A React hook, so it may hold state, open dialogs and
   * own its mutation — which is the whole reason behavior lives here rather
   * than as an id the call site dereferences.
   */
  use: () => EntityActionHandles;
}

/**
 * The registry. Order is the order actions appear within their surface, after
 * the generic "Copy codes" and before the contract's "Delete" (see
 * `useListBulkActions`).
 */
const entityActions: readonly EntityActionDefinition[] = [
  {
    verb: "addToInventory",
    entities: ["product"],
    // `both`, and that is the whole point: it was a row-only affordance
    // repeated on three tables, so stocking an order meant opening the same
    // dialog once per line and re-picking the same shelf every time.
    arity: "both",
    // "detail" included: the action derives the kit over-accounting warning
    // itself now, so the product page no longer has to keep a bespoke dialog
    // to be the one caller that can show it.
    surfaces: ["row", "bar", "detail", "palette-quick"],
    // The dialog collects a location and per-row quantities, so the bar's job
    // ends once the rows are staged — and a cancelled dialog should leave the
    // operator's selection where they left it.
    preserveSelection: true,
    use: useAddToInventoryAction,
  },
];

const appliesTo = (
  definition: EntityActionDefinition,
  entity: Entity,
  surface: EntityActionSurface,
) =>
  definition.entities.includes(entity) &&
  (definition.surfaces ?? DEFAULT_SURFACES).includes(surface);

export interface UseEntityActionsReturn<TRow extends EntityActionRow> {
  /** For the selection bar. Only `multi`/`both` verbs reach this. */
  bulkActions: BulkAction<TRow>[];
  /**
   * For the row menu. Only `single`/`both` verbs reach this.
   *
   * Typed against the base row rather than `TRow`: definitions only ever see
   * `EntityActionRow`, and parameterizing it here made the value unassignable
   * to the context it is published through, which cost every consumer a cast.
   * The generic stays on `bulkActions`, where the caller's row type is real.
   */
  rowMenuItems: (row: EntityActionRow) => ReactNode;
  /** Render once per surface, outside the table. */
  dialogs: ReactNode;
  /**
   * Actions a surface renders its own control for, against a single record —
   * the command palette, which has `CommandItem`s rather than menu items and
   * resolves one record from a shortcode.
   */
  singleRecordActions: {
    verb: ActionVerbId;
    run: (row: EntityActionRow) => void;
  }[];
  /** Actions a detail page renders as buttons against the record it shows. */
  detailActions: {
    verb: ActionVerbId;
    run: (row: EntityActionRow) => void;
  }[];
}

/**
 * Resolve an entity's declared actions.
 *
 * ## Why `entity` must not change
 *
 * Each definition's `use()` is a hook, and only the definitions matching
 * `entity` are invoked — mounting every entity's dialogs on every list would
 * be wasteful and would let a task dialog live inside the product table. That
 * makes hook order a function of `entity`, which is fine because a table's
 * entity is fixed for the lifetime of the component, and asserted below so a
 * future caller that swaps it fails loudly instead of corrupting hook state.
 */
export function useEntityActions<TRow extends EntityActionRow>(
  entity: Entity,
  /**
   * Test seam. Production callers pass nothing and get the module registry;
   * a test supplies its own so it can assert the resolution rules without
   * depending on which verbs happen to be declared. Like `entity`, it fixes
   * which hooks run, so it must be constant for a component instance.
   */
  registry: readonly EntityActionDefinition[] = entityActions,
): UseEntityActionsReturn<TRow> {
  const firstEntityRef = useRef(entity);
  if (firstEntityRef.current !== entity) {
    throw new Error(
      `useEntityActions was called with "${entity}" after "${firstEntityRef.current}". ` +
        "The entity fixes which action hooks run, so it must be constant for a component instance.",
    );
  }

  const matching = useMemo(
    () =>
      registry.filter(
        (definition) =>
          appliesTo(definition, entity, "row") ||
          appliesTo(definition, entity, "bar") ||
          appliesTo(definition, entity, "detail") ||
          appliesTo(definition, entity, "palette-quick"),
      ),
    [entity, registry],
  );

  // Stable across renders because `matching` is derived from a constant
  // `entity` over a module-level registry — see the invariant above.
  const resolved = matching.map((definition) => ({
    definition,
    handles: definition.use(),
  }));

  const bulkActions = resolved.flatMap(({ definition, handles }) => {
    if (definition.arity === "single") return [];
    if (!appliesTo(definition, entity, "bar")) return [];
    const { run } = handles;
    if (!run) return [];
    // `multi` means "one row is a no-op", so its floor is two regardless of
    // what the definition asked for.
    const minSelection = Math.max(
      definition.minSelection ?? 1,
      definition.arity === "multi" ? 2 : 1,
    );
    return [
      verbBulkAction<TRow>(definition.verb, {
        minSelection,
        ...(definition.preserveSelection
          ? { preserveSelection: definition.preserveSelection }
          : {}),
        // The one place the wrapper is unwrapped, so no definition repeats it.
        onExecute: (selectedRows) => run(selectedRows.map((r) => r.original)),
      }),
    ];
  });

  const rowCapable = resolved.filter(
    ({ definition }) =>
      definition.arity !== "multi" && appliesTo(definition, entity, "row"),
  );
  // Keyed by verb, not by array position: a definition's handles are rendered
  // as siblings, and a registry entry that appears conditionally (an action
  // with no `run` this render) would otherwise shift every later key.
  const rowMenuItems = (row: EntityActionRow) =>
    rowCapable.map(({ definition, handles }) => (
      <Fragment key={definition.verb}>{handles.rowMenuItem(row)}</Fragment>
    ));

  const dialogs = resolved.map(({ definition, handles }) => (
    <Fragment key={definition.verb}>{handles.dialog}</Fragment>
  ));

  const singleRecordActions = resolved.flatMap(({ definition, handles }) => {
    if (definition.arity === "multi") return [];
    if (!appliesTo(definition, entity, "palette-quick")) return [];
    const { run } = handles;
    if (!run) return [];
    return [
      { verb: definition.verb, run: (row: EntityActionRow) => void run([row]) },
    ];
  });

  // Same shape as `singleRecordActions`, different surface: a detail page acts
  // on the one record it is showing, and renders a button rather than a
  // command item.
  const detailActions = resolved.flatMap(({ definition, handles }) => {
    if (definition.arity === "multi") return [];
    if (!appliesTo(definition, entity, "detail")) return [];
    const { run } = handles;
    if (!run) return [];
    return [
      { verb: definition.verb, run: (row: EntityActionRow) => void run([row]) },
    ];
  });

  return {
    bulkActions,
    rowMenuItems,
    dialogs,
    singleRecordActions,
    detailActions,
  };
}

/**
 * What a surface publishes so the actions column's cells can reach the row
 * items it resolved.
 *
 * A **list**, because one table can offer two entities' actions: its own rows'
 * and those of the record each row is *about*. An inventory entry names a
 * product, so the inventory table publishes both, and each entry carries its
 * `entity` so a sub-table of a different entity rendered inside the provider
 * cannot pick up the outer one's items.
 */
export interface EntityActionsEntry {
  entity: Entity;
  rowMenuItems: (row: EntityActionRow) => ReactNode;
}

export type EntityActionsContextValue = readonly EntityActionsEntry[];

const EntityActionsContext = createContext<EntityActionsContextValue | null>(
  null,
);

/**
 * Bridges `useEntityActions` calls to every actions column beneath.
 *
 * `createActionsColumn` builds a column def, and its callers build columns
 * inside a `useMemo` — neither is a legal place to call a hook, and mounting
 * the definitions per row would give each row its own copy of every dialog. A
 * cell *can* read a context, which is how `createExpenseProductImageColumn`
 * already reaches shared per-table data. So the surface resolves the actions
 * once (the same call that renders `dialogs`) and publishes them here.
 *
 * Nested providers **merge**: a table publishes its own entity, then nests a
 * second provider for the subject entity. The nearest entry for a given entity
 * wins, so an inner table still shadows an outer one of the same entity.
 */
export function EntityActionsProvider({
  value,
  children,
}: {
  value: EntityActionsContextValue | EntityActionsEntry | null;
  children: ReactNode;
}) {
  const parent = useContext(EntityActionsContext);
  const merged = useMemo<EntityActionsContextValue | null>(() => {
    const added = value === null ? [] : Array.isArray(value) ? value : [value];
    if (added.length === 0) return parent;
    const inherited = (parent ?? []).filter(
      (entry) => !added.some((next) => next.entity === entry.entity),
    );
    return [...added, ...inherited];
  }, [value, parent]);
  return (
    <EntityActionsContext.Provider value={merged}>
      {children}
    </EntityActionsContext.Provider>
  );
}

/**
 * The registered row-menu entries for one row, or nothing outside a provider.
 *
 * Renders the table entity's actions for the row itself, then the actions of
 * whatever the row is *about* — so "Add to inventory" is reachable from an
 * inventory entry or an expense line, not only from the product list.
 */
export function EntityActionRowMenuItems({
  entity,
  row,
  subject,
}: {
  entity: Entity;
  row: { id: string | number };
  /** What this row is about, when that is a different record. */
  subject?: EntityActionSubject | null;
}) {
  const context = useContext(EntityActionsContext);
  if (!context) return null;

  const itemsFor = (target: Entity, record: EntityActionRow) =>
    context.find((entry) => entry.entity === target)?.rowMenuItems(record) ??
    null;

  // Registered actions address rows by public shortcode; the only rows keyed
  // by anything else are non-entity rows no definition can target.
  const own =
    typeof row.id === "string"
      ? itemsFor(entity, row as EntityActionRow)
      : null;
  // A row whose subject IS itself would otherwise list every action twice.
  const subjectItems =
    subject && !(subject.entity === entity && subject.id === row.id)
      ? itemsFor(subject.entity, { id: subject.id, name: subject.name })
      : null;

  if (!own && !subjectItems) return null;
  return (
    <>
      {own}
      {subjectItems}
    </>
  );
}

/**
 * A record's declared actions as buttons — the detail-page counterpart to
 * `EntityActionRowMenuItems`.
 *
 * Deliberately not a retrofit of every detail page onto `heroActions`: the
 * twelve detail pages each hand-assemble their own actions today, and rewriting
 * that is a separate job. This slots wherever a page already renders an action
 * — a section `headerAction`, a hero slot — so a verb declared once stops
 * being unreachable from the record's own page.
 *
 * Mounts its own dialogs, so the caller renders nothing else.
 */
export function EntityActionButtons({
  entity,
  record,
}: {
  entity: Entity;
  record: EntityActionRow;
}) {
  const { detailActions, dialogs } = useEntityActions(entity);
  if (detailActions.length === 0) return null;
  return (
    <>
      {detailActions.map((action) => (
        <VerbButton
          key={action.verb}
          verb={action.verb}
          onClick={() => action.run(record)}
        />
      ))}
      {dialogs}
    </>
  );
}
