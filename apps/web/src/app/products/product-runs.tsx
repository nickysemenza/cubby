import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { entityListFor } from "~/entity/entity-list";
import { ProductRelatednessActions } from "~/entity/relatedness/relatedness-rail";
import { purchaseLabel } from "~/lib/purchase-label";
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
  const Icon = complete ? CheckCircleIcon : CircleDashedIcon;
  return (
    <div className="flex min-w-0 items-start gap-2 border border-border bg-background p-2.5">
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${complete ? "text-positive" : "text-muted-foreground"}`}
      />
      <div className="min-w-0">
        <span className="block text-xs font-semibold">{label}</span>
        <span className="block text-xs break-words text-muted-foreground">
          {detail}
        </span>
      </div>
    </div>
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
        <div className="grid gap-2 sm:grid-cols-2">
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
        </div>
      ) : null}
      {purchases.isPending ? (
        <StatusText>Loading purchase evidence…</StatusText>
      ) : null}
      {purchases.isError ? (
        <StatusText tone="destructive">{purchases.error.message}</StatusText>
      ) : null}
      {linkedPurchases.map((purchase) => (
        <div
          key={purchase.id}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
        >
          <Link
            to="/purchases/$shortcode"
            params={{ shortcode: purchase.id }}
            className="font-medium text-primary hover:underline"
          >
            {purchaseLabel(purchase)}
          </Link>
          <span className="text-muted-foreground">
            {purchase.financialReconciliation.status === "match"
              ? "Statement matched"
              : "Statement evidence not matched"}
          </span>
        </div>
      ))}
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
