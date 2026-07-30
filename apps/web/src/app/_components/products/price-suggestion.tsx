import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Sparkles } from "lucide-react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { useTRPC } from "~/integrations/trpc/react";
import { parsePlainDate } from "~/lib/plain-date";
import { formatCurrency } from "~/lib/utils";
import { suggestPriceFromExpenses } from "./suggest-price";

// Module-level so the fallback keeps a stable reference across renders.
const EMPTY_EXPENSES: ExpenseOut[] = [];

interface PriceSuggestionProps {
  product: ProductWithFoodOut;
  onAccept: (price: number) => Promise<void>;
  isPending: boolean;
}

/**
 * "You paid X for this" beneath the product facts, with one-click accept into
 * `price`.
 *
 * Only offered when `price` is null. `price` drives inventory valuation and is
 * maintained as list/replacement value, so an existing figure is a deliberate
 * choice — the same never-clobber rule the UPC apply path follows.
 *
 * Shares `expense.chartData` with the Expense History section on this page;
 * react-query dedupes the identical key, so this costs no extra request.
 */
export function PriceSuggestion({
  product,
  onAccept,
  isPending,
}: PriceSuggestionProps) {
  const api = useTRPC();
  const unpriced = product.price == null;

  const { data = EMPTY_EXPENSES } = useQuery({
    ...api.expense.chartData.queryOptions({ productId: product.id }),
    enabled: unpriced,
  });

  if (!unpriced) return null;

  const onHand = product.inventoryEntry.reduce(
    (sum, entry) => sum + entry.amount.value,
    0,
  );
  const suggestion = suggestPriceFromExpenses(data, onHand);
  if (!suggestion) return null;

  const provenance = [
    suggestion.vendor,
    suggestion.date
      ? format(parsePlainDate(suggestion.date), "MMM d, yyyy")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Stack gap="xs" className="border-t pt-2">
      <Row align="center" gap="sm" justify="between" wrap>
        <Row align="center" gap="xs">
          <Sparkles className="size-3 text-muted-foreground" />
          <span className="text-sm">
            No price set — you paid{" "}
            <span className="font-medium">
              {formatCurrency(suggestion.unitPrice)}
            </span>
            {suggestion.quantity > 1 ? " per unit" : ""}
          </span>
        </Row>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => void onAccept(suggestion.unitPrice)}
        >
          {isPending ? "Applying…" : "Use as price"}
        </Button>
      </Row>
      <Description>
        {/* Show the division rather than just its result — an expense row is an
            order total, so a silent divide would be an unauditable guess. */}
        {suggestion.quantity > 1
          ? `${formatCurrency(suggestion.paid)} split across ${suggestion.quantity} units on hand`
          : formatCurrency(suggestion.paid)}
        {provenance ? ` · ${provenance}` : ""}
      </Description>
    </Stack>
  );
}
