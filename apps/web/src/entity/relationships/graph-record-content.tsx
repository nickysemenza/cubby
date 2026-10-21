import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { EntityGraphNode } from "@cubby/schemas/entity-graph";
import { entitySummary } from "@cubby/schemas/entity-summary";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityPreviewFacts,
  renderCompactFieldValue,
} from "~/entity/display/entity-display";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { Image } from "~/ui/primitives/image";

/** All graph links use already hydrated identity and cover; hover resolves detail on demand. */
export function GraphRecordLink({
  node,
  compact = false,
}: {
  node: EntityGraphNode;
  compact?: boolean;
}) {
  return isBrowserRoutedEntity(node.entityKind) ? (
    <EntityRefLink
      variant="chip"
      compact={compact}
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

export function GraphRecordFacts({ node }: { node: EntityGraphNode }) {
  const record = node.preview ?? {};
  const facts = entityPreviewFacts(node.entityKind, record, 8);
  return facts.length ? (
    <dl className="graph-record-facts">
      {facts.slice(0, 8).map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}

export function GraphRecordContent({ node }: { node: EntityGraphNode }) {
  const chip = entityFieldModels[node.entityKind].fields.find(
    (field) => field.key === entitySummary[node.entityKind].detail.hero.chip,
  );
  return (
    <>
      <div className="graph-record-identity">
        {node.image ? (
          <Image
            src={node.image.url}
            alt=""
            displayWidth={56}
            className="size-14 shrink-0 rounded object-contain"
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
              ? renderCompactFieldValue(node.entityKind, node.preview, chip)
              : node.entityId}
          </div>
        </div>
      </div>
      <GraphRecordFacts node={node} />
    </>
  );
}
