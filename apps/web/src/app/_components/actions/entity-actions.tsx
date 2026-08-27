import type { Entity } from "@cubby/schemas/entity";
import type { ReactNode } from "react";
import { createContext, Fragment, useContext, useMemo, useRef } from "react";
import type {
  BulkAction,
  BulkActionResult,
} from "../data-table/bulk-actions.types";
import type { ActionSurface } from "./action-items";
import { verbBulkAction } from "./action-verb-ui";
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

/** Where a registered action is allowed to appear. */
export type EntityActionSurface = "row" | "bar" | "detail" | ActionSurface;

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
export type EntityActionArity = "single" | "multi" | "both";

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
export const entityActions: readonly EntityActionDefinition[] = [
  {
    verb: "addToInventory",
    entities: ["product"],
    // `both`, and that is the whole point: it was a row-only affordance
    // repeated on three tables, so stocking an order meant opening the same
    // dialog once per line and re-picking the same shelf every time.
    arity: "both",
    // No "detail": the product detail page keeps its own dialog because it is
    // the one caller that can pass `accounting`, and so the only one that can
    // warn when stocking another unit would account for more kits than were
    // bought. A registry entry cannot reproduce that from a row's id alone.
    surfaces: ["row", "bar", "palette-quick"],
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
  /** For the row menu. Only `single`/`both` verbs reach this. */
  rowMenuItems: (row: TRow) => ReactNode;
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
  const rowMenuItems = (row: TRow) =>
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

  return { bulkActions, rowMenuItems, dialogs, singleRecordActions };
}

/**
 * What a surface publishes so the actions column's cells can reach the row
 * items it resolved.
 *
 * `entity` travels with the items because a sub-table of a DIFFERENT entity
 * may render inside the provider (an expense table on a project page). Items
 * resolved for the outer entity must not leak into it.
 */
export interface EntityActionsContextValue {
  entity: Entity;
  rowMenuItems: (row: EntityActionRow) => ReactNode;
}

const EntityActionsContext = createContext<EntityActionsContextValue | null>(
  null,
);

/**
 * Bridges one `useEntityActions` call to every actions column beneath it.
 *
 * `createActionsColumn` builds a column def, and its callers build columns
 * inside a `useMemo` — neither is a legal place to call a hook, and mounting
 * the definitions per row would give each row its own copy of every dialog. A
 * cell *can* read a context, which is how `createExpenseProductImageColumn`
 * already reaches shared per-table data. So the surface resolves the actions
 * once (the same call that renders `dialogs`) and publishes them here.
 */
export function EntityActionsProvider({
  value,
  children,
}: {
  value: EntityActionsContextValue | null;
  children: ReactNode;
}) {
  return (
    <EntityActionsContext.Provider value={value}>
      {children}
    </EntityActionsContext.Provider>
  );
}

/** The registered row-menu entries for one row, or nothing outside a provider. */
export function EntityActionRowMenuItems({
  entity,
  row,
}: {
  entity: Entity;
  row: { id: string | number };
}) {
  const context = useContext(EntityActionsContext);
  if (!context || context.entity !== entity) return null;
  // Registered actions address rows by public shortcode; the only rows keyed
  // by anything else are non-entity rows no definition can target.
  if (typeof row.id !== "string") return null;
  return <>{context.rowMenuItems(row as EntityActionRow)}</>;
}
