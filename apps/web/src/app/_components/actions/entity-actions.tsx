import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import type { ReactNode } from "react";
import { createContext, Fragment, useContext, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { copyIdentifiers, copyShortcodes } from "~/lib/clipboard";

import type {
  BulkAction,
  BulkActionAvailability,
  BulkActionResult,
} from "../data-table/bulk-actions.types";
import {
  VerbButton,
  VerbMenuItem,
  verbActionId,
  verbBulkAction,
} from "./action-verb-ui";
import type { ActionVerbId } from "./action-verbs";
import {
  bulkEditEntities,
  useBulkEditEntityAction,
} from "./bulk-edit-entity-action";
import { declaredEntityActionDefinitions } from "./declared-entity-actions";
import { deleteEntityActionDefinition } from "./delete-entity-action";
import {
  defineEntityAction,
  type EntityActionArity,
  type EntityActionDefinition,
  type EntityActionGroup,
  type EntityActionPlacement,
  type EntityActionSurface,
} from "./entity-action-definition";
import { inventoryLocationEntityActionDefinitions } from "./inventory-location-entity-actions";
import { mergeEntityActionDefinitions } from "./merge-entity-actions";
import { productRosterEntityActionDefinitions } from "./product-roster-entity-actions";
import { recipeEntityActionDefinitions } from "./recipe-entity-actions";
import { specialistLifecycleEntityActionDefinitions } from "./specialist-lifecycle-entity-actions";
import {
  useCreateProjectFromTasksAction,
  useMarkExpensePurchasedAction,
} from "./tracker-entity-actions";
import { useAddToInventoryAction } from "./use-add-to-inventory-action";
import { useDiscardInventoryAction } from "./use-discard-inventory-action";

/**
 * Entity action implementations own their dialog state and mutation;
 * `action-verbs.ts` owns their label, icon, and tone.
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
  /** Optional detail metadata consumed by entity-specific action dialogs. */
  subtaskCount?: number;
  recipeCount?: number;
  filename?: string;
  book?: string;
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

const isEntityActionRow = (row: {
  id: string | number;
}): row is EntityActionRow => typeof row.id === "string";

export type { EntityActionDefinition } from "./entity-action-definition";

type EntityActionAvailability = BulkActionAvailability;

export interface EntityActionResolutionContext {
  entity: Entity;
  surface: EntityActionSurface;
  rows: readonly EntityActionRow[];
}

interface ResolvedEntityAction<TRow extends EntityActionRow> {
  id: string;
  verb: ActionVerbId;
  surface: "selection";
  arity: EntityActionArity;
  group: EntityActionGroup;
  priority: number;
  placement: EntityActionPlacement;
  minSelection: number;
  maxSelection?: number;
  preserveSelection: boolean;
  availability: (rows: readonly TRow[]) => EntityActionAvailability;
  run: (rows: readonly TRow[]) => Promise<BulkActionResult>;
}

interface ResolvedEntityRecordAction {
  id: string;
  verb: ActionVerbId;
  surface: "detail" | "inspector";
  arity: Exclude<EntityActionArity, "multi">;
  group: EntityActionGroup;
  priority: number;
  placement: EntityActionPlacement;
  preserveSelection: boolean;
  availability: (row: EntityActionRow) => EntityActionAvailability;
  run: (row: EntityActionRow) => void;
}

const compareEntityActions = <
  T extends { group: EntityActionGroup; priority: number },
>(
  left: T,
  right: T,
) => {
  const groups: readonly EntityActionGroup[] = [
    "primary",
    "organize",
    "lifecycle",
    "destructive",
  ];
  return (
    groups.indexOf(left.group) - groups.indexOf(right.group) ||
    left.priority - right.priority
  );
};

/** Adapt a normalized selection action for `BulkActionBar`. */
function entityActionBulkAction<TRow extends EntityActionRow>(
  action: ResolvedEntityAction<TRow>,
): BulkAction<TRow> {
  const options: Omit<BulkAction<TRow>, "id" | "label" | "icon" | "tone"> & {
    id?: string;
  } = {
    id: action.id,
    minSelection: action.minSelection,
    availability: (selectedRows) =>
      action.availability(selectedRows.map((row) => row.original)),
    onExecute: (selectedRows) =>
      action.run(selectedRows.map((row) => row.original)),
  };
  if (action.maxSelection !== undefined) {
    options.maxSelection = action.maxSelection;
  }
  if (action.preserveSelection) {
    options.preserveSelection = true;
  }
  return verbBulkAction<TRow>(action.verb, options);
}

const DEFAULT_PLACEMENT = {
  row: "overflow",
  selection: "primary",
  inspector: "primary",
  detail: "primary",
  "navbar-create": "primary",
  "palette-quick": "primary",
  "inventory-page": "primary",
  "home-quick": "primary",
  "empty-state": "primary",
} satisfies Readonly<Record<EntityActionSurface, EntityActionPlacement>>;

const AVAILABLE: EntityActionAvailability = { status: "available" };
const HIDDEN: EntityActionAvailability = { status: "hidden" };

const DEFAULT_SURFACES: readonly EntityActionSurface[] = [
  "row",
  "selection",
  "inspector",
  "detail",
];
const NO_ADDITIONAL_ACTIONS: readonly EntityActionDefinition[] = [];

export interface EntityActionClipboardPort {
  copyShortcodes: typeof copyShortcodes;
  copyIdentifiers: typeof copyIdentifiers;
}

const productionEntityActionClipboard: EntityActionClipboardPort = {
  copyShortcodes,
  copyIdentifiers,
};
const EntityActionClipboardContext = createContext<EntityActionClipboardPort>(
  productionEntityActionClipboard,
);

export function EntityActionClipboardProvider({
  port,
  children,
}: {
  port: EntityActionClipboardPort;
  children: ReactNode;
}) {
  return (
    <EntityActionClipboardContext.Provider value={port}>
      {children}
    </EntityActionClipboardContext.Provider>
  );
}

/**
 * How many rows an action means anything on.
 *
 * Declared rather than inferred, because the two failure modes look identical
 * from the outside: `merge` is `multi` (merging one record is a no-op), while
 * `discard` is `both` even though it writes ONE ledger line per row — N lines
 * is what N discards ARE, not a compromise. Recording that keeps a row-only
 * verb an intentional decision instead of an omission nobody got round to.
 */
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
  /** Runtime availability, for data- or permission-dependent actions. */
  availability?: (
    context: EntityActionResolutionContext,
  ) => EntityActionAvailability;
}

/**
 * The registry. Order is the order actions appear within their surface, after
 * the generic "Copy codes" and before the contract's "Delete" (see
 * `useListBulkActions`).
 */
const entityActions: readonly EntityActionDefinition[] = [
  defineEntityAction({
    id: "copy-shortcodes",
    verb: "copyCodes",
    entities: shortcodeEntities,
    arity: "both",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "primary",
    priority: 0,
    placement: { inspector: "overflow", detail: "overflow" },
    preserveSelection: true,
    use: () => {
      const clipboard = useContext(EntityActionClipboardContext);
      return {
        run: async (rows) => ({
          success: await clipboard.copyShortcodes(rows.map((row) => row.id)),
        }),
        rowMenuItem: (row) => (
          <VerbMenuItem
            verb="copyCodes"
            onSelect={() => void clipboard.copyShortcodes([row.id])}
          />
        ),
        dialog: null,
      };
    },
  }),
  defineEntityAction({
    verb: "copyIdentifiers",
    entities: ["usda-food"],
    arity: "both",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "primary",
    priority: 0,
    placement: { inspector: "overflow", detail: "overflow" },
    preserveSelection: true,
    use: () => {
      const clipboard = useContext(EntityActionClipboardContext);
      return {
        run: async (rows) => ({
          success: await clipboard.copyIdentifiers(rows.map((row) => row.id)),
        }),
        rowMenuItem: (row) => (
          <VerbMenuItem
            verb="copyIdentifiers"
            onSelect={() => void clipboard.copyIdentifiers([row.id])}
          />
        ),
        dialog: null,
      };
    },
  }),
  defineEntityAction({
    verb: "addToInventory",
    entities: ["product"],
    // A selection shares its location while retaining per-row quantities.
    arity: "both",
    // Cancelling the staged location and quantities leaves selection intact.
    preserveSelection: true,
    group: "primary",
    priority: 100,
    surfaces: ["row", "selection", "inspector", "detail", "palette-quick"],
    use: useAddToInventoryAction,
  }),
  defineEntityAction({
    verb: "discard",
    // `inventory`, not `product`: an entry names its amount and its shelf, so a
    // selection of entries is already a complete instruction. A product row is
    // not — a product on two shelves still owes a per-row choice — which is why
    // `productlist` keeps its own single-row discard and this never reaches it.
    entities: ["inventory"],
    arity: "both",
    group: "lifecycle",
    priority: 100,
    // Cancelling staged discard details leaves selection intact.
    preserveSelection: true,
    use: useDiscardInventoryAction,
  }),
  ...recipeEntityActionDefinitions,
  ...inventoryLocationEntityActionDefinitions,
  ...mergeEntityActionDefinitions,
  ...productRosterEntityActionDefinitions,
  ...specialistLifecycleEntityActionDefinitions,
  ...declaredEntityActionDefinitions,
  deleteEntityActionDefinition,
  defineEntityAction({
    verb: "markPurchased",
    entities: ["expense"],
    arity: "single",
    surfaces: ["row", "inspector", "detail"],
    group: "primary",
    priority: 50,
    use: useMarkExpensePurchasedAction,
  }),
  defineEntityAction({
    verb: "bulkEdit",
    entities: bulkEditEntities,
    arity: "both",
    group: "organize",
    priority: 200,
    use: useBulkEditEntityAction,
  }),
  defineEntityAction({
    id: "create-project",
    verb: "createProjectFrom",
    entities: ["task"],
    arity: "both",
    surfaces: ["selection"],
    group: "organize",
    priority: 500,
    preserveSelection: true,
    use: useCreateProjectFromTasksAction,
  }),
];

export interface EntityActionCatalogDescriptor extends Omit<
  EntityActionDefinition,
  "use" | "surfaces"
> {
  surfaces: readonly EntityActionSurface[];
}

/** Read-only production roster for audits and contract tests; hooks stay private. */
export const entityActionCatalogDescriptors: readonly EntityActionCatalogDescriptor[] =
  entityActions.map(({ use: _use, surfaces, ...definition }) => ({
    ...definition,
    surfaces: surfaces ?? DEFAULT_SURFACES,
  }));

const appliesTo = (
  definition: EntityActionDefinition,
  entity: Entity,
  surface: EntityActionSurface,
) =>
  definition.entities.includes(entity) &&
  (definition.surfaces ?? DEFAULT_SURFACES).includes(surface);

/**
 * The sole heterogeneous-registry escape hatch. Definitions are correlated at
 * construction time; filtering above proves this runtime entity is in the
 * selected roster before React invokes its hook.
 */
const resolveEntityActionHandles = (
  definition: EntityActionDefinition,
  entity: Entity,
): EntityActionHandles => {
  if (!definition.entities.includes(entity)) {
    throw new Error(`Action ${definition.verb} does not support ${entity}`);
  }
  // SAFETY: EntityActionDefinition's private brand admits only values produced
  // by defineEntityAction, which correlates `use` with `entities`; the check
  // above proves this entity belongs to that exact roster.
  return (definition.use as (allowedEntity: Entity) => EntityActionHandles)(
    entity,
  );
};

const hasExplicitSurface = (
  definition: EntityActionDefinition,
  surface: EntityActionSurface,
) => definition.surfaces?.includes(surface) ?? false;

const selectionBounds = (definition: EntityActionDefinition) => {
  const minSelection = Math.max(
    definition.minSelection ?? 1,
    definition.arity === "multi" ? 2 : 1,
  );
  const arityMaximum = definition.arity === "single" ? 1 : undefined;
  const maxSelection =
    definition.maxSelection == null
      ? arityMaximum
      : arityMaximum == null
        ? definition.maxSelection
        : Math.min(definition.maxSelection, arityMaximum);
  return { minSelection, maxSelection };
};

export interface UseEntityActionsReturn<TRow extends EntityActionRow> {
  /** For the selection bar. `single` verbs must opt into the surface. */
  selectionActions: BulkAction<TRow>[];
  /** Catalog-native selection actions, including placement and availability. */
  selectionActionItems: ResolvedEntityAction<TRow>[];
  /**
   * For the row menu. Only `single`/`both` verbs reach this.
   *
   * Typed against the base row rather than `TRow`: definitions only ever see
   * `EntityActionRow`, and parameterizing it here made the value unassignable
   * to the context it is published through, which cost every consumer a cast.
   * The generic stays on `selectionActions`, where the caller's row type is real.
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
  detailActions: ResolvedEntityRecordAction[];
  /** Actions rendered against the inspector's one canonical record. */
  inspectorActions: ResolvedEntityRecordAction[];
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
  /** Surface-owned lifecycle adapters, such as optimistic list deletion. */
  additionalDefinitions: readonly EntityActionDefinition[] = NO_ADDITIONAL_ACTIONS,
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
      [...registry, ...additionalDefinitions].filter(
        (definition) =>
          appliesTo(definition, entity, "row") ||
          appliesTo(definition, entity, "selection") ||
          appliesTo(definition, entity, "inspector") ||
          appliesTo(definition, entity, "detail") ||
          appliesTo(definition, entity, "palette-quick"),
      ),
    [additionalDefinitions, entity, registry],
  );

  // Stable across renders because `matching` is derived from a constant
  // `entity` over a module-level registry — see the invariant above.
  const resolved = matching.map((definition) => ({
    definition,
    handles: resolveEntityActionHandles(definition, entity),
  }));

  const actionAvailability = (
    definition: EntityActionDefinition,
    handles: EntityActionHandles,
    surface: EntityActionSurface,
    rows: readonly EntityActionRow[],
  ): EntityActionAvailability => {
    if (!handles.run) return HIDDEN;
    const context = { entity, surface, rows };
    return (
      handles.availability?.(context) ??
      definition.availability?.(context) ??
      AVAILABLE
    );
  };

  const actionMetadata = (
    definition: EntityActionDefinition,
    surface: EntityActionSurface,
  ) => ({
    group: definition.group ?? "primary",
    priority: definition.priority ?? 100,
    placement: definition.placement?.[surface] ?? DEFAULT_PLACEMENT[surface],
  });

  const selectionActionItems = resolved
    .flatMap(({ definition, handles }) => {
      if (!appliesTo(definition, entity, "selection")) return [];
      // Single actions require explicit selection placement and cap at one row.
      if (
        definition.arity === "single" &&
        !hasExplicitSurface(definition, "selection")
      )
        return [];
      const { run } = handles;
      if (!run) return [];
      const { minSelection, maxSelection } = selectionBounds(definition);
      const metadata = actionMetadata(definition, "selection");
      const selectionAction: ResolvedEntityAction<TRow> = {
        id: definition.id ?? verbActionId(definition.verb),
        verb: definition.verb,
        surface: "selection",
        arity: definition.arity,
        ...metadata,
        minSelection,
        preserveSelection: definition.preserveSelection ?? false,
        availability: (rows: readonly TRow[]) =>
          actionAvailability(definition, handles, "selection", rows),
        run: (rows: readonly TRow[]) => run(rows),
      };
      if (maxSelection !== undefined)
        selectionAction.maxSelection = maxSelection;
      return [selectionAction];
    })
    .sort(compareEntityActions);

  const selectionActions = selectionActionItems.map(entityActionBulkAction);

  const rowCapable = resolved.filter(
    ({ definition }) =>
      definition.arity !== "multi" && appliesTo(definition, entity, "row"),
  );
  // Keyed by stable action id, not by array position: a definition's handles
  // are rendered as siblings, and a registry entry that appears conditionally
  // (an action with no `run` this render) would otherwise shift every later key.
  const rowMenuItems = (row: EntityActionRow) =>
    rowCapable.map(({ definition, handles }) => (
      <Fragment key={definition.id ?? definition.verb}>
        {handles.rowMenuItem(row)}
      </Fragment>
    ));

  const dialogs = resolved.flatMap(({ definition, handles }) =>
    handles.dialog == null
      ? []
      : [
          <Fragment key={definition.id ?? definition.verb}>
            {handles.dialog}
          </Fragment>,
        ],
  );

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
  const recordActionsFor = (surface: "detail" | "inspector") =>
    resolved
      .flatMap(({ definition, handles }) => {
        if (definition.arity === "multi") return [];
        if (!appliesTo(definition, entity, surface)) return [];
        const { run } = handles;
        if (!run) return [];
        const metadata = actionMetadata(definition, surface);
        const recordAction: ResolvedEntityRecordAction = {
          id: definition.id ?? verbActionId(definition.verb),
          verb: definition.verb,
          surface,
          arity: definition.arity,
          run: (row: EntityActionRow) => void run([row]),
          ...metadata,
          preserveSelection: definition.preserveSelection ?? false,
          availability: (row: EntityActionRow) =>
            actionAvailability(definition, handles, surface, [row]),
        };
        return [recordAction];
      })
      .sort(compareEntityActions);

  const detailActions = recordActionsFor("detail");
  const inspectorActions = recordActionsFor("inspector");

  return {
    selectionActions,
    selectionActionItems,
    rowMenuItems,
    dialogs,
    singleRecordActions,
    detailActions,
    inspectorActions,
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
 * cell *can* read a context, which is how a column reaches shared per-table
 * data. So the surface resolves the actions once (the same call that renders
 * `dialogs`) and publishes them here.
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
  const own = isEntityActionRow(row) ? itemsFor(entity, row) : null;
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
 * Renders a record's declared actions and their dialogs.
 */
export function EntityActionButtons({
  entity,
  record,
  surface = "detail",
  verbs,
  overflow = "menu",
}: {
  entity: Entity;
  record: EntityActionRow;
  surface?: "detail" | "inspector";
  /**
   * Only these verbs render (the manifest's declared `hero.actions`); the
   * registry's full roster otherwise. `copyCodes` always stays reachable —
   * it is the one generic verb every shortcode entity has.
   */
  verbs?: readonly ActionVerbId[];
  /**
   * "menu" (default, unchanged behaviour): one primary button plus a "More
   * actions" popover for the rest. "inline": every visible verb renders as
   * its own button, no split — the detail plate's `md+` width, which has
   * room to spell every verb out.
   */
  overflow?: "inline" | "menu";
}) {
  const { detailActions, inspectorActions, dialogs } = useEntityActions(entity);
  const actions = surface === "inspector" ? inspectorActions : detailActions;
  if (actions.length === 0) return null;
  const visible = actions.flatMap((action) => {
    if (
      verbs !== undefined &&
      action.verb !== "copyCodes" &&
      !verbs.includes(action.verb)
    )
      return [];
    const availability = action.availability(record);
    return availability.status === "hidden" ? [] : [{ action, availability }];
  });

  if (overflow === "inline") {
    return (
      <>
        {visible.map(({ action, availability }) => (
          <VerbButton
            key={action.id}
            verb={action.verb}
            disabled={availability.status === "disabled"}
            disabledReason={
              availability.status === "disabled"
                ? availability.reason
                : undefined
            }
            onClick={() => action.run(record)}
          />
        ))}
        {dialogs}
      </>
    );
  }

  const primaryIndex = visible.findIndex(
    ({ action, availability }) =>
      action.group !== "destructive" &&
      action.placement === "primary" &&
      availability.status === "available",
  );
  const primary = primaryIndex >= 0 ? visible[primaryIndex] : undefined;
  const menuOverflow = visible.filter((_, index) => index !== primaryIndex);
  return (
    <>
      {primary ? (
        <VerbButton
          verb={primary.action.verb}
          onClick={() => primary.action.run(record)}
        />
      ) : null}
      {menuOverflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" aria-label="More actions" />
            }
          >
            <DotsThreeIcon />
            More actions
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {menuOverflow.map(({ action, availability }, index) => (
              <Fragment key={action.id}>
                {action.group === "destructive" &&
                menuOverflow[index - 1]?.action.group !== "destructive" ? (
                  <DropdownMenuSeparator />
                ) : null}
                <VerbMenuItem
                  verb={action.verb}
                  disabledReason={
                    availability.status === "disabled"
                      ? availability.reason
                      : undefined
                  }
                  onSelect={() => action.run(record)}
                />
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {dialogs}
    </>
  );
}
