import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";

import type { EntityActionRow } from "~/entity/actions/entity-actions";
import { detailEditRequest } from "~/entity/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entity/editing/entity-edit-dialog";
import type { EditableEntity } from "~/entity/editing/types";
import { isGeneratedBrowserCrudEntity } from "~/entity/entity-contracts";
import { entityDetailFor } from "~/entity/entity-detail";
import { RecordMachineryHeader } from "~/entity/machinery/record-machinery";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import { PreviewQuery } from "~/entity/preview/preview-query";
import { Button } from "~/ui/primitives/button";

import { detailEditOverrideFor } from "./detail-edit-overrides";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { RecordDetailBody } from "./generic-entity-detail";

function presentationEditable(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
  hasOverride: boolean,
) {
  const actions: readonly string[] = entityMetadata(queryClient, entity).summary
    .detail.hero.actions;
  return (
    actions.includes("edit") &&
    (hasOverride || isGeneratedBrowserCrudEntity(entity))
  );
}

function ResolvedInspectorRecord<E extends GenericDetailEntity>({
  entity,
  record,
  editSlot,
  onRecordResolved,
  onNameResolved,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  editSlot: HTMLElement | null;
  onRecordResolved: (record: EntityActionRow | undefined) => void;
  onNameResolved: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const [editing, setEditing] = useState(false);
  const EditOverride = detailEditOverrideFor(entity);
  const editable = presentationEditable(
    queryClient,
    entity,
    EditOverride !== undefined,
  );
  // SAFETY: the generated CRUD guard proves this entity owns update:full;
  // the request builder uses the same entity's record and validated registry.
  const editRequest =
    isGeneratedBrowserCrudEntity(entity) && !EditOverride && editing
      ? (detailEditRequest(
          queryClient,
          entity as EditableEntity,
          record as never,
        ) as EntityEditDialogRequest<EditableEntity>)
      : null;
  const presentation = entityMetadata(queryClient, entity).summary;
  const name = z.record(z.string(), z.unknown()).parse(record)[
    presentation.titleField
  ];
  useEffect(() => {
    onRecordResolved(record);
    onNameResolved(typeof name === "string" ? name : record.id);
  }, [record, name, onRecordResolved, onNameResolved]);
  return (
    <>
      {editable && editSlot
        ? createPortal(
            <Button
              variant="outline"
              size="xs"
              onClick={() => setEditing(true)}
            >
              Edit record
            </Button>,
            editSlot,
          )
        : null}
      <div className="px-2 empty:hidden">
        <RecordMachineryHeader entity={entity} id={record.id} />
      </div>
      {/* The record page's cards in one narrow column: summary, Needs you,
          facts, section cards and ledger rows. */}
      <RecordDetailBody
        entity={entity}
        record={record}
        onEdit={editable ? () => setEditing(true) : null}
        variant="inspector"
      />
      {EditOverride && editing ? (
        <EditOverride
          record={
            // SAFETY: the override registry returns this entity's record editor.
            record as never
          }
          onClose={() => setEditing(false)}
        />
      ) : null}
      {editRequest ? (
        <EntityEditDialog
          open
          onOpenChange={setEditing}
          request={editRequest}
        />
      ) : null}
    </>
  );
}

export function InspectorRecord<E extends GenericDetailEntity>(props: {
  entity: E;
  id: string;
  editSlot: HTMLElement | null;
  /** The read finished, so the header stops claiming the record is loading. */
  onSettled: () => void;
  onRecordResolved: (record: EntityActionRow | undefined) => void;
  onNameResolved: (name: string) => void;
}) {
  const metadata = useEntityMetadata(props.entity);
  const query = useQuery(entityDetailFor(props.entity).queryOptions(props.id));
  const { onSettled } = props;
  const settled = !query.isLoading;
  useEffect(() => {
    if (settled) onSettled();
  }, [settled, onSettled]);
  return (
    <PreviewQuery
      query={query}
      label={metadata.summary.singular}
      onUnavailable={props.onRecordResolved}
    >
      {(record) => <ResolvedInspectorRecord {...props} record={record} />}
    </PreviewQuery>
  );
}
