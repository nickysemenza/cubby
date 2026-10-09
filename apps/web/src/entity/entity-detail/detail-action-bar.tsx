import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { slotActionsOf } from "@cubby/schemas/entity-report";
import { Suspense } from "react";

import { entitySummaryOf } from "~/entity/entity-model";

import { DetailActionScope } from "./detail-action-context";
import { useDetailHooks } from "./detail-hooks";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { ReportVerb } from "./records-block";

/**
 * The detail header's action target: the entity's specialist header controls
 * (its hook module's `headerActions`) and the collection verbs its declared
 * report slots offer.
 */
export function DetailActionTarget<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const Custom = useDetailHooks().headerActions;
  // SAFETY: the hooks belong to this page's entity, whose loaded record this is.
  const customRecord = record as never;
  return (
    <DetailActionScope>
      <fieldset
        aria-label="Entity actions"
        className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden"
      >
        <Suspense fallback={null}>
          {Custom ? <Custom record={customRecord} /> : null}
          <ReportCollectionActions entity={entity} record={record} />
        </Suspense>
      </fieldset>
    </DetailActionScope>
  );
}

function ReportCollectionActions<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const presentation: CompiledEntityPresentation = entitySummaryOf(entity);
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
