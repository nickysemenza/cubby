import type { WishOut } from "@cubby/schemas/wish";
import { Check, Heart, Info, Pencil } from "lucide-react";
import { useState } from "react";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { wishMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { TableLink } from "../_components/table/TableLink";
import { WishFormDialog } from "./wish-form-dialog";

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

  const toggleAcquired = () =>
    updateMutation.mutate({
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

  const prices = wish.candidates
    .map((candidate) => candidate.price)
    .filter((price): price is number => price !== null);
  const priceRangeLabel =
    prices.length === 0
      ? "—"
      : prices.length === 1
        ? // Guarded by the length check above — `noUncheckedIndexedAccess`
          // exception for access right after a `.length` check.
          formatCurrency(prices[0]!)
        : `${formatCurrency(Math.min(...prices))}–${formatCurrency(Math.max(...prices))}`;

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
          <div className="divide-y border">
            {wish.candidates.map((candidate) => (
              <div key={candidate.id} className="p-2">
                <Row align="center" justify="between" gap="sm">
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
            ))}
          </div>
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
            disabled={updateMutation.isPending}
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
