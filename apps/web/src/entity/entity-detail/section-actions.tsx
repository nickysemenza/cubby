import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { SectionActionId } from "@cubby/schemas/entity-section-actions";
import type { FunctionComponent, LazyExoticComponent } from "react";

import { featureRegistry } from "~/entity/feature-registry";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

interface SectionActionProps<E extends GenericDetailEntity> {
  record: DetailRecordOf<E>;
  /** The server's word on the verb: its label and why it is unavailable. */
  action: NonNullable<
    Extract<ReportBlock, { kind: "records" }>["verbs"]
  >[number];
}

export type SectionActionComponent<E extends GenericDetailEntity> =
  FunctionComponent<SectionActionProps<E>>;

/**
 * The web run of every verb a `summary` or `recordList` section declares. Web implements them
 * all (native classifies the rest in `native-coverage.ts`); each calls the operation the verb
 * names, behind the server's `disabledReason`, never a rule of its own. `features/registry.tsx`
 * fills it.
 */
export type SectionActionTable = {
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
  const sectionActions = featureRegistry().sectionActions;
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
