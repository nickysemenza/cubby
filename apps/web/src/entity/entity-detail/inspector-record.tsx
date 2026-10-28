import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
import { RecordSuggestionsProvider } from "~/entity/suggestions/record-suggestions";
import { RecordWorkQueue } from "~/entity/work-queue/record-work-queue";
import { FactsAddProvider, FactsDensityProvider } from "~/ui/common/facts";
import { Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { detailEditOverrideFor } from "./detail-edit-overrides";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { DetailSummary } from "./detail-summary";
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
  onRecordResolved,
  onNameResolved,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  onRecordResolved: (record: EntityActionRow | undefined) => void;
  onNameResolved: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
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
  const fieldSections = presentation.detail.sections.filter(
    (section) => section.kind === "fields",
  );
  const fields = metadata.fields.fields
    .filter((field) => field.display.detail)
    .map((field) => field.key);
  return (
    <>
      {/* Identity facts and the record's one edit verb share the first row. */}
      <div className="mb-3 flex min-w-0 items-start gap-2 empty:hidden">
        {editable ? (
          <Button
            variant="outline"
            size="xs"
            className="ms-auto shrink-0"
            onClick={() => setEditing(true)}
          >
            Edit record
          </Button>
        ) : null}
      </div>
      <DetailSummary entity={entity} record={record} compact />
      <RecordSuggestionsProvider
        entity={entity}
        records={[record]}
        fieldKeys={fields}
      >
        <RecordQualityProvider
          entity={entity}
          id={record.id}
          visibleFields={fields}
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
      </RecordSuggestionsProvider>
    </>
  );
}

export function InspectorRecord<E extends GenericDetailEntity>(props: {
  entity: E;
  id: string;
  onRecordResolved: (record: EntityActionRow | undefined) => void;
  onNameResolved: (name: string) => void;
}) {
  const metadata = useEntityMetadata(props.entity);
  const query = useQuery(entityDetailFor(props.entity).queryOptions(props.id));
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
