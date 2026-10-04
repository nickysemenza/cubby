import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { SectionActionId } from "@cubby/schemas/entity-section-actions";
import { type FunctionComponent, lazy, type LazyExoticComponent } from "react";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

interface SectionActionProps<E extends GenericDetailEntity> {
  record: DetailRecordOf<E>;
  /** The server's word on the verb: its label, scope and why it is unavailable. */
  action: NonNullable<
    Extract<ReportBlock, { kind: "records" }>["verbs"]
  >[number];
  /** The checked rows, for a `selection` verb. */
  selection: readonly string[];
  clearSelection: () => void;
}

export type SectionActionComponent<E extends GenericDetailEntity> =
  FunctionComponent<SectionActionProps<E>>;

type ActionModule<E extends GenericDetailEntity> = Promise<{
  default: SectionActionComponent<E>;
}>;
const action = <E extends GenericDetailEntity>(
  load: () => ActionModule<E>,
): LazyExoticComponent<SectionActionComponent<E>> => lazy(load);

/**
 * The web run of every verb a `summary` or `recordList` section declares. Web implements them
 * all (native classifies the rest in `native-coverage.ts`); each calls the operation the verb
 * names, behind the server's `disabledReason`, never a rule of its own.
 */
const sectionActions = {
  purchase: {
    matchStatement: action(() =>
      import("~/app/purchases/section-actions").then((m) => ({
        default: m.MatchStatementAction,
      })),
    ),
    linkExpenses: action(() =>
      import("~/app/purchases/section-actions").then((m) => ({
        default: m.LinkExpensesAction,
      })),
    ),
    linkProducts: action(() =>
      import("~/app/purchases/section-actions").then((m) => ({
        default: m.LinkProductsAction,
      })),
    ),
  },
  expense: {
    splitExpense: action(() =>
      import("~/app/expenses/section-actions").then((m) => ({
        default: m.SplitExpenseAction,
      })),
    ),
    receiveExpense: action(() =>
      import("~/app/expenses/section-actions").then((m) => ({
        default: m.ReceiveExpenseAction,
      })),
    ),
  },
  vendorAccount: {
    searchCharges: action(() =>
      import("~/app/vendors/charge-search").then((m) => ({
        default: m.SearchChargesAction,
      })),
    ),
  },
} satisfies {
  [E in GenericDetailEntity]?: Partial<
    Record<SectionActionId, LazyExoticComponent<SectionActionComponent<E>>>
  >;
};

/** One entity's verbs through the erased map the page walks. */
export const sectionActionsFor = (
  entity: string,
): Readonly<
  Partial<
    Record<SectionActionId, LazyExoticComponent<SectionActionComponent<never>>>
  >
> => {
  if (!Object.hasOwn(sectionActions, entity)) return {};
  // SAFETY: `hasOwn` proves `entity` is one of the registry's own keys. The erased components
  // are rendered only with the record loaded for this same entity.
  return sectionActions[entity as keyof typeof sectionActions] as Readonly<
    Partial<
      Record<
        SectionActionId,
        LazyExoticComponent<SectionActionComponent<never>>
      >
    >
  >;
};
