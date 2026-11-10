import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { isGeneratedBrowserCrudEntity } from "~/entity/entity-contracts";
import { entityDetailFor } from "~/entity/entity-detail";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import { PreviewQuery } from "~/entity/preview/preview-query";
import { RecordWorkQueue } from "~/entity/work-queue/record-work-queue";
import { Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { FactsAddProvider, FactsDensityProvider } from "~/ui/records/facts";

import { detailEditOverrideFor } from "./detail-edit-overrides";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { DetailSummary, detailSectionFields } from "./detail-summary";
import { EntityRecordFields } from "./entity-record-fields";
import {
  QualitySectionChecks,
  RecordQualityProvider,
  useQualityCheckSections,
} from "./record-quality";

type FieldSection = { id: string; title: string; fields: readonly string[] };

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

/** Keep every declared field section visible, including missing values. */
function InspectorFieldSections<E extends GenericDetailEntity>({
  entity,
  record,
  sections,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  sections: readonly FieldSection[];
}) {
  return sections.map((section) => (
    <Section key={section.id} headingAs="h3" compact title={section.title}>
      <QualitySectionChecks section={section.id} />
      <EntityRecordFields
        entity={entity}
        record={record}
        fields={section.fields}
      />
    </Section>
  ));
}

/** Sections only the record's evaluated checks bring into the inspector. */
function InspectorCheckSections({
  entity,
  id,
  fieldSections,
}: {
  entity: GenericDetailEntity;
  id: string;
  fieldSections: readonly string[];
}) {
  const sections = useEntityMetadata(entity).summary.detail.sections;
  return useQualityCheckSections()
    .filter((section) => !fieldSections.includes(section))
    .map((sectionId) => (
      <Section
        key={sectionId}
        headingAs="h3"
        compact
        title={
          sections.find((section) => section.id === sectionId)?.title ??
          (sectionId === "images" ? "Images" : sectionId)
        }
        actions={
          isBrowserRoutedEntity(entity) ? (
            <Link
              to={entities[entity].routes.detail}
              params={entityDetailParams(id)}
              hash={sectionId}
              className="text-link hover:underline"
            >
              Open section
            </Link>
          ) : null
        }
      >
        <QualitySectionChecks section={sectionId} />
      </Section>
    ));
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
  // The summary and the title above already show these; a section left with
  // no facts disappears rather than printing a bare heading.
  const fieldSections = presentation.detail.sections.flatMap((section) => {
    if (section.kind !== "fields") return [];
    const shown = detailSectionFields(
      queryClient,
      entity,
      record,
      section.fields,
      { omitTitle: true },
    );
    return shown.length > 0 ? [{ ...section, fields: shown }] : [];
  });
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
      <DetailSummary entity={entity} record={record} compact />
      <RecordQualityProvider
        entity={entity}
        id={record.id}
        visibleFields={fieldSections.flatMap((section) => section.fields)}
      >
        <FactsDensityProvider density="compact">
          <FactsAddProvider onAdd={editable ? () => setEditing(true) : null}>
            <Stack gap="md">
              {/* Work rows are not all warnings: the citron rule is the
                    sparse needs-input signal, absent with no work. */}
              <div className="border-s border-signal ps-3 empty:hidden">
                <RecordWorkQueue id={record.id} />
              </div>
              <InspectorFieldSections
                entity={entity}
                record={record}
                sections={fieldSections}
              />
              <InspectorCheckSections
                entity={entity}
                id={record.id}
                fieldSections={fieldSections.map((section) => section.id)}
              />
            </Stack>
          </FactsAddProvider>
        </FactsDensityProvider>
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
      </RecordQualityProvider>
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
