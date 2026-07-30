import type { ExpenseId } from "@cubby/schemas/identifiers";
import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import { useMemo, useState } from "react";
import { match } from "ts-pattern";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { TradeBadge } from "~/app/projects/trade-options";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  FilterableCombobox,
  type FilterableComboboxItem,
} from "~/components/ui/combobox";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { NoneValue } from "~/components/ui/none-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { useActionMutation } from "../_components/hooks/useActionMutation";

const NO_CANDIDATES: ExpenseOut[] = [];

/** Generous for one vendor's ledger lines, within MAX_PAGE_SIZE. */
const CANDIDATE_PAGE_SIZE = 100;

/**
 * How wide to cast for candidate lines.
 *
 * `vendorPresenceFilter: "none"` ORs with `vendorId` rather than ANDing (see
 * `expenseFilterFields`), so the default is literally one filter: "this vendor
 * OR no charge recorded". Deliberately NOT scoped by `orderId` — the contractor
 * case this operation exists for is an invoice whose lines never got an order
 * id, so filtering to order-bearing rows would hide exactly the rows we need.
 */
type CandidateScope = "vendorOrUnattached" | "unattached" | "any";

const SCOPE_OPTIONS: FilterableComboboxItem[] = [
  { value: "vendorOrUnattached", label: "This vendor or unattached" },
  { value: "unattached", label: "Unattached lines only" },
  { value: "any", label: "Any ledger line" },
];

/**
 * Attach existing ledger lines to this charge — one invoice spanning trades
 * (Flow Form Plumbing's $2,516 covering rough-in *and* fixtures, which is two
 * expenses with different `trade` values under one charge).
 *
 * Explicitly not "group by order id": a contractor's invoice usually has no
 * order id at all, which is why the picker's default scope is vendor-or-
 * unattached rather than anything keyed on `orderId`.
 *
 * Nothing is pre-validated here beyond the scoping — `linkExpensesToPurchase`
 * only refuses on a missing charge, and that refusal surfaces as this dialog's
 * error toast rather than as a rule duplicated in the UI.
 */
export function LinkExpensesDialog({
  open,
  onOpenChange,
  purchase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: PurchaseOut;
}) {
  const api = useTRPC();
  const [selected, setSelected] = useState<ExpenseId[]>([]);
  const [scope, setScope] = useState<CandidateScope>("vendorOrUnattached");
  const [searchInput, setSearchInput] = useState("");
  const [search] = useDebouncedValue(searchInput, { wait: 300 });

  const filters = useMemo<ExpenseFilters>(() => {
    const term = search.trim() || undefined;
    return match(scope)
      .with("vendorOrUnattached", () => ({
        vendorId: purchase.vendorId,
        vendorPresenceFilter: "none" as const,
        search: term,
      }))
      .with("unattached", () => ({
        vendorPresenceFilter: "none" as const,
        search: term,
      }))
      .with("any", () => ({ search: term }))
      .exhaustive();
  }, [scope, purchase.vendorId, search]);

  const candidatesQuery = useQuery({
    ...api.expense.list.queryOptions({
      filters,
      pagination: { pageIndex: 0, pageSize: CANDIDATE_PAGE_SIZE },
    }),
    enabled: open,
  });

  // Lines already filed under THIS charge are its existing lines, not
  // candidates. Lines under some OTHER charge stay in the list on purpose (they
  // move off it) — the row's Charge column is what makes that visible.
  const candidates = useMemo(
    () =>
      candidatesQuery.data?.items.filter(
        (row) => row.purchaseId !== purchase.id,
      ) ?? NO_CANDIDATES,
    [candidatesQuery.data, purchase.id],
  );

  const selectedTotal = useMemo(
    () =>
      sumBy(
        candidates.filter((row) => selected.includes(row.id)),
        (row) => row.cost ?? 0,
      ),
    [candidates, selected],
  );

  const linkMutation = useActionMutation({
    mutationFn: api.purchase.link.mutationOptions,
    success: "Lines attached to this charge",
    invalidateKeys: purchaseMutationInvalidateKeys,
    onSuccess: () => {
      setSelected([]);
      onOpenChange(false);
    },
  });

  const toggle = (id: ExpenseId) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected([]);
        onOpenChange(next);
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Attach lines to {purchaseLabel(purchase)}</DialogTitle>
          <DialogDescription>
            One invoice can span trades — a plumber's single charge covering
            rough-in and fixtures is two ledger lines under one charge.
            Attaching moves each line onto this charge (and off whatever charge
            it was on).
          </DialogDescription>
        </DialogHeader>

        <Row align="center" gap="sm">
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search line names…"
            className="flex-1"
          />
          <FilterableCombobox
            items={SCOPE_OPTIONS}
            value={scope}
            onValueChange={(next) => {
              // Bounded roster of three; a cleared picker is a no-op, not a
              // silent widening to every ledger line.
              if (next) setScope(next as CandidateScope);
            }}
            className="w-56 shrink-0"
          />
        </Row>

        {candidatesQuery.isPending ? (
          <Description>Loading lines…</Description>
        ) : candidates.length === 0 ? (
          <Empty variant="minimal" className="py-6">
            <EmptyTitle>No lines to attach</EmptyTitle>
            <EmptyDescription>
              Nothing matches this scope. Widen it to any ledger line, or clear
              the search.
            </EmptyDescription>
          </Empty>
        ) : (
          // `table-fixed` (the primitive's default) with sized columns, so the
          // picker always fits the dialog and long names truncate instead of
          // pushing the Charge column out of view.
          <Table containerClassName="max-h-72 overflow-y-auto border border-[var(--border)]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Line</TableHead>
                <TableHead className="w-24">Date</TableHead>
                <TableHead className="w-20 text-right">Cost</TableHead>
                <TableHead className="w-36">Trade</TableHead>
                <TableHead className="w-32">Project</TableHead>
                <TableHead className="w-24">Charge</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={
                    selected.includes(row.id) ? "selected" : undefined
                  }
                >
                  <TableCell>
                    <Checkbox
                      checked={selected.includes(row.id)}
                      onCheckedChange={() => toggle(row.id)}
                      aria-label={`Attach ${row.name}`}
                    />
                  </TableCell>
                  {/* `{id, name}` only — passing the whole row would make the
                      link render its own cost annotation next to the Cost
                      column. */}
                  <TableCell>
                    <EntityInlineLink
                      entity="expense"
                      data={{ id: row.id, name: row.name }}
                      truncate
                    />
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground tabular-nums">
                    {row.date ?? <NoneValue />}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.cost != null ? (
                      formatCurrency(row.cost)
                    ) : (
                      <NoneValue />
                    )}
                  </TableCell>
                  <TableCell>
                    <TradeBadge trade={row.trade} />
                  </TableCell>
                  <TableCell className="truncate">
                    {row.projectId && row.projectName ? (
                      <EntityInlineLink
                        entity="project"
                        data={{ id: row.projectId, name: row.projectName }}
                        truncate
                      />
                    ) : (
                      <NoneValue />
                    )}
                  </TableCell>
                  {/* Which charge the line is on TODAY — the one thing that
                      makes "attach" honest, since attaching an already-filed
                      line moves it off that charge. */}
                  <TableCell className="truncate text-muted-foreground">
                    {row.purchaseId ? (
                      (row.vendor ?? "another charge")
                    ) : (
                      <span className="font-mono text-2xs text-slate uppercase tracking-wider">
                        unattached
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Description size="xs">
          A payment schedule is NOT one invoice — separate charges stay separate
          purchases. Attach only lines that are genuinely part of this one
          transaction.
        </Description>

        <DialogFooter>
          <Stack gap="tight" className="mr-auto text-left">
            <span className="font-mono text-xs tabular-nums">
              {selected.length} selected · {formatCurrency(selectedTotal)}
            </span>
            {selected.length > 0 && (
              <Description size="2xs">
                Charge total would go to{" "}
                {formatCurrency(purchase.expenseTotal + selectedTotal)}
              </Description>
            )}
          </Stack>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.length === 0 || linkMutation.isPending}
            onClick={() =>
              linkMutation.mutate({
                purchaseId: purchase.id,
                expenseIds: selected,
              })
            }
          >
            {linkMutation.isPending
              ? "Attaching..."
              : `Attach ${selected.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
