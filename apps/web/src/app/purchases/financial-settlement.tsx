import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { TableCellWorkbench } from "~/app/_components/data-table/table-cell-workbench";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { EnumPill } from "~/components/ui/enum-pill";
import { Input } from "~/components/ui/input";
import {
  captureRequest,
  financialTransactionEditRequest,
} from "~/entities/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entities/editing/entity-edit-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list";
import { fieldEnumOptions } from "~/entities/enum-field-display";
import { formatFieldProvenance } from "~/entities/field-provenance";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCurrency } from "~/lib/utils";

import { LinkedTransactions } from "../finance/linked-transactions";

type FinancialPurchase = PurchaseOut & {
  financialReconciliation: {
    status: "unknown" | "pending" | "match" | "mismatch";
    transactionCount: number;
    postedTransactionCount: number;
    outstandingTransactionCount: number;
    postedTotal: number;
    projectedTotal: number;
    postedRefundTotal: number;
    delta: number | null;
  };
};
const settlementField = entityFieldModels.purchase.fields.find(
  (field) => field.key === "financialReconciliation",
);
if (!settlementField?.provenance) {
  throw new Error("Purchase financial settlement requires provenance");
}
const settlementProvenanceDescription = formatFieldProvenance(
  settlementField.provenance,
);

export function rankSettlementCandidates(
  purchase: Pick<PurchaseOut, "date" | "statedTotal" | "vendorName">,
  transactions: FinancialTransactionOut[],
) {
  const anchor = purchase.date ? Date.parse(`${purchase.date}T00:00:00Z`) : NaN;
  return transactions
    .flatMap((transaction) => {
      if (
        transaction.allocations.length ||
        (transaction.kind !== "purchase" && transaction.kind !== "refund")
      )
        return [];
      const value = purchase.statedTotal;
      const posted = transaction.postedDate ?? transaction.transactionDate;
      const days =
        posted && Number.isFinite(anchor)
          ? Math.abs(Date.parse(`${posted}T00:00:00Z`) - anchor) / 86_400_000
          : Number.POSITIVE_INFINITY;
      if (days > 45) return [];
      const merchantMatches = Boolean(
        purchase.vendorName &&
        transaction.merchant &&
        transaction.merchant
          .toLocaleLowerCase()
          .includes(purchase.vendorName.toLocaleLowerCase()),
      );
      const exactAmount =
        transaction.kind === "purchase" &&
        value !== null &&
        Math.abs(transaction.amount - value) <= 0.01;
      if (!merchantMatches && !exactAmount) return [];
      return [{ transaction, days, merchantMatches, exactAmount }];
    })
    .sort(
      (a, b) =>
        Number(b.exactAmount) - Number(a.exactAmount) ||
        Number(b.merchantMatches) - Number(a.merchantMatches) ||
        a.days - b.days,
    )
    .slice(0, 10);
}

type SettlementAllocationInput = { purchaseId: string; amount: string };
type SettlementAllocationDraft = SettlementAllocationInput & { key: string };
const parsePurchaseId = (value: string) => parseShortcodeFor("purchase", value);

export function initialSettlementAllocations(
  purchaseId: string,
  transaction: Pick<FinancialTransactionOut, "amount" | "kind">,
  purchase: Pick<PurchaseOut, "statedTotal">,
): SettlementAllocationInput[] {
  const totalCents = Math.round(transaction.amount * 100);
  const statedCents = Math.round((purchase.statedTotal ?? 0) * 100);
  const firstCents =
    transaction.kind === "purchase" && statedCents > 0
      ? Math.min(totalCents, statedCents)
      : totalCents;
  const rows = [{ purchaseId, amount: (firstCents / 100).toFixed(2) }];
  if (firstCents !== totalCents)
    rows.push({
      purchaseId: "",
      amount: ((totalCents - firstCents) / 100).toFixed(2),
    });
  return rows;
}

export function parseSettlementAllocations(
  rows: SettlementAllocationInput[],
  transactionAmount: number,
) {
  const totalCents = Math.round(transactionAmount * 100);
  if (!rows.length || !Number.isSafeInteger(totalCents)) return null;
  const parsed: {
    purchaseId: ReturnType<typeof parsePurchaseId>;
    amount: number;
  }[] = [];
  const seen = new Set<string>();
  let allocatedCents = 0;
  for (const row of rows) {
    let purchaseId: ReturnType<typeof parsePurchaseId>;
    try {
      purchaseId = parsePurchaseId(row.purchaseId.trim());
    } catch {
      return null;
    }
    const cents = Math.round(Number(row.amount) * 100);
    if (
      !row.amount.trim() ||
      !Number.isSafeInteger(cents) ||
      cents === 0 ||
      Math.abs(Number(row.amount) * 100 - cents) > 0.000001 ||
      Math.sign(cents) !== Math.sign(totalCents) ||
      seen.has(purchaseId)
    )
      return null;
    seen.add(purchaseId);
    allocatedCents += cents;
    parsed.push({ purchaseId, amount: cents / 100 });
  }
  return allocatedCents === totalCents ? parsed : null;
}

function MatchStatementTransaction({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<FinancialTransactionOut | null>(
    null,
  );
  const [allocations, setAllocations] = useState<SettlementAllocationDraft[]>(
    [],
  );
  const date = purchase.date ? Date.parse(`${purchase.date}T00:00:00Z`) : NaN;
  const from = Number.isFinite(date)
    ? new Date(date - 45 * 86_400_000).toISOString().slice(0, 10)
    : undefined;
  const to = Number.isFinite(date)
    ? new Date(date + 45 * 86_400_000).toISOString().slice(0, 10)
    : undefined;
  const candidatesQuery = useQuery({
    ...entityListFor("financialTransaction").queryOptions({
      filters: {
        purchasePresenceFilter: "none",
        postedDateFrom: from,
        postedDateTo: to,
      },
      pagination: { pageIndex: 0, pageSize: 200 },
      sort: [{ orderBy: "postedDate", direction: "desc" }],
    }),
    enabled: open && Number.isFinite(date),
  });
  const candidates = useMemo(
    () => rankSettlementCandidates(purchase, candidatesQuery.data?.items ?? []),
    [purchase, candidatesQuery.data],
  );
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("financialTransaction", "update"),
    entity: "financialTransaction",
  });
  const queryClient = useQueryClient();
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Match statement activity
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Match statement activity</DialogTitle>
            <DialogDescription>
              Review unallocated charges and refunds near this order. Allocate
              the full statement amount across Purchases before saving.
            </DialogDescription>
          </DialogHeader>
          {!Number.isFinite(date) ? (
            <Description>
              Add the order date to see likely statement activity.
            </Description>
          ) : candidatesQuery.isPending ? (
            <Description>Checking statement activity…</Description>
          ) : null}
          {candidatesQuery.isError ? (
            <Description>{String(candidatesQuery.error)}</Description>
          ) : null}
          {candidatesQuery.isSuccess && !candidates.length ? (
            <Description>
              No unallocated vendor or exact amount match within 45 days. You
              can still add a transaction manually.
            </Description>
          ) : null}
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {candidates.map(({ transaction, days, merchantMatches }) => (
              <button
                key={transaction.id}
                type="button"
                aria-pressed={selected?.id === transaction.id}
                className="flex w-full items-start justify-between gap-3 rounded-md border border-border p-3 text-left text-sm aria-pressed:border-primary aria-pressed:bg-primary/5"
                onClick={() => {
                  setSelected(transaction);
                  setAllocations(
                    initialSettlementAllocations(
                      purchase.id,
                      transaction,
                      purchase,
                    ).map((row) => ({ ...row, key: crypto.randomUUID() })),
                  );
                }}
              >
                <span className="min-w-0">
                  <strong className="block truncate">
                    {transaction.merchant ?? transaction.displayName}
                  </strong>
                  <span className="block text-xs text-muted-foreground">
                    {transaction.kind === "refund" ? "Refund" : "Charge"}
                  </span>
                  {transaction.rawDescription &&
                  transaction.rawDescription !== transaction.merchant ? (
                    <span className="block text-xs text-muted-foreground">
                      Statement: {transaction.rawDescription}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground">
                    {transaction.postedDate ?? transaction.transactionDate} ·{" "}
                    {Math.round(days)} {Math.round(days) === 1 ? "day" : "days"}{" "}
                    apart
                    {merchantMatches
                      ? " · vendor name matches"
                      : " · vendor differs"}
                  </span>
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  {formatCurrency(transaction.amount)}
                </span>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-sm font-medium">
                Allocate {formatCurrency(selected.amount)}
              </div>
              {allocations.map((allocation, index) => (
                <div
                  key={allocation.key}
                  className="grid grid-cols-[1fr_8rem] gap-2"
                >
                  <label
                    htmlFor={`purchase-${allocation.key}`}
                    className="space-y-1 text-xs text-muted-foreground"
                  >
                    Purchase code
                    <Input
                      id={`purchase-${allocation.key}`}
                      aria-label={`Purchase code ${index + 1}`}
                      value={allocation.purchaseId}
                      onChange={(event) =>
                        setAllocations((current) =>
                          current.map((row, rowIndex) =>
                            rowIndex === index
                              ? { ...row, purchaseId: event.target.value }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <label
                    htmlFor={`amount-${allocation.key}`}
                    className="space-y-1 text-xs text-muted-foreground"
                  >
                    Amount
                    <Input
                      id={`amount-${allocation.key}`}
                      aria-label={`Amount ${index + 1}`}
                      type="number"
                      step="0.01"
                      value={allocation.amount}
                      onChange={(event) =>
                        setAllocations((current) =>
                          current.map((row, rowIndex) =>
                            rowIndex === index
                              ? { ...row, amount: event.target.value }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setAllocations((current) => [
                    ...current,
                    { key: crypto.randomUUID(), purchaseId: "", amount: "" },
                  ])
                }
              >
                Add Purchase
              </Button>
              {!parseSettlementAllocations(allocations, selected.amount) ? (
                <Description size="xs">
                  Enter unique Purchase codes whose signed amounts total{" "}
                  {formatCurrency(selected.amount)}.
                </Description>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !selected ||
                !parseSettlementAllocations(allocations, selected.amount) ||
                update.isPending
              }
              onClick={async () => {
                if (!selected) return;
                const parsedAllocations = parseSettlementAllocations(
                  allocations,
                  selected.amount,
                );
                if (!parsedAllocations) return;
                await update.mutateAsync({
                  id: selected.id,
                  data: { allocations: parsedAllocations },
                });
                // The global handler fires this ripple without awaiting it;
                // await it so the panel is fresh before the dialog closes.
                await invalidateOperationTags(
                  queryClient,
                  entityRipple("financialTransaction"),
                );
                setOpen(false);
                setSelected(null);
              }}
            >
              Save allocation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function FinancialSettlementStatus({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const settlement = purchase.financialReconciliation;
  const option = fieldEnumOptions("purchase", "financialReconciliation").find(
    (candidate) => candidate.value === settlement.status,
  );
  return (
    <EnumPill color={option?.color ?? "var(--slate)"}>
      {option?.label ?? settlement.status} · {settlement.transactionCount}
    </EnumPill>
  );
}
export function FinancialSettlement({
  purchase,
  onAddTransaction,
  onEditTransaction,
}: {
  purchase: FinancialPurchase;
  onAddTransaction?: () => void;
  onEditTransaction?: (transaction: FinancialTransactionOut) => void;
}) {
  const settlement = purchase.financialReconciliation;
  return (
    <Stack gap="sm">
      <Row align="center" justify="between">
        <FinancialSettlementStatus purchase={purchase} />
        <span className="font-mono text-sm tabular-nums">
          {settlement.transactionCount} entries
        </span>
      </Row>
      <Row align="center" justify="between">
        <span className="text-sm text-muted-foreground">Posted</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(settlement.postedTotal)}
        </span>
      </Row>
      <Row align="center" justify="between">
        <span className="text-sm text-muted-foreground">Projected</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(settlement.projectedTotal)}
        </span>
      </Row>
      {settlement.delta != null && (
        <Row align="center" justify="between">
          <span className="text-sm text-muted-foreground">Delta</span>
          <span className="font-mono tabular-nums">
            {formatCurrency(settlement.delta)}
          </span>
        </Row>
      )}
      <Description size="xs">
        Settlement amounts are evidence only. Expense lines remain Cubby&apos;s
        only source of spend.
      </Description>
      <LinkedTransactions
        purchaseId={purchase.id}
        onAddTransaction={onAddTransaction}
        onEditTransaction={onEditTransaction}
      />
      <MatchStatementTransaction purchase={purchase} />
    </Stack>
  );
}

export function financialTransactionCaptureRequestForPurchase(
  purchaseId: string,
): EntityEditDialogRequest<"financialTransaction"> {
  return captureRequest("financialTransaction", {
    purchaseId: parseShortcodeFor("purchase", purchaseId),
  });
}

/** Inspect and manage the transaction evidence behind a computed settlement. */
export function FinancialSettlementCell({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [dialogRequest, setDialogRequest] =
    useState<EntityEditDialogRequest<"financialTransaction"> | null>(null);

  const launch = (request: EntityEditDialogRequest<"financialTransaction">) => {
    setWorkbenchOpen(false);
    setDialogRequest(request);
  };

  return (
    <>
      <TableCellWorkbench
        title="Financial settlement"
        description={settlementProvenanceDescription}
        summary={<FinancialSettlementStatus purchase={purchase} />}
        open={workbenchOpen}
        onOpenChange={setWorkbenchOpen}
      >
        <FinancialSettlement
          purchase={purchase}
          onAddTransaction={() =>
            launch(financialTransactionCaptureRequestForPurchase(purchase.id))
          }
          onEditTransaction={(transaction) =>
            launch(financialTransactionEditRequest(transaction))
          }
        />
      </TableCellWorkbench>
      {dialogRequest ? (
        <EntityEditDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialogRequest(null);
          }}
          request={dialogRequest}
          onSuccess={() => setDialogRequest(null)}
        />
      ) : null}
    </>
  );
}
