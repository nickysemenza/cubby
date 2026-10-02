import { productShortcode } from "@cubby/schemas/identifiers";
import { preparedProductResolution } from "@cubby/schemas/purchase-import";
import {
  TRADE_LABELS,
  tradeSchema,
  tradeValues,
} from "@cubby/schemas/task-fields";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";

import type { RunDetail } from "~/contracts/run.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { run as runOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { EntityPicker } from "~/ui/combobox/entity-picker";
import { referenceEntitySearch } from "~/ui/combobox/reference-entity-search";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { NativeSelect } from "~/ui/primitives/native-select";
import { StatusText } from "~/ui/primitives/status-text";
import { Textarea } from "~/ui/primitives/textarea";

type PreparedOrder = RunDetail["preparedOrders"][number];
type PreparedLine = PreparedOrder["lines"][number];
type Resolution = z.infer<typeof preparedProductResolution>;
const WithProductSearch = referenceEntitySearch("product");
const lineKey = (order: PreparedOrder, line: PreparedLine) =>
  JSON.stringify([order.stableOrderId, line.stableLineId]);

function PreparedLineReview({
  line,
  disabled,
  onResolution,
}: {
  line: PreparedLine;
  disabled: boolean;
  onResolution: (resolution: Resolution | null) => void;
}) {
  const [kind, setKind] = useState<Resolution["kind"] | "">("");
  const [selected, setSelected] = useState<ComboboxItem | null>(null);
  const [reason, setReason] = useState("");
  const exactCount = line.candidates.filter(
    (candidate) => candidate.exactIdentifierMatch,
  ).length;
  const chooseProduct = (item: ComboboxItem | null) => {
    setSelected(item);
    setKind("existing");
    onResolution(
      item
        ? { kind: "existing", productId: productShortcode.parse(item.id) }
        : null,
    );
  };
  return (
    <Stack gap="sm" className="border-t border-border py-3">
      <Row wrap gap="sm" justify="between" align="baseline">
        <span className="text-sm font-medium">{line.title}</span>
        <span className="font-mono text-xs tabular-nums">
          {formatCurrency(line.amount)}
        </span>
      </Row>
      {Object.entries(line.identifiers).length > 0 && (
        <Row wrap gap="sm" className="font-mono text-xs text-muted-foreground">
          {Object.entries(line.identifiers).map(([key, value]) => (
            <span key={key}>
              {key}: {value}
            </span>
          ))}
        </Row>
      )}
      {!line.requiresProductResolution ? (
        <StatusText>Purchase adjustment · no Product selection</StatusText>
      ) : (
        <>
          {exactCount > 1 && (
            <StatusText tone="warning">
              Conflicting exact matches. Choose the Product to use.
            </StatusText>
          )}
          {line.candidates.length > 0 && (
            <Stack gap="xs">
              {line.candidates.map((candidate) => (
                <Row wrap gap="sm" key={candidate.productId}>
                  <EntityRefLink
                    entity="product"
                    data={{
                      id: candidate.productId,
                      name: candidate.name,
                      manufacturer: candidate.manufacturer,
                    }}
                    displayImage={null}
                  />
                  {candidate.exactIdentifierMatch && (
                    <Badge variant="outline">Exact identifier</Badge>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      chooseProduct({
                        id: candidate.productId,
                        name: candidate.name,
                      })
                    }
                  >
                    Use {candidate.name}
                  </Button>
                </Row>
              ))}
            </Stack>
          )}
          <label className="flex flex-col gap-1 text-xs">
            <span>Product decision for {line.title}</span>
            <NativeSelect
              aria-label={`Product decision for ${line.title}`}
              value={kind}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value;
                if (
                  next !== "" &&
                  next !== "existing" &&
                  next !== "new" &&
                  next !== "unresolved"
                )
                  return;
                setKind(next);
                const resolution = preparedProductResolution.safeParse(
                  next === "existing"
                    ? { kind: next, productId: selected?.id }
                    : next === "unresolved"
                      ? { kind: next, reason }
                      : { kind: next },
                );
                onResolution(resolution.success ? resolution.data : null);
              }}
            >
              <option value="">Choose a decision…</option>
              <option value="existing">Use an existing Product</option>
              <option value="new">Create a new Product</option>
              <option value="unresolved">Leave Product unresolved</option>
            </NativeSelect>
          </label>
          {kind === "existing" && (
            <WithProductSearch>
              {({ items, onSearchChange, onOpenChange, isLoading }) => (
                <EntityPicker
                  entity="product"
                  label={`Product for ${line.title}`}
                  items={items}
                  value={selected}
                  setValue={chooseProduct}
                  onSearchChange={onSearchChange}
                  onOpenChange={onOpenChange}
                  isLoading={isLoading}
                  disabled={disabled}
                />
              )}
            </WithProductSearch>
          )}
          {kind === "new" && (
            <StatusText>
              A new Product will use this prepared line’s title and identifiers.
            </StatusText>
          )}
          {kind === "unresolved" && (
            <label className="flex flex-col gap-1 text-xs">
              <span>Reason for leaving {line.title} unresolved</span>
              <Textarea
                aria-label={`Reason for leaving ${line.title} unresolved`}
                value={reason}
                disabled={disabled}
                onChange={(event) => {
                  setReason(event.target.value);
                  const resolution = preparedProductResolution.safeParse({
                    kind: "unresolved",
                    reason: event.target.value,
                  });
                  onResolution(resolution.success ? resolution.data : null);
                }}
              />
            </label>
          )}
        </>
      )}
    </Stack>
  );
}

function PreparedBatchReview({
  run,
  orders,
}: {
  run: RunDetail;
  orders: PreparedOrder[];
}) {
  const [resolutions, setResolutions] = useState(new Map<string, Resolution>());
  const [trade, setTrade] = useState<z.infer<typeof tradeSchema> | "">("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const commit = useMutation(
    runOperations.commitPrepared.mutationOptions({
      onError: (error) => showErrorToast(error),
    }),
  );
  const required = orders.flatMap((order) =>
    order.lines
      .filter((line) => line.requiresProductResolution)
      .map((line) => ({ order, line })),
  );
  const remaining = required.filter(
    ({ order, line }) => !resolutions.has(lineKey(order, line)),
  ).length;
  const committed =
    orders.every((order) => order.committed) || commit.isSuccess;
  const disabled =
    committed ||
    commit.isPending ||
    run.status !== "running" ||
    run.purpose !== "account_sync";
  return (
    <Stack gap="md">
      {orders.map((order) => (
        <Stack key={order.stableOrderId} gap="sm">
          <Row wrap gap="sm" justify="between">
            <span className="text-xs text-muted-foreground">
              {order.sourceKind} · {order.externalKey ?? order.stableOrderId}
            </span>
            <span className="text-xs text-muted-foreground">
              {order.lineCount} lines
            </span>
          </Row>
          {order.lines.map((line) => (
            <PreparedLineReview
              key={line.stableLineId}
              line={line}
              disabled={disabled}
              onResolution={(resolution) => {
                setOperationId(crypto.randomUUID());
                setResolutions((previous) => {
                  const next = new Map(previous);
                  if (resolution) next.set(lineKey(order, line), resolution);
                  else next.delete(lineKey(order, line));
                  return next;
                });
              }}
            />
          ))}
        </Stack>
      ))}
      {committed ? (
        <StatusText>Prepared import approved and committed.</StatusText>
      ) : (
        run.purpose === "account_sync" && (
          <Stack gap="sm">
            {required.length > 0 && (
              <label className="flex flex-col gap-1 text-xs">
                <span>Trade for imported expenses</span>
                <NativeSelect
                  aria-label="Trade for imported expenses"
                  value={trade}
                  disabled={disabled}
                  onChange={(event) => {
                    const parsed = tradeSchema.safeParse(event.target.value);
                    setTrade(parsed.success ? parsed.data : "");
                    setOperationId(crypto.randomUUID());
                  }}
                >
                  <option value="">Choose a trade…</option>
                  {tradeValues.map((value) => (
                    <option key={value} value={value}>
                      {TRADE_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            <StatusText>
              {remaining
                ? `${remaining} Product decision${remaining === 1 ? "" : "s"} remaining.`
                : "All Product decisions reviewed."}{" "}
              Approval imports the prepared orders and expenses.
            </StatusText>
            {commit.isError && (
              <StatusText tone="destructive">{commit.error.message}</StatusText>
            )}
            <Button
              type="button"
              disabled={
                disabled || remaining > 0 || (required.length > 0 && !trade)
              }
              onClick={() => {
                const first = orders[0];
                if (!first || remaining || (required.length && !trade)) return;
                commit.mutate({
                  runId: run.publicId,
                  operationId,
                  prepareOperationId: first.prepareOperationId,
                  defaultTrade: trade || undefined,
                  resolutions: required.flatMap(({ order, line }) => {
                    const resolution = resolutions.get(lineKey(order, line));
                    return resolution
                      ? [
                          {
                            stableOrderId: order.stableOrderId,
                            stableLineId: line.stableLineId,
                            resolution,
                          },
                        ]
                      : [];
                  }),
                });
              }}
            >
              {commit.isPending ? "Importing…" : "Approve and import"}
            </Button>
          </Stack>
        )
      )}
    </Stack>
  );
}

export function PreparedPurchaseReview({ run }: { run: RunDetail }) {
  const batches = new Map<string, PreparedOrder[]>();
  for (const order of run.preparedOrders) {
    const batch = batches.get(order.prepareOperationId) ?? [];
    batch.push(order);
    batches.set(order.prepareOperationId, batch);
  }
  if (!batches.size) return <StatusText>No orders were prepared.</StatusText>;
  return (
    <Stack gap="lg">
      {[...batches].map(([id, orders]) => (
        <PreparedBatchReview key={id} run={run} orders={orders} />
      ))}
    </Stack>
  );
}
