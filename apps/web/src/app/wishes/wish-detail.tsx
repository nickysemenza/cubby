import type { WishCandidateOut, WishOut } from "@cubby/schemas/wish";
import {
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, Heart, Info, Pencil } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrencyRange } from "~/lib/format-range";
import { patchListItem } from "~/lib/optimistic-list";
import {
  cancelTRPCQueries,
  invalidateTRPCQueries,
  normalizeTRPCQueryKey,
  queryKeys,
  wishMutationInvalidateKeys,
} from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "../_components/products/product-image-summaries";
import { ImageThumbnail } from "../_components/table/ImageThumbnail";
import { TableLink } from "../_components/table/TableLink";
import { WishFormDialog } from "./wish-form-dialog";
import { wishPriceRange } from "./wish-price-range";

/**
 * Wish detail — the outcome plus its candidate tool alternatives.
 *
 * Deletion goes through `useEntityDelete` (a real confirm dialog with an
 * operation-impact preview) rather than `window.confirm`, and the body is
 * `DetailSections` so History (an auditable entity) and the registered
 * `wish.candidates` relationship both show up automatically — see
 * `entityManifest.wish` and `relatedViewRegistry`.
 */
export function WishDetail({ wish }: { wish: WishOut }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const updateMutation = useUpdateMutation({
    mutationFn: api.wish.update.mutationOptions,
    entity: "wish",
    invalidateKeys: wishMutationInvalidateKeys,
  });

  // Overview is edited through inline EditableCell fields, not a Form, so
  // editMode/mappings go unused — this is only here for the History section
  // (mirrors vendor-detail).
  const { commonSections } = useEntityDetail<WishOut, never>({
    entity: "wish",
    data: wish,
    mutationOptions: api.wish.update.mutationOptions(),
    invalidateKeys: wishMutationInvalidateKeys,
  });

  const { deleteButton, deleteDialog } = useEntityDelete({
    id: wish.id,
    name: wish.name,
    entityLabel: "Wish",
    entity: "wish",
    mutationOptions: (callbacks) =>
      api.wish.delete.mutationOptions({
        ...callbacks,
        // `wish.delete` resolves to `void` — a wish is out of the embedding
        // pipeline and owns no rollups to recompute, so there are no
        // background batches to report. `useEntityDelete` threads the
        // mutation's data into its side-effect summary, so hand it an empty
        // one rather than `void` (mirrors vendor-detail).
        onSuccess: () => callbacks.onSuccess({}),
      }),
    invalidateKeys: wishMutationInvalidateKeys,
    redirectTo: "/wishes",
  });

  const wishKey = api.wish.getByShortcode.queryKey({ shortcode: wish.id });
  const acquiredBase = api.wish.update.mutationOptions();
  const acquiredMutation = useMutation({
    mutationKey: acquiredBase.mutationKey,
    mutationFn: acquiredBase.mutationFn,
    onMutate: async (variables) => {
      await cancelTRPCQueries(queryClient, [wishKey, queryKeys.wish.list]);
      const previousDetail = queryClient.getQueryData<WishOut | null>(wishKey);
      const listPrefix = normalizeTRPCQueryKey(queryKeys.wish.list);
      const previousLists = queryClient.getQueriesData<{ items: WishOut[] }>({
        queryKey: listPrefix,
      });
      const acquiredAt = variables.data.acquired ? new Date() : null;
      const patchWish = (current: WishOut) => ({ ...current, acquiredAt });
      queryClient.setQueryData<WishOut | null>(wishKey, (current) =>
        current ? patchWish(current) : current,
      );
      // Every visible wish list uses this procedure prefix. Patch its concrete
      // page entries directly rather than recursively walking unrelated data.
      queryClient.setQueriesData<{ items: WishOut[] }>(
        { queryKey: listPrefix },
        (current) => patchListItem(current, String(variables.id), patchWish),
      );
      return { previousDetail, previousLists };
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(wishKey, updated);
      queryClient.setQueriesData<{ items: WishOut[] }>(
        { queryKey: normalizeTRPCQueryKey(queryKeys.wish.list) },
        (current) => patchListItem(current, updated.id, () => updated),
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previousDetail) {
        queryClient.setQueryData(wishKey, context.previousDetail);
      }
      for (const [key, data] of context?.previousLists ?? []) {
        queryClient.setQueryData(key as QueryKey, data);
      }
      toast.error(getErrorMessage(error));
    },
    onSettled: () =>
      invalidateTRPCQueries(queryClient, wishMutationInvalidateKeys),
  });

  const toggleAcquired = () =>
    acquiredMutation.mutate({
      id: wish.id,
      data: { acquired: !wish.acquiredAt },
    });

  const fields: BasicInfoField[] = [
    {
      label: "Name",
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
    },
    {
      label: "Notes",
      value: (
        <EditableCell
          value={wish.notes}
          config={{ type: "text", multiline: true, rows: 4 }}
          onSave={async (notes) => {
            await updateMutation.mutateAsync({ id: wish.id, data: { notes } });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
  ];

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
      title: "Overview",
      icon: Info,
      content: <BasicInfo fields={fields} />,
    },
    {
      title: "Tool alternatives",
      icon: Heart,
      // The page's primary content — everything else is metadata.
      zone: "main",
      content:
        wish.candidates.length === 0 ? (
          <p className="text-muted-foreground">
            No specific products yet — this is an open-ended idea.
          </p>
        ) : (
          // Wishes own no images; the covers here belong to the candidate
          // Products and are fetched independently of `wish.getByShortcode`, so
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
      actions={
        <>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
          <Button
            variant="outline"
            onClick={toggleAcquired}
            disabled={acquiredMutation.isPending}
          >
            <Check />
            {wish.acquiredAt ? "Still wanted" : "Mark acquired"}
          </Button>
          {deleteButton}
        </>
      }
    >
      <DetailSections sections={sections} rawData={wish} />
      {deleteDialog}
      <WishFormDialog open={editing} onOpenChange={setEditing} wish={wish} />
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
