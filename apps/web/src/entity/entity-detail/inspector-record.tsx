import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import type { EntityActionRow } from "~/entity/actions/entity-actions";
import { detailFieldRenderersFor } from "~/entity/display/detail-field-renderers";
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
import { PreviewQuery } from "~/entity/preview/preview-query";
import { readPathValue } from "~/entity/read-path";
import { RecordSuggestionsProvider } from "~/entity/suggestions/record-suggestions";
import { useTaskRecordProjection } from "~/entity/task-record-transactions";
import { RecordWorkQueue } from "~/entity/work-queue/record-work-queue";
import { FactsAddProvider, FactsDensityProvider } from "~/ui/common/facts";
import { KeyNumbers } from "~/ui/common/key-numbers";
import { Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { detailEditOverrideFor } from "./detail-edit-overrides";
import { detailHeroStats } from "./detail-hero-stats";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { EntityRecordFields } from "./entity-record-fields";
import {
  fieldQualityChecks,
  QualitySectionChecks,
  type RecordQualityCheck,
  RecordQualityProvider,
  useFieldQuality,
  useQualityCheckSections,
} from "./record-quality";

type DisplayField = EntityFieldModel["fields"][number];
type FieldSection = { id: string; title: string; fields: readonly string[] };

function presentationEditable(
  entity: GenericDetailEntity,
  hasOverride: boolean,
) {
  const actions: readonly string[] = entitySummary[entity].detail.hero.actions;
  return (
    actions.includes("edit") &&
    (hasOverride || isGeneratedBrowserCrudEntity(entity))
  );
}

const isBlank = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/**
 * Whether a declared field section would render nothing but dashes: every
 * field's stored value is blank, none can be added or edited in place, no
 * domain renderer owns one, and no check is placed on the section or its
 * fields. Undeclared or renderer-only fields count as content.
 */
function isEmptyFieldSection<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
  section: FieldSection,
  {
    editable,
    checkSections,
    checks,
  }: {
    editable: boolean;
    checkSections: readonly string[];
    checks: readonly RecordQualityCheck[];
  },
) {
  if (checkSections.includes(section.id)) return false;
  const model: EntityFieldModel = entityFieldModels[entity];
  const updateRoster: readonly string[] = model.update;
  const crud = isGeneratedBrowserCrudEntity(entity);
  const renderers = detailFieldRenderersFor(entity) ?? {};
  const fields: readonly DisplayField[] = model.fields;
  return section.fields.every((key) => {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field || key in renderers) return false;
    if (fieldQualityChecks(checks, key).length > 0) return false;
    if (field.control && (editable || (crud && updateRoster.includes(key))))
      return false;
    const path = field.display.readPath ?? field.readKey;
    return path !== null && isBlank(readPathValue(record, path));
  });
}

/** The declared field sections with content, each under a hairline. */
function InspectorFieldSections<E extends GenericDetailEntity>({
  entity,
  record,
  sections,
  editable,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  sections: readonly FieldSection[];
  editable: boolean;
}) {
  const checkSections = useQualityCheckSections();
  const checks = useFieldQuality(entity, record.id)?.checks ?? [];
  return sections
    .filter(
      (section) =>
        !isEmptyFieldSection(entity, record, section, {
          editable,
          checkSections,
          checks,
        }),
    )
    .map((section) => (
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
  const sections = entitySummary[entity].detail.sections;
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
  const [editing, setEditing] = useState(false);
  const EditOverride = detailEditOverrideFor(entity);
  const editable = presentationEditable(entity, EditOverride !== undefined);
  // SAFETY: the generated CRUD guard proves this entity owns update:full;
  // the request builder uses the same entity's record and validated registry.
  const editRequest =
    isGeneratedBrowserCrudEntity(entity) && !EditOverride && editing
      ? (detailEditRequest(
          entity as EditableEntity,
          record as never,
        ) as EntityEditDialogRequest<EditableEntity>)
      : null;
  const presentation = entitySummary[entity];
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
  const fields = entityFieldModels[entity].fields
    .filter((field) => field.display.detail)
    .map((field) => field.key);
  return (
    <>
      {/* Identity facts and the record's one edit verb share the first row. */}
      <div className="mb-3 flex min-w-0 items-start gap-2 empty:hidden">
        <KeyNumbers
          layout="inline"
          label="Key numbers"
          items={detailHeroStats(entity, record)}
          className="flex-1"
          data-testid="inspector-key-numbers"
        />
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
                  editable={editable}
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
  const serverQuery = useQuery(
    entityDetailFor(props.entity).queryOptions(props.id),
  );
  const records = useMemo(
    () => (serverQuery.data ? [serverQuery.data] : []),
    [serverQuery.data],
  );
  const projected = useTaskRecordProjection(props.entity, records);
  const query = { ...serverQuery, data: projected[0] ?? serverQuery.data };
  return (
    <PreviewQuery
      query={query}
      label={entitySummary[props.entity].singular}
      onUnavailable={props.onRecordResolved}
    >
      {(record) => <ResolvedInspectorRecord {...props} record={record} />}
    </PreviewQuery>
  );
}
