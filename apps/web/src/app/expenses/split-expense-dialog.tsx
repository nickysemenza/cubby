import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import { unsafeProjectShortcode } from "@cubby/schemas/identifiers";
import type { CostType, ExpenseOut, Trade } from "@cubby/schemas/project";
import { useNavigate } from "@tanstack/react-router";
import { sumBy } from "es-toolkit";
import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { tradeOptions } from "~/app/projects/trade-options";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Eyebrow } from "~/components/ui/eyebrow";
import { Input } from "~/components/ui/input";
import { NoneValue } from "~/components/ui/none-value";
import { StatusText } from "~/components/ui/status-text";
import { entityDetailLink } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { useActionMutation } from "../_components/hooks/useActionMutation";
import { costTypeOptions } from "./expense-options";

/**
 * One part being drafted. `cost` stays a string so a half-typed or cleared
 * amount is representable — a blank field reads as $0, never as `NaN`.
 * `keepProduct` is which part inherits the original's product link (at most
 * one), the cheap form of per-part `productId` for the case that actually comes
 * up: a combo kit whose product row belongs to one half of the split.
 */
interface PartDraft {
  key: string;
  name: string;
  cost: string;
  costType: CostType;
  trade: Trade;
  projectId: string | null;
  keepProduct: boolean;
}

/** Dollars of slack before the parts read as disagreeing with the original. */
const SUM_TOLERANCE = 0.005;

const parseCost = (raw: string): number => {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Split one expense into real rows — the replacement for the
 * `(combo, saw portion)` naming convention that encoded splits in 12 row names.
 *
 * Seeded with two parts carrying the original's trade / cost type / project, and
 * the whole cost on the first, so the common case is "rename part 1, type part
 * 2's share". Each part then keeps its OWN trade and cost type, which is the
 * point: a combo kit is one charge whose saw half is `tools` and whose blade
 * half is `materials`.
 *
 * The parts do NOT have to add up. A mismatched sum is shown as a cue and
 * submitted as entered — nothing here validates the total, nothing back-computes
 * a cost, and the last part is never auto-balanced (see `splitExpense`).
 */
export function SplitExpenseDialog({
  open,
  onOpenChange,
  expense,
  purchaseShortcode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense: ExpenseOut;
  /**
   * The charge the parts get filed under, as its public id. Required, not
   * derived: `splitExpense` refuses an expense with no charge attached, so the
   * caller gates the whole action on having one rather than surfacing that
   * refusal as a toast. Also the post-split redirect target.
   */
  purchaseShortcode: PurchaseShortcode;
}) {
  const api = useTRPC();
  const navigate = useNavigate();
  const { options: projectOptions } = useProjectOptions();
  const keyCounter = useRef(0);

  const seedParts = (): PartDraft[] => [
    {
      key: `part-${keyCounter.current++}`,
      name: expense.name,
      // The whole cost on part 1 so the seeded form already reconciles; moving
      // money to part 2 is the user's edit, not a pre-filled guess at the split.
      cost: expense.cost != null ? String(expense.cost) : "",
      costType: expense.costType,
      trade: expense.trade,
      projectId: expense.projectId,
      keepProduct: false,
    },
    {
      key: `part-${keyCounter.current++}`,
      name: "",
      cost: "",
      costType: expense.costType,
      trade: expense.trade,
      projectId: expense.projectId,
      keepProduct: false,
    },
  ];

  const [parts, setParts] = useState<PartDraft[]>(seedParts);

  const updatePart = (key: string, patch: Partial<PartDraft>) =>
    setParts((prev) =>
      prev.map((part) => (part.key === key ? { ...part, ...patch } : part)),
    );

  // At most one part inherits the product link, so setting it clears the others.
  const setProductPart = (key: string, keep: boolean) =>
    setParts((prev) =>
      prev.map((part) => ({ ...part, keepProduct: keep && part.key === key })),
    );

  const addPart = () =>
    setParts((prev) => [
      ...prev,
      {
        key: `part-${keyCounter.current++}`,
        name: "",
        cost: "",
        costType: expense.costType,
        trade: expense.trade,
        projectId: expense.projectId,
        keepProduct: false,
      },
    ]);

  const removePart = (key: string) =>
    setParts((prev) =>
      prev.length <= 2 ? prev : prev.filter((part) => part.key !== key),
    );

  const splitMutation = useActionMutation({
    mutationFn: api.purchase.split.mutationOptions,
    success: (items) => `Split into ${items.length} lines`,
    invalidateKeys: expenseMutationInvalidateKeys,
    onSuccess: () => {
      onOpenChange(false);
      // This expense no longer exists — staying here would render a deleted row.
      // The charge is where every part now lives.
      void navigate(entityDetailLink("purchase", purchaseShortcode));
    },
  });

  const partsTotal = sumBy(parts, (part) => parseCost(part.cost));
  const original = expense.cost;
  // Non-null only when there IS a mismatch to show — the cue's whole condition
  // collapsed into one value so it narrows for the copy below.
  const delta =
    original != null && Math.abs(partsTotal - original) > SUM_TOLERANCE
      ? partsTotal - original
      : null;
  // The only blocking validation is the schema's own: every part needs a name.
  // The sum is deliberately NOT part of this.
  const missingName = parts.some((part) => part.name.trim() === "");

  const productLabel = expense.productName ?? "the linked product";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setParts(seedParts());
        onOpenChange(next);
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Split "{expense.name}"</DialogTitle>
          <DialogDescription>
            The parts below are filed under the same charge and{" "}
            <strong>this line is deleted</strong> — a split replaces the row, it
            doesn't add to it. Each part carries its own trade and cost type,
            which is what makes a combo kit's saw half tools and its blade half
            materials.
          </DialogDescription>
        </DialogHeader>

        <Stack gap="sm" className="max-h-80 overflow-y-auto">
          {parts.map((part, index) => (
            <Stack
              key={part.key}
              gap="xs"
              className="border border-[var(--border)] p-2"
            >
              <Row align="center" justify="between" gap="sm">
                <Eyebrow>Part {index + 1}</Eyebrow>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={parts.length <= 2}
                  onClick={() => removePart(part.key)}
                  aria-label={`Remove part ${index + 1}`}
                >
                  <X />
                </Button>
              </Row>
              <Row align="center" gap="sm">
                <Input
                  value={part.name}
                  onChange={(event) =>
                    updatePart(part.key, { name: event.target.value })
                  }
                  placeholder="What this part is"
                  className="flex-1"
                  aria-label={`Part ${index + 1} name`}
                />
                <Input
                  value={part.cost}
                  onChange={(event) =>
                    updatePart(part.key, { cost: event.target.value })
                  }
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  className="w-28 shrink-0 text-right font-mono tabular-nums"
                  aria-label={`Part ${index + 1} cost`}
                />
              </Row>
              <Row align="center" gap="sm" wrap>
                <FilterableCombobox
                  items={costTypeOptions}
                  value={part.costType}
                  onValueChange={(next) => {
                    // Required enum — a cleared picker is a no-op.
                    if (next) {
                      updatePart(part.key, { costType: next as CostType });
                    }
                  }}
                  className="w-36"
                />
                <FilterableCombobox
                  items={tradeOptions}
                  value={part.trade}
                  onValueChange={(next) => {
                    if (next) updatePart(part.key, { trade: next as Trade });
                  }}
                  className="w-40"
                />
                <FilterableCombobox
                  items={projectOptions}
                  value={part.projectId}
                  onValueChange={(next) =>
                    updatePart(part.key, { projectId: next })
                  }
                  placeholder="No project"
                  clearable
                  className="w-48"
                />
                {expense.productId && (
                  <Row
                    as="label"
                    align="center"
                    gap="xs"
                    className="text-xs"
                    title={`Give this part the ${productLabel} link`}
                  >
                    <Checkbox
                      checked={part.keepProduct}
                      onCheckedChange={(checked) =>
                        setProductPart(part.key, checked === true)
                      }
                      // The wrapping <label> toggles it but doesn't NAME it —
                      // Base UI renders a button, which a label can't label.
                      aria-label={`Give part ${index + 1} the ${productLabel} link`}
                    />
                    Product
                  </Row>
                )}
              </Row>
            </Stack>
          ))}
        </Stack>

        <Row align="center" justify="between" gap="sm">
          <Button variant="outline" size="sm" onClick={addPart}>
            <Plus />
            Add part
          </Button>
          {expense.productId && (
            <Description size="2xs">
              "Product" hands {productLabel} to one part; the rest start with no
              product.
            </Description>
          )}
        </Row>

        <Stack gap="tight" className="border-[var(--border)] border-t pt-2">
          <Row align="center" justify="between" gap="sm">
            <span className="text-muted-foreground text-sm">Parts total</span>
            <span className="font-mono text-sm tabular-nums">
              {formatCurrency(partsTotal)}
            </span>
          </Row>
          <Row align="center" justify="between" gap="sm">
            <span className="text-muted-foreground text-sm">Original cost</span>
            <span className="font-mono text-sm tabular-nums">
              {original != null ? formatCurrency(original) : <NoneValue />}
            </span>
          </Row>
          {/* A cue, never a gate. The parts are recorded exactly as typed:
              a partial refund or a discount applied to one half legitimately
              makes the halves disagree with the original charge. */}
          {delta !== null ? (
            <StatusText tone="warning" className="text-xs">
              Parts are {formatCurrency(Math.abs(delta))}{" "}
              {delta > 0 ? "over" : "under"} the original — saved as entered.
              Nothing is auto-balanced.
            </StatusText>
          ) : (
            <Description size="xs">
              {original == null
                ? "The original has no cost recorded, so there's nothing to reconcile against."
                : "Parts add up to the original cost."}
            </Description>
          )}
        </Stack>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={missingName || splitMutation.isPending}
            onClick={() =>
              splitMutation.mutate({
                expenseId: expense.id,
                parts: parts.map((part) => ({
                  name: part.name.trim(),
                  cost: parseCost(part.cost),
                  costType: part.costType,
                  trade: part.trade,
                  // Plain string out of the picker — branded as a shortcode at
                  // this boundary, same convention as the create/settle dialogs.
                  projectId: part.projectId
                    ? unsafeProjectShortcode(part.projectId)
                    : null,
                  productId: part.keepProduct ? expense.productShortcode : null,
                })),
              })
            }
          >
            {splitMutation.isPending
              ? "Splitting..."
              : `Split into ${parts.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
