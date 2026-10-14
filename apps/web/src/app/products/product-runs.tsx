import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { entityListFor } from "~/entity/entity-list";
import { ProductRelatednessActions } from "~/entity/relatedness/relatedness-rail";
import { purchaseLabel } from "~/lib/purchase-label";
import { RecordDot, RecordList, RecordRow } from "~/ui/common/record-list";
import { Stack } from "~/ui/layout";
import { StatusText } from "~/ui/primitives/status-text";

function JourneyStep({
  label,
  detail,
  complete,
}: {
  label: string;
  detail: string;
  complete: boolean;
}) {
  return (
    <RecordRow
      leading={
        <RecordDot
          state={complete ? "done" : "not_reached"}
          label={complete ? "Done" : "Not yet"}
        />
      }
      primary={<span className="font-medium">{label}</span>}
      secondary={detail}
      clip={false}
    />
  );
}

/** Only the canonical backend ownership projection controls guidance. */
export const ProductOwnershipEvidence: DetailSlotComponent<"product"> = ({
  record: product,
}) => {
  const purchases = useQuery(
    entityListFor("purchase").queryOptions({
      filters: { productId: parseShortcodeFor("product", product.id) },
      pagination: { pageIndex: 0, pageSize: 12 },
    }),
  );
  const evidence = product.ownershipEvidence;
  const ownPhotos = product.attachments.filter(
    (image) => image.source === "own",
  ).length;
  const linkedPurchases = purchases.data?.items ?? [];
  return (
    <Stack gap="sm">
      <p className="text-sm">
        {evidence.state === "exited"
          ? `Recorded ownership ended${evidence.exitedAt ? ` on ${evidence.exitedAt}` : ""}.`
          : evidence.state === "owned"
            ? "Recorded movements establish ownership."
            : "Ownership is uncertain: recorded movements do not establish the current quantity."}
      </p>
      {evidence.state !== "exited" ? (
        <RecordList>
          <JourneyStep
            label="Your photos"
            detail={ownPhotos ? `${ownPhotos} own photos` : "Add an item photo"}
            complete={ownPhotos > 0}
          />
          <JourneyStep
            label="Inventory"
            detail={
              product.onHandUnits !== null && product.onHandUnits > 0
                ? "Inventory recorded"
                : evidence.state === "uncertain"
                  ? "Confirm whether you still own it before recording stock"
                  : "Record where it lives"
            }
            complete={product.onHandUnits !== null && product.onHandUnits > 0}
          />
        </RecordList>
      ) : null}
      {purchases.isPending ? (
        <StatusText>Loading purchase evidence…</StatusText>
      ) : null}
      {purchases.isError ? (
        <StatusText tone="destructive">{purchases.error.message}</StatusText>
      ) : null}
      {linkedPurchases.length ? (
        <RecordList aria-label="Purchase evidence">
          {linkedPurchases.map((purchase) => {
            const matched = purchase.financialReconciliation.status === "match";
            return (
              <RecordRow
                key={purchase.id}
                leading={
                  <RecordDot
                    state={matched ? "done" : "warning"}
                    label={
                      matched
                        ? "Statement matched"
                        : "Statement evidence not matched"
                    }
                  />
                }
                primary={
                  <Link
                    to="/purchases/$shortcode"
                    params={{ shortcode: purchase.id }}
                    className="font-medium underline-offset-2 hover:text-primary hover:underline"
                  >
                    {purchaseLabel(purchase)}
                  </Link>
                }
                secondary={
                  matched
                    ? "Statement matched"
                    : "Statement evidence not matched"
                }
              />
            );
          })}
        </RecordList>
      ) : null}
      {evidence.state !== "exited" ? (
        <Link
          to="/purchases"
          className="w-fit text-sm font-medium text-primary hover:underline"
        >
          Review purchase evidence
        </Link>
      ) : null}
    </Stack>
  );
};

/** Research history uses the same server-owned records report as Purchases. */
export const ProductRuns: DetailSlotComponent<"product"> = ({ record }) => (
  <EntityReportSlot slot="product.runs" id={record.id} record={record} />
);

export const ProductDetailActions: DetailSlotComponent<"product"> = ({
  record,
}) => (
  <ProductRelatednessActions
    productId={parseShortcodeFor("product", record.id)}
  />
);
