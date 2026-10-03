import {
  type ValidationCorrection,
  type ValidationDiff,
  type ValidationNote,
  validationPlanLine,
} from "@cubby/schemas/purchase-import";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import type { RunDetail } from "~/contracts/run.contract";
import { purchaseImport } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { StatusText } from "~/ui/primitives/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { ShortcodeProse } from "~/ui/shortcode-prose";

const MONEY_FIELDS = new Set(["amount", "statedTotal"]);

/** A cell value as the person reads it: money as currency, a plan line as its title and amount. */
function formatDiffValue(
  field: string,
  value: ValidationCorrection["before"],
): string {
  if (value === null) return "—";
  const number = z.number().safeParse(value);
  if (number.success)
    return MONEY_FIELDS.has(field)
      ? formatCurrency(number.data)
      : String(number.data);
  const text = z.string().safeParse(value);
  if (text.success) return text.data;
  const line = validationPlanLine
    .pick({ title: true, amount: true })
    .safeParse(value);
  if (line.success)
    return `${line.data.title} · ${formatCurrency(line.data.amount)}`;
  return JSON.stringify(value);
}

const RECORD_LABEL = {
  purchase: "Purchase",
  expense: "Expense",
} as const;

function DiffCells({ item }: { item: ValidationCorrection | ValidationNote }) {
  return (
    <>
      <TableCell className="whitespace-normal">
        <span className="text-muted-foreground">
          {RECORD_LABEL[item.target.kind]}{" "}
        </span>
        <ShortcodeProse>{item.target.code}</ShortcodeProse>
      </TableCell>
      <TableCell className="whitespace-normal">
        <span>{item.field}</span>
        {"message" in item ? (
          <p className="mt-1 text-muted-foreground">{item.message}</p>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-normal text-muted-foreground">
        {formatDiffValue(item.field, item.before)}
      </TableCell>
      <TableCell className="whitespace-normal">
        {formatDiffValue(item.field, item.after)}
      </TableCell>
    </>
  );
}

/**
 * Before/after table for a v2 purchase-validation diff. Applicable corrections
 * start selected; notes (differences validation will not change, such as an
 * explicit Product assignment) are visible but not selectable. Apply is a
 * person's action: the server recomputes the selection against live records
 * and refuses, writing nothing, when any of it has gone stale.
 */
export function ValidationCorrectionsReview({
  runId,
  purchaseId,
  diff,
}: {
  runId: RunDetail["publicId"];
  purchaseId: string;
  diff: ValidationDiff;
}) {
  const [selected, setSelected] = useState(
    () => new Set(diff.corrections.map((correction) => correction.id)),
  );
  // One id per distinct attempt: a retry of the same selection replays, a new
  // selection (or a refreshed diff) gets a new operation.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const apply = useMutation(
    purchaseImport.applyValidationCorrections.mutationOptions({
      onSettled: () => setOperationId(crypto.randomUUID()),
    }),
  );
  const toggle = (id: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setOperationId(crypto.randomUUID());
  };
  const count = selected.size;
  return (
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
        Select the corrections to apply. Product assignments already on an
        Expense are kept, and settlement is never changed.
      </p>
      <Table className="min-w-[560px] tabular-nums">
        <colgroup>
          <col className="w-[10%]" />
          <col className="w-[22%]" />
          <col className="w-[30%]" />
          <col className="w-[19%]" />
          <col className="w-[19%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead className="h-auto py-2">Apply</TableHead>
            <TableHead className="h-auto py-2">Record</TableHead>
            <TableHead className="h-auto py-2">Field</TableHead>
            <TableHead className="h-auto py-2">Before</TableHead>
            <TableHead className="h-auto py-2">After</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {diff.corrections.map((correction) => (
            <TableRow key={correction.id}>
              <TableCell>
                <Checkbox
                  aria-label={`Apply ${correction.field} correction to ${correction.target.code}`}
                  checked={selected.has(correction.id)}
                  onCheckedChange={(checked) =>
                    toggle(correction.id, checked === true)
                  }
                />
              </TableCell>
              <DiffCells item={correction} />
            </TableRow>
          ))}
          {diff.notes.map((note) => (
            <TableRow key={note.id} className="text-muted-foreground">
              <TableCell>
                <Badge variant="outline">Note</Badge>
              </TableCell>
              <DiffCells item={note} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Row wrap gap="sm" align="center">
        <Button
          type="button"
          size="sm"
          disabled={count === 0 || apply.isPending}
          onClick={() =>
            apply.mutate({
              runId,
              purchaseId,
              operationId,
              correctionIds: diff.corrections
                .filter((correction) => selected.has(correction.id))
                .map((correction) => correction.id),
            })
          }
        >
          {apply.isPending
            ? "Applying…"
            : `Apply ${count} selected correction${count === 1 ? "" : "s"}`}
        </Button>
      </Row>
      {apply.isError ? (
        <StatusText tone="destructive">{apply.error.message}</StatusText>
      ) : null}
      {apply.data?.status === "stale" ? (
        <Stack gap="tight" role="alert">
          <StatusText tone="destructive">
            Nothing was changed: the live records no longer match what was
            reviewed. Run validation again to review current differences.
          </StatusText>
          {apply.data.stale.map((entry) => (
            <p
              key={`${entry.correctionId ?? "purchase"}`}
              className="font-mono text-xs text-muted-foreground"
            >
              {entry.correctionId ? `${entry.correctionId}: ` : ""}
              {entry.reason}
            </p>
          ))}
        </Stack>
      ) : null}
      {apply.data?.status === "applied" ? (
        <StatusText tone="positive">
          Applied {apply.data.applied.length} correction
          {apply.data.applied.length === 1 ? "" : "s"};{" "}
          {apply.data.remainingCorrections} still to review.
        </StatusText>
      ) : null}
    </Stack>
  );
}
