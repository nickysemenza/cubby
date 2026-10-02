import type { ProductListItem } from "@cubby/schemas/product";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { UnitPriceLine } from "~/features/units/unit-price-line";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { Badge } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";
import { OptionalStatusText, StatusText } from "~/ui/primitives/status-text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { TruncatedList } from "~/ui/TruncatedList";

import type { ListRenderer } from "../list-renderer-types";

/**
 * Units bought minus units gone, with its own uncertainty attached.
 *
 * The `+N?` / `−N?` suffixes are load-bearing: an expense line with no
 * recorded quantity contributes nothing to the number, so a product with six
 * unquantified receipts would otherwise read as a confident 0. Both directions
 * are disclosed — an unknown acquisition means the real count could be
 * higher, an unknown exit that it could be lower.
 */
function ExpectedQuantityCell({
  ledger,
}: {
  ledger: ProductListItem["quantityLedger"];
}) {
  const detail = [
    `${ledger.acquiredUnits} acquired − ${ledger.exitedUnits} gone`,
    ledger.unknownAcquisitionLines > 0
      ? `${ledger.unknownAcquisitionLines} acquisition line(s) carry no quantity`
      : null,
    ledger.unknownExitLines > 0
      ? `${ledger.unknownExitLines} exit line(s) carry no quantity`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tabular-nums" />}>
        <OptionalStatusText
          tone={ledger.expectedQuantity < 0 ? "destructive" : undefined}
        >
          {ledger.expectedQuantity}
        </OptionalStatusText>
        {ledger.unknownAcquisitionLines > 0 ? (
          <StatusText tone="warning">
            {` +${ledger.unknownAcquisitionLines}?`}
          </StatusText>
        ) : null}
        {ledger.unknownExitLines > 0 ? (
          <StatusText tone="warning">
            {` −${ledger.unknownExitLines}?`}
          </StatusText>
        ) : null}
      </TooltipTrigger>
      <TooltipContent side="top">{detail}</TooltipContent>
    </Tooltip>
  );
}

const expectedQuantity: ListRenderer<"product"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor((row) => row.quantityLedger.expectedQuantity, {
        id: "ledgerExpectedQuantity",
        header: "Expected",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "meta", priority: 45 },
        },
        cell: (info) => (
          <ExpectedQuantityCell ledger={info.row.original.quantityLedger} />
        ),
      }),
    );
  });

// Shelf minus ledger. Dashes when the product isn't stocked, and when its
// entries carry more than one unit (see `deriveOnHandUnits`).
const quantityVariance: ListRenderer<"product"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor((row) => row.quantityVariance, {
        id: "quantityVariance",
        header: "Variance",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "meta", priority: 44 },
        },
        cell: (info) => {
          const { quantityVariance, onHandUnits, quantityLedger } =
            info.row.original;
          if (quantityVariance === null || onHandUnits === null) {
            return <NoneValue />;
          }
          return (
            <Tooltip>
              <TooltipTrigger
                render={
                  quantityVariance === 0 ? (
                    <span className="tabular-nums" />
                  ) : (
                    <StatusText
                      as="span"
                      tone="warning"
                      className="tabular-nums"
                    />
                  )
                }
              >
                {quantityVariance > 0
                  ? `+${quantityVariance}`
                  : quantityVariance}
              </TooltipTrigger>
              <TooltipContent side="top">
                {`${onHandUnits} on hand vs. ${quantityLedger.expectedQuantity} expected`}
              </TooltipContent>
            </Tooltip>
          );
        },
      }),
    );
  });

// Comparable unit price is projected by the server from the same effective
// price and complete conversion graph the explanation reads. It remains
// display-only because the list query does not expose server sorting for it.
const unitPrice: ListRenderer<"product"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.display({
        id: "unitPrice",
        header: "Unit price",
        meta: { numeric: true, className: "w-24" },
        cell: (info) => (
          <UnitPriceLine prices={info.row.original.unitPrice} compact />
        ),
      }),
    );
  });

const usdaFoodLink: ListRenderer<"product"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.display({
        id: "food",
        header: "USDA Food",
        // No mobile slot: a display column escapes the model's empty-value
        // check, and most products have no USDA link.
        meta: { className: "w-32" },
        cell: ({ row }) => {
          const food = row.original.food;
          return food ? (
            <EntityRefLink
              displayImage={null}
              entity="usda-food"
              data={food}
              compact
            />
          ) : (
            <NoneValue />
          );
        },
      }),
    );
  });

// Read-only: the Tags filter spec declares `columnId: "tags"`, and the
// header-filter machinery needs a real column to hang on.
const tagLinks: ListRenderer<"product"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor("tags", {
        id: "tags",
        header: "Tags",
        meta: { className: "w-40", mobile: { slot: "meta", priority: 60 } },
        cell: (info) => {
          const tags = info.getValue();
          if (!tags.length) return <NoneValue />;
          return (
            <TruncatedList
              items={tags}
              maxItems={2}
              // `stopPropagation`: rows carry the preview onRowClick and
              // TanStack's Link preventDefaults without stopping propagation,
              // so the chip would also open the sheet.
              renderItem={(tag) => (
                <Link
                  key={tag}
                  to="/products"
                  search={{ tags: tag }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="outline">{tag}</Badge>
                </Link>
              )}
            />
          );
        },
      }),
    );
  });

export const productListRenderers = {
  "expected-quantity": expectedQuantity,
  "quantity-variance": quantityVariance,
  "unit-price": unitPrice,
  "usda-food-link": usdaFoodLink,
  "tag-links": tagLinks,
} as const;
