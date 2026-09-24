import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import type {
  ProductMatchCandidate,
  ProductMatchSide,
} from "@cubby/schemas/recommendations";
import { GitMergeIcon } from "@phosphor-icons/react/dist/csr/GitMerge";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  type EntityDisplayImagesQueryOptions,
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { EntityMergeDialog } from "~/app/_components/merge/entity-merge-dialog";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { EntityIcon } from "~/entities/entities";
import type { recommendations } from "~/lib/recommendations.functions";

export interface ProductMatchQueueOperations {
  readonly productMatches: typeof recommendations.productMatches;
  readonly dismissProductMatch: typeof recommendations.dismissProductMatch;
  readonly mergeProductMatch: typeof recommendations.mergeProductMatch;
  readonly displayImages: EntityDisplayImagesQueryOptions;
}

const COVER_PX = 160;

const ROLE_LABEL = {
  photo: "From a photo",
  purchase: "From a purchase",
  other: "Product",
} as const satisfies Record<ProductMatchSide["role"], string>;

const pairKey = (item: ProductMatchCandidate) =>
  `${item.keeper.id}|${item.other.id}`;

/**
 * The product match queue: agent-proposed pairs (with their evidence) first,
 * then detector pairs. Each card shows both covers side by side so a person
 * can confirm "same real item" by eye before the ordinary merge preview.
 */
export function ProductMatchQueue({
  sourceId,
  operations,
}: {
  sourceId?: ProductShortcode;
  operations: ProductMatchQueueOperations;
}) {
  const queue = useQuery(
    operations.productMatches.queryOptions(
      sourceId ? { productId: sourceId } : {},
    ),
  );
  const items = useMemo(() => queue.data?.items ?? [], [queue.data?.items]);
  const refs = useMemo(
    () =>
      items.flatMap((item) => [
        { entityType: "product" as const, entityId: item.keeper.id },
        { entityType: "product" as const, entityId: item.other.id },
      ]),
    [items],
  );

  if (queue.isLoading)
    return <p className="text-sm text-muted-foreground">Loading matches…</p>;
  if (queue.isError)
    return (
      <ErrorDisplay
        error={queue.error}
        title="product matches"
        onRetry={() => void queue.refetch?.()}
      />
    );

  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        Products created from a photo and products created from a purchase that
        look like the same item. Merging keeps the purchase product by default,
        so the order and spend history stay attached.
        {queue.data && !queue.data.semanticRanking
          ? " The similarity index is unavailable, so pairs are ranked by name only."
          : null}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No product matches to review.
        </p>
      ) : (
        <EntityDisplayImagesProvider
          refs={refs}
          queryOptions={operations.displayImages}
        >
          {items.map((item) => (
            <ProductMatchCard
              key={pairKey(item)}
              item={item}
              operations={operations}
            />
          ))}
        </EntityDisplayImagesProvider>
      )}
    </Stack>
  );
}

function ProductMatchCard({
  item,
  operations,
}: {
  item: ProductMatchCandidate;
  operations: ProductMatchQueueOperations;
}) {
  const [merging, setMerging] = useState(false);
  const navigate = useNavigate();
  const dismiss = useMutation(operations.dismissProductMatch.mutationOptions());
  const merge = useActionMutation({
    mutationFn: () => operations.mergeProductMatch.mutationOptions(),
    success: "Products merged",
    error: "Merge failed",
    onSuccess: () => {
      setMerging(false);
      void navigate({
        to: "/recommendations/workbench",
        search: { kind: "product-match" },
        replace: true,
      });
    },
  });

  return (
    <article
      aria-label={`${item.keeper.name} and ${item.other.name}`}
      className="rounded-lg border border-border bg-card p-3 md:p-4"
    >
      <Stack gap="sm">
        <Row gap="xs" align="center" className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {item.source === "agent" ? "Agent proposal" : "Detected pair"}
          </span>
          {item.signals.length > 0 && <span>· {item.signals.join(" · ")}</span>}
        </Row>
        <div className="grid grid-cols-2 gap-3">
          <MatchSide side={item.keeper} caption="Keep" />
          <MatchSide side={item.other} caption="Merge in" />
        </div>
        {item.evidence && (
          <p className="text-sm whitespace-pre-line">{item.evidence}</p>
        )}
        {item.sourceUrls.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs">
            {item.sourceUrls.map((url) => (
              <li key={url} className="truncate">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        )}
        {item.warnings.map((warning) => (
          <Row
            key={warning}
            gap="xs"
            align="start"
            className="text-sm text-warning"
          >
            <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{warning}</span>
          </Row>
        ))}
        <Row gap="sm">
          <Button type="button" onClick={() => setMerging(true)}>
            <GitMergeIcon className="size-3.5" />
            Review merge
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={dismiss.isPending}
            onClick={() =>
              dismiss.mutate({ productIds: [item.keeper.id, item.other.id] })
            }
          >
            <XIcon className="size-3.5" />
            Not the same
          </Button>
        </Row>
      </Stack>
      {merging && (
        <EntityMergeDialog
          entity="product"
          // Ranked mode starts with the first row as keeper: the purchase side.
          rows={[item.keeper, item.other]}
          open
          onOpenChange={(open) => {
            if (!open) setMerging(false);
          }}
          onConfirm={(keepId, aliasIds) => {
            const keep = [item.keeper, item.other].find(
              (side) => side.id === keepId,
            );
            const mergeInto = [item.keeper, item.other].find(
              (side) => side.id !== keepId && aliasIds.includes(side.id),
            );
            if (keep && mergeInto)
              merge.mutate({ keepId: keep.id, mergeId: mergeInto.id });
          }}
          isPending={merge.isPending}
        />
      )}
    </article>
  );
}

function MatchSide({
  side,
  caption,
}: {
  side: ProductMatchSide;
  caption: string;
}) {
  const displayImage = useEntityDisplayImage({
    entityType: "product",
    entityId: side.id,
  });
  const details = [
    side.category,
    side.owner ? `Owner: ${side.owner.name}` : null,
    side.inventoryCount > 0
      ? `${side.inventoryCount} stock ${side.inventoryCount === 1 ? "entry" : "entries"}`
      : "No stock",
  ].filter(Boolean);
  return (
    <Stack gap="xs" className="min-w-0">
      <span className="text-xs text-muted-foreground">
        {caption} · {ROLE_LABEL[side.role]}
      </span>
      <div className="flex aspect-square w-full max-w-40 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
        {displayImage ? (
          <Image
            src={preferredImageUrl(displayImage)}
            alt={side.name}
            displayWidth={COVER_PX}
            className="h-full w-full object-contain"
          />
        ) : (
          <EntityIcon entity="product" colored size={24} />
        )}
      </div>
      <div className="min-w-0">
        <EntityInlineLink
          entity="product"
          data={{ id: side.id, name: side.name }}
          displayImage={displayImage}
          showIdentityMark={false}
          truncate
        />
      </div>
      <span className="text-xs text-muted-foreground">
        {details.join(" · ")}
      </span>
      {side.purchase && (
        <span className="text-xs text-muted-foreground">
          {[
            side.purchase.vendor,
            side.purchase.date,
            side.purchase.line ? `“${side.purchase.line}”` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </Stack>
  );
}
