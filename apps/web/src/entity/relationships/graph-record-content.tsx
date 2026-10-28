import type { EntityGraphNode } from "@cubby/schemas/entity-graph";
import { useQueryClient } from "@tanstack/react-query";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityPreviewFacts,
  renderCompactFieldValue,
} from "~/entity/display/entity-display";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { useEntityMetadata } from "~/entity/metadata";
import { QuerySection } from "~/ui/feedback/query-section";
import { Image } from "~/ui/primitives/image";

/** All graph links use already hydrated identity and cover; hover resolves detail on demand. */
export function GraphRecordLink({
  node,
}: {
  node: EntityGraphNode;
  compact?: boolean;
}) {
  return isBrowserRoutedEntity(node.entityKind) ? (
    <EntityRefLink
      entity={node.entityKind}
      id={node.entityId}
      name={node.label}
      displayImage={node.image ?? null}
      emoji={null}
    />
  ) : (
    <span>{node.label}</span>
  );
}

function LoadedGraphRecordFacts({
  node,
  limit = 8,
}: {
  node: EntityGraphNode;
  limit?: number;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata(node.entityKind);
  const record = node.preview ?? {};
  const facts = entityPreviewFacts(
    queryClient,
    node.entityKind,
    record,
    limit,
    {
      singleLine: true,
    },
  );
  return facts.length ? (
    <dl className="graph-record-facts nodrag nopan">
      {facts.slice(0, limit).map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}

function LoadedGraphRecordContent({
  node,
  compact = false,
}: {
  node: EntityGraphNode;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(node.entityKind);
  const chip = metadata.fields.fields.find(
    (field) => field.key === metadata.summary.detail.hero.chip,
  );
  return (
    <>
      <div className="graph-record-identity" data-compact={compact}>
        {node.image ? (
          <Image
            src={node.image.url}
            alt=""
            displayWidth={compact ? 40 : 56}
            className={
              compact
                ? "size-10 shrink-0 rounded object-contain"
                : "size-14 shrink-0 rounded object-contain"
            }
          />
        ) : null}
        <div className="min-w-0">
          <div
            className="line-clamp-2 text-sm font-semibold"
            title={node.label}
          >
            {node.label}
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
            {chip && node.preview
              ? renderCompactFieldValue(
                  queryClient,
                  node.entityKind,
                  node.preview,
                  chip,
                )
              : node.entityId}
          </div>
        </div>
      </div>
      <GraphRecordFacts node={node} limit={compact ? 2 : 8} />
    </>
  );
}

export function GraphRecordFacts(
  props: Parameters<typeof LoadedGraphRecordFacts>[0],
) {
  return (
    <QuerySection
      title="Record facts"
      resetKey={props.node.entityId}
      fallback={null}
    >
      <LoadedGraphRecordFacts {...props} />
    </QuerySection>
  );
}

export function GraphRecordContent(
  props: Parameters<typeof LoadedGraphRecordContent>[0],
) {
  return (
    <QuerySection
      title="Record"
      resetKey={props.node.entityId}
      fallback={<GraphRecordLink node={props.node} />}
    >
      <LoadedGraphRecordContent {...props} />
    </QuerySection>
  );
}
