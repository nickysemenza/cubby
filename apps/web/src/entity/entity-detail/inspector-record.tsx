import {
  dataCheckPresentation,
  dataChecksByEntity,
  scoredEntities,
} from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { useQuery } from "@tanstack/react-query";
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
import { RecordSuggestionsProvider } from "~/features/ai/record-suggestions";
import { SectionHeading, Stack } from "~/ui/layout";
import { PreviewQuery } from "~/ui/preview/preview-query";
import { Button } from "~/ui/primitives/button";

import { detailEditOverrideFor } from "./detail-edit-overrides";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { EntityRecordFields } from "./entity-record-fields";
import { RecordQualityProvider, QualitySectionChecks } from "./record-quality";

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
  const parsed = z.enum(scoredEntities).safeParse(entity);
  const checkSections = parsed.success
    ? [
        ...new Set(
          dataChecksByEntity[parsed.data].options.flatMap((check) => {
            const placement = dataCheckPresentation[check].placement;
            return placement && "section" in placement
              ? [placement.section]
              : [];
          }),
        ),
      ]
    : [];
  const fields = entityFieldModels[entity].fields
    .filter((field) => field.display.detail)
    .map((field) => field.key);
  return (
    <RecordSuggestionsProvider
      entity={entity}
      records={[record]}
      fieldKeys={fields}
    >
      <RecordQualityProvider entity={entity} id={record.id}>
        <Stack gap="md">
          {editable ? (
            <div>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setEditing(true)}
              >
                Edit record
              </Button>
            </div>
          ) : null}
          {fieldSections.map((section) => (
            <section key={section.id} className="min-w-0">
              <SectionHeading title={section.title} />
              <QualitySectionChecks section={section.id} />
              <EntityRecordFields
                entity={entity}
                record={record}
                fields={section.fields}
              />
            </section>
          ))}
          {checkSections
            .filter((id) => !fieldSections.some((section) => section.id === id))
            .map((id) => {
              const section = presentation.detail.sections.find(
                (section) => section.id === id,
              );
              return (
                <section key={id} className="min-w-0">
                  <SectionHeading
                    title={
                      section?.title ?? (id === "images" ? "Images" : "Sources")
                    }
                    actions={
                      isBrowserRoutedEntity(entity) ? (
                        <Link
                          to={entities[entity].routes.detail}
                          params={entityDetailParams(record.id)}
                          hash={id}
                          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        >
                          Open section
                        </Link>
                      ) : null
                    }
                  />
                  <QualitySectionChecks section={id} />
                </section>
              );
            })}
        </Stack>
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
  );
}

export function InspectorRecord<E extends GenericDetailEntity>(props: {
  entity: E;
  id: string;
  onRecordResolved: (record: EntityActionRow | undefined) => void;
  onNameResolved: (name: string) => void;
}) {
  const query = useQuery(entityDetailFor(props.entity).queryOptions(props.id));
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
