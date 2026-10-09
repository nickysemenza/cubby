import type { EntityRef } from "@cubby/schemas/entity";
import type {
  EntityRecommendationGroup,
  EntityRecommendationsOut,
  ExpenseProjectProposal,
} from "@cubby/schemas/entity-recommendations";
import type { InventoryPlacementProposal } from "@cubby/schemas/entity-recommendations";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { LightbulbIcon } from "@phosphor-icons/react/dist/csr/Lightbulb";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityDisplayImageKey,
  type EntityDisplayImagesQueryOptions,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { RelatedProductRow } from "~/entity/relatedness/related-product-row";
import { entityMedia } from "~/integrations/tanstack-query/generated/entity-media.gen";
import { recommendations } from "~/integrations/tanstack-query/generated/recommendations.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydratedLoading } from "~/ui/hooks/useHydrated";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

type ExpenseGroup = Extract<
  EntityRecommendationGroup,
  { kind: "expense-project" }
>;
type InventoryGroup = Extract<
  EntityRecommendationGroup,
  { kind: "inventory-placement" }
>;

export interface EntityRecommendationOperations {
  forEntity: typeof recommendations.forEntity;
  displayImages?: EntityDisplayImagesQueryOptions;
}

const productionDisplayImages: EntityDisplayImagesQueryOptions = (input) =>
  entityMedia.displayImages.queryOptions(input);

const productionOperations: EntityRecommendationOperations = {
  forEntity: recommendations.forEntity,
  displayImages: productionDisplayImages,
};

interface EntityRecommendationsProps {
  source: EntityRef;
  operations?: EntityRecommendationOperations;
  compact?: boolean;
  onAcceptExpenseProject?: (proposal: ExpenseProjectProposal) => Promise<void>;
  onAcceptInventoryPlacement?: (
    proposal: InventoryPlacementProposal,
  ) => Promise<void>;
  pending?: boolean;
}

type SelectedProposal = {
  key: string;
  basisKey: string;
  sourceKey: string;
};

/**
 * Shared proposal surface for detail-page Relationships and inline workbenches.
 * A proposal remains read-only until its review row's explicit Apply action.
 */
export function EntityRecommendations({
  source,
  operations = productionOperations,
  compact = false,
  onAcceptExpenseProject,
  onAcceptInventoryPlacement,
  pending = false,
}: EntityRecommendationsProps) {
  const query = useQuery(
    operations.forEntity.queryOptions({
      entityKind: source.entityKind,
      entityId: source.entityId,
    }),
  );
  const [selected, setSelected] = useState<SelectedProposal | null>(null);
  const basisKey = query.data?.basisKey;
  const sourceKey = `${source.entityKind}:${source.entityId}`;
  const loading = useHydratedLoading(query.isPending);
  const data = query.data;
  const dataIsCurrent =
    data !== undefined &&
    `${data.source.entityKind}:${data.source.entityId}` === sourceKey;
  const groups = useMemo(
    () =>
      dataIsCurrent
        ? data.groups.filter(
            (group) => group.proposals.length > 0 || group.status !== "ready",
          )
        : [],
    [data, dataIsCurrent],
  );
  const imageRefs = useMemo<EntityRef[]>(() => {
    const refs: EntityRef[] = [];
    for (const group of groups) {
      switch (group.kind) {
        case "product-related":
          refs.push(
            ...group.proposals.map((proposal) => ({
              entityKind: "product" as const,
              entityId: proposal.target.id,
            })),
          );
          break;
        case "expense-project":
          refs.push(
            ...(group.currentTarget
              ? [
                  {
                    entityKind: "project" as const,
                    entityId: group.currentTarget.id,
                  },
                ]
              : []),
            ...group.proposals.map((proposal) => ({
              entityKind: "project" as const,
              entityId: proposal.target.id,
            })),
          );
          break;
        case "inventory-placement":
          refs.push(
            ...(group.currentTarget
              ? [
                  {
                    entityKind: "location" as const,
                    entityId: group.currentTarget.id,
                  },
                ]
              : []),
            ...group.proposals.map((proposal) => ({
              entityKind: "location" as const,
              entityId: proposal.target.id,
            })),
          );
          break;
      }
    }
    return refs;
  }, [groups]);
  const displayImages = useEntityDisplayImages(
    imageRefs,
    {},
    operations.displayImages ?? productionDisplayImages,
  );

  useEffect(() => {
    setSelected(null);
  }, [basisKey, sourceKey]);

  if (loading) {
    return (
      <output className="text-sm text-muted-foreground">
        Loading suggestions…
      </output>
    );
  }
  if (query.isError) {
    return (
      <Row align="center" justify="between" gap="sm">
        <ErrorDisplay error={query.error} title="suggestions" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          <ArrowClockwiseIcon className="size-3.5" />
          Retry suggestions
        </Button>
      </Row>
    );
  }

  if (!data) {
    return (
      <output className="text-sm text-muted-foreground">
        Loading suggestions…
      </output>
    );
  }
  if (!dataIsCurrent) {
    return (
      <output className="text-sm text-muted-foreground">
        Refreshing suggestions…
      </output>
    );
  }
  if (groups.length === 0) {
    return compact ? null : (
      <p className="text-sm text-muted-foreground">
        No suggestions for this record.
      </p>
    );
  }

  return (
    <Stack gap="sm" aria-label="Suggestions">
      {!compact && (
        <Row align="center" gap="xs" className="text-sm font-medium">
          <LightbulbIcon className="size-3.5" />
          Derived suggestions
        </Row>
      )}
      {groups.map((group) => (
        <RecommendationGroup
          key={group.kind}
          group={group}
          data={data}
          sourceKey={sourceKey}
          compact={compact}
          selected={selected}
          pending={pending}
          onSelect={setSelected}
          onAcceptExpenseProject={onAcceptExpenseProject}
          onAcceptInventoryPlacement={onAcceptInventoryPlacement}
          displayImages={displayImages}
        />
      ))}
    </Stack>
  );
}

function RecommendationGroup({
  group,
  data,
  sourceKey,
  compact,
  selected,
  pending,
  onSelect,
  onAcceptExpenseProject,
  onAcceptInventoryPlacement,
  displayImages,
}: {
  group: EntityRecommendationGroup;
  data: EntityRecommendationsOut;
  sourceKey: string;
  compact: boolean;
  selected: SelectedProposal | null;
  pending: boolean;
  onSelect: (selection: SelectedProposal | null) => void;
  onAcceptExpenseProject?: (proposal: ExpenseProjectProposal) => Promise<void>;
  onAcceptInventoryPlacement?: (
    proposal: InventoryPlacementProposal,
  ) => Promise<void>;
  displayImages: ReturnType<typeof useEntityDisplayImages>;
}) {
  const availability =
    group.status === "ready" ? null : (
      <p className="text-xs text-muted-foreground">
        {statusText(group.status, group.kind)}
      </p>
    );

  if (group.kind === "product-related") {
    return (
      <Stack gap="xs">
        {!compact && <h3 className="text-sm font-medium">Similar products</h3>}
        {availability}
        {group.proposals.map((proposal) => (
          <RelatedProductRow
            key={proposal.target.id}
            product={proposal.target}
            displayImage={
              displayImages[
                entityDisplayImageKey({
                  entityKind: "product",
                  entityId: proposal.target.id,
                })
              ] ?? null
            }
            action={
              <span className="font-mono text-2xs text-slate">
                {proposal.score > 0
                  ? `${Math.round(proposal.score * 100)}% similar`
                  : proposal.evidence.map((item) => item.signal).join(" · ")}
              </span>
            }
          />
        ))}
      </Stack>
    );
  }

  const label =
    group.kind === "expense-project"
      ? "Suggested project"
      : "Suggested location";
  const actionable =
    (group.kind === "expense-project" && Boolean(onAcceptExpenseProject)) ||
    (group.kind === "inventory-placement" &&
      Boolean(onAcceptInventoryPlacement));
  return (
    <Stack gap="xs" className={compact ? "border-t pt-2" : undefined}>
      {availability}
      <Row align="center" gap="sm" wrap>
        <span className="text-xs text-muted-foreground">{label}</span>
        {group.proposals.map((proposal) => {
          const key = `${group.kind}:${proposal.target.id}`;
          return (
            <Button
              key={key}
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              aria-label={
                compact && actionable
                  ? undefined
                  : `Review ${proposal.target.name} suggestion`
              }
              onClick={() =>
                onSelect({
                  key,
                  basisKey: data.basisKey,
                  sourceKey,
                })
              }
            >
              {proposal.target.name}
            </Button>
          );
        })}
      </Row>
      {group.proposals.map((proposal) => {
        const key = `${group.kind}:${proposal.target.id}`;
        if (
          selected?.key !== key ||
          selected.basisKey !== data.basisKey ||
          selected.sourceKey !== sourceKey
        )
          return null;
        return (
          <ProposalReview
            key={key}
            group={group}
            proposal={proposal}
            displayImages={displayImages}
            pending={pending}
            onDismiss={() => onSelect(null)}
            onAccept={
              proposal.kind === "expense-project" && onAcceptExpenseProject
                ? () => onAcceptExpenseProject(proposal)
                : proposal.kind === "inventory-placement" &&
                    onAcceptInventoryPlacement
                  ? () => onAcceptInventoryPlacement(proposal)
                  : undefined
            }
          />
        );
      })}
    </Stack>
  );
}

function ProposalReview({
  group,
  proposal,
  pending,
  onAccept,
  onDismiss,
  displayImages,
}: {
  group: ExpenseGroup | InventoryGroup;
  proposal: ExpenseProjectProposal | InventoryPlacementProposal;
  pending: boolean;
  onAccept?: () => Promise<void>;
  onDismiss: () => void;
  displayImages: ReturnType<typeof useEntityDisplayImages>;
}) {
  const [error, setError] = useState<string>();
  const [showEvidence, setShowEvidence] = useState(false);
  const targetEntity =
    group.kind === "expense-project" ? "project" : "location";
  const currentLabel =
    group.kind === "expense-project" ? "Unassigned" : "Unknown";
  return (
    <Stack
      gap="xs"
      className="rounded-md border border-border bg-muted/40 p-3 text-sm"
    >
      <Row gap="sm" wrap>
        <span>
          <span className="text-muted-foreground">Current:</span>{" "}
          {group.currentTarget ? (
            <ProposalTargetLink
              entity={targetEntity}
              target={group.currentTarget}
              displayImages={displayImages}
            />
          ) : (
            currentLabel
          )}
        </span>
        <span aria-hidden="true">→</span>
        <span>
          <span className="text-muted-foreground">Proposed:</span>{" "}
          <ProposalTargetLink
            entity={targetEntity}
            target={proposal.target}
            displayImages={displayImages}
          />
        </span>
        <Badge variant="secondary">Derived</Badge>
      </Row>
      <Button
        type="button"
        size="sm"
        variant="link"
        className="h-auto w-fit p-0"
        onClick={() => setShowEvidence((shown) => !shown)}
      >
        {showEvidence ? "Hide evidence" : "View evidence"}
      </Button>
      {showEvidence && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {proposal.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Row gap="xs" align="center">
        {onAccept && (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => {
              setError(undefined);
              void onAccept().then(onDismiss, (cause) =>
                setError(getErrorMessage(cause)),
              );
            }}
          >
            Apply change
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onDismiss}
        >
          {onAccept ? "Cancel" : "Close review"}
        </Button>
      </Row>
    </Stack>
  );
}

function ProposalTargetLink({
  entity,
  target,
  displayImages,
}: {
  entity: "project" | "location";
  target: { id: string; name: string };
  displayImages: ReturnType<typeof useEntityDisplayImages>;
}) {
  const displayImage =
    displayImages[
      entityDisplayImageKey({ entityKind: entity, entityId: target.id })
    ] ?? null;
  return entity === "project" ? (
    <EntityRefLink entity="project" data={target} displayImage={displayImage} />
  ) : (
    <EntityRefLink
      entity="location"
      data={target}
      displayImage={displayImage}
    />
  );
}

function statusText(
  status: EntityRecommendationGroup["status"],
  kind: EntityRecommendationGroup["kind"],
) {
  const subject = kind === "product-related" ? "Similarity" : "Suggestions";
  switch (status) {
    case "stale":
      return `${subject} may change while the index is refreshed.`;
    case "uncomputed":
      return `${subject} will appear after this record is indexed.`;
    case "unavailable":
      return `${subject} is unavailable until embeddings are configured.`;
    case "ready":
      return "";
  }
}
