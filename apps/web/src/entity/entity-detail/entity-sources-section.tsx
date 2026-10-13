import type { ConnectedRecordsPreviewOutput } from "@cubby/schemas/connected-records";
import { connectedViews } from "@cubby/schemas/connected-views";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  entitySourceRead,
  type EntitySourceRead,
} from "@cubby/schemas/entity-source";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { entityGraph } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatTimestamp } from "~/lib/date-format";
import { DateDisplay } from "~/ui/common/date-display";
import type { RecordListState } from "~/ui/common/record-list";
import { RecordList, RecordRow, RecordMore } from "~/ui/common/record-list";
import {
  useSectionCount,
  useSectionEmpty,
} from "~/ui/data-table/detail-section-state";
import { Badge } from "~/ui/primitives/badge";

import { SourceTargetLink } from "../source-target-link";
import { RecordPaths } from "./connected-records-table";

/** Dates arrive serialized on some transports; the read shape otherwise matches. */
const sourceList = z.array(
  entitySourceRead.extend({
    observedAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
  }),
);
type Source = z.infer<typeof sourceList>[number];

export const recordSources = (record: unknown): Source[] =>
  sourceList
    .catch([])
    .parse(
      z
        .looseObject({ sources: z.unknown() })
        .catch({ sources: [] })
        .parse(record).sources ?? [],
    );

const recorderLabel = (recorder: Source["recorder"]) =>
  [recorder.runId, recorder.oauthClientId, recorder.channel]
    .filter(Boolean)
    .join(" · ");

function Citation({ source, entity }: { source: Source; entity: Entity }) {
  const field = entityFieldModels[entity].fields.find(
    (field) => field.key === source.fieldPath,
  );
  return (
    <div className="grid gap-1 py-1">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">
          {source.fieldPath ? (field?.label ?? source.fieldPath) : "Record"}
        </span>
        {source.fieldPath ? (
          <Badge variant={source.supportsCurrentValue ? "positive" : "slate"}>
            {source.supportsCurrentValue ? "Current value" : "Earlier value"}
          </Badge>
        ) : null}
        {source.selectedVariant ? (
          <Badge variant="outline">{source.selectedVariant}</Badge>
        ) : null}
        <span
          className="text-muted-foreground"
          title={`Recorded ${formatTimestamp(source.createdAt)} by ${recorderLabel(source.recorder)}`}
        >
          {source.observedAt ? "Seen " : null}
          <DateDisplay timestamp={source.observedAt ?? source.createdAt} />
        </span>
      </div>
      {source.quote ? (
        <blockquote className="border-l border-border pl-2 text-xs/5 text-muted-foreground">
          {source.quote}
        </blockquote>
      ) : null}
    </div>
  );
}

/** Sources group citations by document; related documents never imply field verification. */
type SourceSectionProps = {
  entity: Entity;
  sourceId: string;
  sources: readonly Source[];
};
const emptyViews: ConnectedRecordsPreviewOutput["views"] = [];
const successState: RecordListState = { status: "success" };

export function EntitySourcesSection(props: SourceSectionProps) {
  return connectedViews[props.entity].some(
    (view) => "evidence" in view && view.evidence,
  ) ? (
    <RelatedEntitySourcesSection {...props} />
  ) : (
    <EntitySourcesList {...props} views={emptyViews} state={successState} />
  );
}

function RelatedEntitySourcesSection(props: SourceSectionProps) {
  const query = useQuery(
    entityGraph.connectedRecordsPreview.queryOptions({
      source: { entityKind: props.entity, entityId: props.sourceId },
      limit: 3,
    }),
  );
  const state: RecordListState = query.isPending
    ? { status: "pending", rows: 1 }
    : query.isError
      ? {
          status: "error",
          title: "related sources",
          error: query.error,
          onRetry: () => void query.refetch(),
        }
      : successState;
  return (
    <EntitySourcesList
      {...props}
      views={query.data?.views ?? emptyViews}
      state={state}
    />
  );
}

function EntitySourcesList({
  entity,
  sourceId,
  sources,
  views: allViews,
  state,
}: SourceSectionProps & {
  views: ConnectedRecordsPreviewOutput["views"];
  state: RecordListState;
}) {
  const groups = new Map<
    string,
    {
      target: Pick<EntitySourceRead, "sourceEntity" | "url">;
      citations: Source[];
      paths: Parameters<typeof RecordPaths>[0]["paths"];
    }
  >();
  for (const [index, source] of sources.entries()) {
    const key = source.sourceEntity
      ? `${source.sourceEntity.entityKind}:${source.sourceEntity.entityId}`
      : (source.url ?? `citation:${index}`);
    const group = groups.get(key) ?? {
      target: source,
      citations: [],
      paths: [],
    };
    group.citations.push(source);
    groups.set(key, group);
  }
  const views = allViews.filter((view) => view.evidence);
  for (const view of views)
    for (const item of view.items) {
      const key = `${item.target.entityKind}:${item.target.entityId}`;
      const group = groups.get(key) ?? {
        target: {
          sourceEntity: {
            ...item.target,
            entityId: z
              .string()
              .pipe(entitySourceRead.shape.sourceEntity.unwrap().shape.entityId)
              .parse(item.target.entityId),
            name: item.target.label,
            deleted: false,
          },
          url: null,
        },
        citations: [],
        paths: [],
      };
      group.paths.push(...item.paths);
      groups.set(key, group);
    }
  useSectionCount(
    state.status === "success"
      ? groups.size +
          views.reduce(
            (count, view) => count + view.totalCount - view.items.length,
            0,
          )
      : undefined,
  );
  useSectionEmpty(state.status === "success" && groups.size === 0);
  return (
    <>
      <RecordList
        aria-label="Sources"
        empty={state.status === "success" ? "No sources." : undefined}
      >
        {[...groups].map(([key, group]) => (
          <RecordRow
            key={key}
            primary={
              group.target.sourceEntity || group.target.url ? (
                <SourceTargetLink source={group.target} />
              ) : (
                `by ${group.citations[0] ? recorderLabel(group.citations[0].recorder) : "unknown recorder"}`
              )
            }
            secondary={
              group.paths.length ? (
                <span className="text-xs text-muted-foreground">
                  Related evidence
                </span>
              ) : null
            }
            detail={
              <>
                {group.paths.length ? (
                  <RecordPaths paths={group.paths} />
                ) : null}
                {group.citations.map((source) => (
                  <Citation
                    key={[
                      source.createdAt.toISOString(),
                      source.fieldPath,
                      source.quote,
                      source.selectedVariant,
                      source.observedAt?.toISOString(),
                    ].join("|")}
                    source={source}
                    entity={entity}
                  />
                ))}
              </>
            }
          />
        ))}
        {views
          .filter((view) => view.totalCount > view.items.length)
          .map((view) => (
            <RecordMore
              key={view.viewKey}
              label={`${view.totalCount - view.items.length} more ${view.title.toLowerCase()}`}
              link={{
                to: "/connections",
                search: { source: entity, id: sourceId, view: view.viewKey },
              }}
            />
          ))}
      </RecordList>
      {state.status !== "success" ? (
        <RecordList aria-label="Related sources" state={state} />
      ) : null}
    </>
  );
}
