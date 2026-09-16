import type { WishCandidateOut, WishOut } from "@cubby/schemas/wish";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Heart, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { NoneValue } from "~/components/ui/none-value";
import { wishEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import {
  editableFieldOverrides,
  EntityBasicInfo,
  entitySectionFields,
} from "~/entities/entity-display";
import {
  cancelQueriesByTags,
  restoreQueries,
  snapshotQueriesByTags,
  updateQueriesByTags,
} from "~/integrations/tanstack-query/operation-cache";
import type { OperationCacheTag } from "~/integrations/tanstack-query/operation-meta";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrencyRange } from "~/lib/format-range";
import { patchCachedListItem } from "~/lib/optimistic-list";
import { formatCurrency } from "~/lib/utils";

import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "../_components/products/product-image-summaries";
import { ImageThumbnail } from "../_components/table/ImageThumbnail";
import { TableLink } from "../_components/table/TableLink";
import { wishPriceRange } from "./wish-price-range";

/** Every wish surface answers to the entity root: detail, lists, infinite pages. */
const WISH_TAGS: readonly OperationCacheTag[] = [["wish"]];

/**
 * Wish detail — the outcome plus its candidate tool alternatives.
 *
 * The body is `DetailSections` so History (an auditable entity) and the
 * registered `wish.candidates` relationship both show up automatically — see
 * `entityManifest.wish` and `relatedViewRegistry`.
 */
export function WishDetail({ record: wish }: { record: WishOut }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("wish", "update"),
    entity: "wish",
  });

  // Overview is edited through inline EditableCell fields, not a Form, so
  // editMode/mappings go unused — this is only here for the History section
  // (mirrors vendor-detail).
  const { commonSections } = useEntityDetail<"wish", WishOut, never>({
    entity: "wish",
    data: wish,
  });

  const wishKey = entityDetailFor("wish").queryKey(wish.id);
  const acquiredBase = entityMutationOptionsFactory("wish", "update")();
  const acquiredMutation = useMutation({
    ...acquiredBase,
    onMutate: async (variables) => {
      // One predicate reaches every wish-tagged entry: the detail query and
      // each visible list, including the SSR loader's InfiniteData. The old
      // root key matched that infinite entry too, but handed it to a patcher
      // that assumed a `{ items }` page — so `onMutate` threw whenever the
      // wishes index had been visited.
      await cancelQueriesByTags(queryClient, WISH_TAGS);
      const snapshot = snapshotQueriesByTags(queryClient, WISH_TAGS);
      const acquiredAt = variables.data.acquired ? new Date() : null;
      const patchWish = (current: WishOut) => ({ ...current, acquiredAt });
      queryClient.setQueryData<WishOut | null>(wishKey, (current) =>
        current ? patchWish(current) : current,
      );
      updateQueriesByTags(queryClient, WISH_TAGS, (current) =>
        patchCachedListItem<WishOut>(current, String(variables.id), patchWish),
      );
      return { snapshot };
    },
    onSuccess: (updated) => {
      const { sideEffects: _sideEffects, ...wish } = updated;
      queryClient.setQueryData(wishKey, wish);
      updateQueriesByTags(queryClient, WISH_TAGS, (current) =>
        patchCachedListItem<WishOut>(current, wish.id, () => wish),
      );
    },
    onError: (error, _variables, context) => {
      if (context?.snapshot) restoreQueries(queryClient, context.snapshot);
      toast.error(getErrorMessage(error));
    },
  });

  const toggleAcquired = () =>
    acquiredMutation.mutate({
      id: wish.id,
      data: { acquired: !wish.acquiredAt },
    });

  // `notes` is plain scalar → update {key} — generic. `name` keeps its
  // required-field guard (a cleared name is a no-op, not a write attempt).
  const fieldOverrides = {
    ...editableFieldOverrides(
      "wish",
      wish,
      ["notes"],
      updateMutation.mutateAsync,
    ),
    name: () => ({
      value: (
        <EditableCell
          value={wish.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            // Required field — a cleared name is a no-op, not a null write.
            if (!name) return;
            await updateMutation.mutateAsync({ id: wish.id, data: { name } });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    }),
  };

  const candidateProductIds = useMemo(
    () => wish.candidates.map((candidate) => candidate.id),
    [wish.candidates],
  );
  const priceRange = wishPriceRange(wish.candidates);
  const priceRangeLabel = priceRange
    ? formatCurrencyRange(priceRange.low, priceRange.high)
    : "—";

  const sections: DetailSection[] = [
    {
      id: "overview",
      title: "Overview",
      icon: Info,
      placement: "supporting",
      content: (
        <EntityBasicInfo
          entity="wish"
          fields={entitySectionFields("wish", "overview")}
          record={wish}
          overrides={fieldOverrides}
        />
      ),
    },
    {
      id: "tool-alternatives",
      title: "Tool alternatives",
      icon: Heart,
      // The page's primary content — everything else is metadata.
      placement: "primary",
      content:
        wish.candidates.length === 0 ? (
          <p className="text-muted-foreground">
            No specific products yet — this is an open-ended idea.
          </p>
        ) : (
          // Wishes own no images; the covers here belong to the candidate
          // Products are fetched independently of the Wish detail record, so
          // an unillustrated Tool stays an honest placeholder rather than making
          // every wish response heavier.
          <ProductImageSummariesProvider productIds={candidateProductIds}>
            <div className="divide-y border">
              {wish.candidates.map((candidate) => (
                <WishCandidateRow key={candidate.id} candidate={candidate} />
              ))}
            </div>
          </ProductImageSummariesProvider>
        ),
    },
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    { label: "Candidates", value: wish.candidates.length },
    { label: "Price range", value: priceRangeLabel },
  ];

  return (
    <Page
      variant="detail"
      entity="wish"
      title={wish.name}
      rawData={wish}
      heroStamp={
        wish.acquiredAt ? { label: "Acquired", tone: "green" } : undefined
      }
      heroStats={heroStats}
      heroActions={{
        primary: <DetailEditAction onClick={() => setEditing(true)} />,
        secondary: (
          <>
            <Button
              variant="outline"
              onClick={toggleAcquired}
              disabled={acquiredMutation.isPending}
            >
              <Check />
              {wish.acquiredAt ? "Still wanted" : "Mark acquired"}
            </Button>
          </>
        ),
      }}
    >
      <DetailSections sections={sections} rawData={wish} />
      <EntityEditDialog
        open={editing}
        onOpenChange={setEditing}
        request={wishEditRequest(wish)}
      />
    </Page>
  );
}

/**
 * One candidate alternative. Its own component because
 * `useHydratedProductImages` is a hook and cannot be called inside the
 * candidates `.map` (mirrors `ExpenseProductImageCell`).
 */
function WishCandidateRow({ candidate }: { candidate: WishCandidateOut }) {
  const images = useHydratedProductImages(candidate.id);
  return (
    <div className="p-2">
      <Row align="center" justify="between" gap="sm">
        <Row align="center" gap="sm" className="min-w-0">
          <span className="block size-10 shrink-0">
            <ImageThumbnail
              images={images}
              alt={candidate.name}
              lazyPreview
              entity="product"
            />
          </span>
          <span className="min-w-0">
            <TableLink
              to={entities.product.routes.detail}
              params={entityDetailParams(candidate.id)}
              className="block truncate"
            >
              {candidate.name}
            </TableLink>
            <span className="block truncate text-muted-foreground">
              {candidate.manufacturer}
              {candidate.model ? ` · ${candidate.model}` : ""}
            </span>
          </span>
        </Row>
        <Row as="span" align="center" gap="sm">
          {candidate.inventoried && (
            <Badge variant="positive">In inventory</Badge>
          )}
          {candidate.price !== null && (
            <span>{formatCurrency(candidate.price)}</span>
          )}
        </Row>
      </Row>
    </div>
  );
}
