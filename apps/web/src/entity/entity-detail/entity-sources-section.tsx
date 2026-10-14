import type { ConnectedRecordsPreviewOutput } from "@cubby/schemas/connected-records";
import { connectedViews } from "@cubby/schemas/connected-views";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  entitySourceRead,
  type EntitySourceRead,
} from "@cubby/schemas/entity-source";
import { countLabel } from "@cubby/shared/pluralize";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";

import { entityGraph } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatTimestamp } from "~/lib/date-format";
import { DateDisplay } from "~/ui/common/date-display";
import type { RecordListState } from "~/ui/common/record-list";
import {
  RecordDetail,
  RecordList,
  RecordMore,
  RecordRow,
} from "~/ui/common/record-list";
import {
  useSectionCount,
  useSectionEmpty,
} from "~/ui/data-table/detail-section-state";

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

/** When the group's document was last seen; citations without an observation use their record time. */
const latestSeen = (citations: readonly Source[]) =>
  citations
    .map((source) => source.observedAt ?? source.createdAt)
    .reduce<Date | null>(
      (latest, at) => (latest === null || at > latest ? at : latest),
      null,
    );

const recorderLabel = (recorder: Source["recorder"]) =>
  [recorder.runId, recorder.oauthClientId, recorder.channel]
    .filter(Boolean)
    .join(" · ");

const fieldLabel = (entity: Entity, source: Source) =>
  source.fieldPath
    ? (entityFieldModels[entity].fields.find(
        (field) => field.key === source.fieldPath,
      )?.label ?? source.fieldPath)
    : "Record";

/** What a document supports, in one line: its cited fields, earlier values named as such. */
function Supports({
  entity,
  citations,
  related,
}: {
  entity: Entity;
  citations: readonly Source[];
  related: ReactNode;
}) {
  const current = new Set<string>();
  const earlier = new Set<string>();
  for (const source of citations)
    (source.fieldPath && !source.supportsCurrentValue ? earlier : current).add(
      fieldLabel(entity, source),
    );
  for (const label of current) earlier.delete(label);
  const parts = [
    ...(current.size ? [[...current].join(", ")] : []),
    ...(earlier.size ? [`earlier ${[...earlier].join(", ")}`] : []),
  ];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1">
      {parts.length ? (
        <span className="text-foreground">{parts.join(" · ")}</span>
      ) : null}
      {parts.length && related ? <span aria-hidden> · </span> : null}
      {related}
    </span>
  );
}

/** One quote under its document: the field it supports, the variant seen, and when. */
function Citation({ source, entity }: { source: Source; entity: Entity }) {
  return (
    <div className="grid gap-0.5 py-1">
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
        <span className="font-medium text-foreground">
          {fieldLabel(entity, source)}
        </span>
        {source.fieldPath && !source.supportsCurrentValue ? (
          <span>earlier value</span>
        ) : null}
        {source.selectedVariant ? (
          <span>· {source.selectedVariant}</span>
        ) : null}
        <span
          title={`Recorded ${formatTimestamp(source.createdAt)} by ${recorderLabel(source.recorder)}`}
        >
          · {source.observedAt ? "Seen " : "Recorded "}
          <DateDisplay
            timestamp={source.observedAt ?? source.createdAt}
            clock="day"
          />
        </span>
      </div>
      {source.quote ? (
        <blockquote className="border-l border-border pl-2 text-muted-foreground">
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
        {[...groups].map(([key, group]) => {
          const seen = latestSeen(group.citations);
          const target = group.target.sourceEntity;
          return (
            <RecordRow
              key={key}
              primary={
                group.target.sourceEntity || group.target.url ? (
                  <>
                    <SourceTargetLink source={group.target} />
                    {target ? (
                      <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                        {target.entityId}
                      </span>
                    ) : null}
                  </>
                ) : (
                  `by ${group.citations[0] ? recorderLabel(group.citations[0].recorder) : "unknown recorder"}`
                )
              }
              secondary={
                <Supports
                  entity={entity}
                  citations={group.citations}
                  related={
                    group.paths.length ? (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        Related
                        <RecordPaths paths={group.paths} compact />
                      </span>
                    ) : null
                  }
                />
              }
              trailing={
                seen ? (
                  <>
                    Seen <DateDisplay timestamp={seen} clock="day" />
                  </>
                ) : null
              }
              detail={
                group.citations.some((source) => source.quote) ? (
                  <RecordDetail
                    summary={countLabel(
                      group.citations.filter((source) => source.quote).length,
                      "quote",
                    )}
                    defaultOpen={groups.size === 1}
                  >
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
                  </RecordDetail>
                ) : null
              }
            />
          );
        })}
        {views
          .filter((view) => view.totalCount > view.items.length)
          .map((view) => (
            <RecordMore
              key={view.viewKey}
              label={countLabel(
                view.totalCount - view.items.length,
                `more ${view.title.toLowerCase()}`,
              )}
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
