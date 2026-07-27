import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { formatDistanceToNow } from "date-fns";
import type { FC } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { formatCurrency } from "~/lib/utils";
import { ShelfEmpty } from "../data-table/shelf";
import { EntityInlineLink } from "../EntityInlineLink";

/**
 * Where this product is stocked — one row per inventory entry, with the
 * on-hand amount, its valuation, and freshness. The primary content of a
 * product page alongside recipe usages; supersedes the old "Inventory
 * Locations" links row in Basic Information.
 *
 * Freshness is `verifiedAt` (last deliberate recount), never `updatedAt`: a
 * price change recomputes valuation and bumps `updatedAt`, which would make a
 * year-old count read as fresh. `—` = never verified.
 */
export const ProductStockedAt: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const entries = product.inventoryEntry ?? [];

  if (entries.length === 0) {
    return <ShelfEmpty entity="inventory" label="Not stocked anywhere" />;
  }

  return (
    <Table className="table-auto">
      <TableHeader>
        <TableRow>
          <TableHead>Location</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Verified</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>
              <EntityInlineLink entity="location" data={entry.location} />
            </TableCell>
            <TableCell className="font-mono tabular-nums">
              {entry.amount.value} {entry.amount.unit}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {entry.valuation != null ? formatCurrency(entry.valuation) : "—"}
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {entry.verifiedAt
                ? formatDistanceToNow(entry.verifiedAt, { addSuffix: true })
                : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
