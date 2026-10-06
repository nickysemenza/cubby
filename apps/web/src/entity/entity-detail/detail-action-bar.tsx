import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { slotActionsOf } from "@cubby/schemas/entity-report";
import type { ReportSlot } from "@cubby/schemas/entity-report";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  createContext,
  useContext,
  lazy,
  Suspense,
  type ReactNode,
  type LazyExoticComponent,
} from "react";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import type { DetailSlotComponent } from "./detail-slots";
import { ReportVerb } from "./records-block";

const DetailActionContext = createContext(false);

/** Section controls are supplied once by the header, independent of the selected tab. */
export function DetailActionProvider({ children }: { children: ReactNode }) {
  return (
    <DetailActionContext.Provider value={true}>
      {children}
    </DetailActionContext.Provider>
  );
}

/** Standalone slot consumers retain their local controls. */
export function DetailAction({ children }: { children: ReactNode }) {
  return useContext(DetailActionContext) ? null : children;
}

const action = <E extends GenericDetailEntity>(
  load: () => Promise<{ default: DetailSlotComponent<E> }>,
) => lazy(load);
type HeaderActionRegistry = Partial<{
  [E in GenericDetailEntity]: LazyExoticComponent<DetailSlotComponent<E>>;
}>;
const headerActions: HeaderActionRegistry = {
  run: action<"run">(() =>
    import("./report-slot").then((m) => ({ default: m.RunDetailActions })),
  ),
  inventory: action<"inventory">(() =>
    import("~/entity/detail-field-renderers/inventory-expense").then((m) => ({
      default: m.InventoryRecordExpenseAction,
    })),
  ),
  recipe: action<"recipe">(() =>
    import("~/app/recipes/slots").then((m) => ({ default: m.RecipeActions })),
  ),
  cookbook: action<"cookbook">(() =>
    import("~/app/cookbooks/slots").then((m) => ({
      default: m.CookbookActions,
    })),
  ),
  meal: action<"meal">(() =>
    import("~/app/meals/slots").then((m) => ({ default: m.MealActions })),
  ),
};

export function DetailActionTarget<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const Custom = headerActions[entity];
  // SAFETY: the typed registry correlates each component with this entity's detail record.
  const customRecord = record as never;
  return (
    <DetailActionContext.Provider value={false}>
      <fieldset
        aria-label="Entity actions"
        className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden"
      >
        <Suspense fallback={null}>
          {Custom ? <Custom record={customRecord} /> : null}
          <ReportCollectionActions entity={entity} record={record} />
        </Suspense>
      </fieldset>
    </DetailActionContext.Provider>
  );
}

function ReportCollectionActions<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const presentation: CompiledEntityPresentation = entitySummary[entity];
  const actions = new Set(
    presentation.detail.sections.flatMap((section) =>
      section.kind === "slot" ? slotActionsOf(`${entity}.${section.id}`) : [],
    ),
  );
  return (
    <>
      {[...actions].map((action) => (
        <ReportVerb key={action} action={action} record={record} />
      ))}
    </>
  );
}

/** Explicit row exceptions: an attempt is diagnostic context for its owning Run. */
export type ReportDetailActionPlacement = {
  rows?: readonly string[];
  commands?: boolean;
};
type ReportDetailActionRegistry = Partial<
  Record<ReportSlot, ReportDetailActionPlacement>
>;
const reportDetailActions = {
  "run.live-progress": { rows: ["workflow"] },
} satisfies ReportDetailActionRegistry;

export function reportDetailActionsFor(
  slot: ReportSlot,
): ReportDetailActionPlacement | undefined {
  return Object.entries(reportDetailActions).find(([key]) => key === slot)?.[1];
}
