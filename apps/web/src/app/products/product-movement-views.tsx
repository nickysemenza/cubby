import type {
  ProductFilters,
  ProductMovementGroupOut,
  ProductMovementLineOut,
  ProductMovementProductOut,
} from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, CalendarClock } from "lucide-react";
import { useId, useMemo } from "react";

import { DatePickerInput } from "~/app/_components/date-picker-input";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { product as productOperations } from "~/app/products/product.functions";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { Grid, Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { DotLabel } from "~/components/ui/dot-label";
import { Skeleton } from "~/components/ui/skeleton";
import { StatTile } from "~/components/ui/stat-tile";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { parsePlainDate } from "~/lib/plain-date";
import { clipOwnershipIntervals } from "~/lib/product-movement";
import { cn, formatCurrency } from "~/lib/utils";

const route = getRouteApi("/_authenticated/products/");

type TimelineView = "events" | "lifecycles";

const KIND_LABEL = {
  acquired: "Acquired",
  exited: "Exited",
  discarded: "Discarded",
  adjusted: "Price adjusted",
  unknown: "Unknown",
} as const;

const KIND_COLOR = {
  acquired: "var(--positive)",
  exited: "var(--destructive)",
  discarded: "var(--warning)",
  // Money-only, so it takes the neutral tone rather than `exited`'s
  // destructive one — nothing left the house on this row.
  adjusted: "var(--muted-foreground)",
  unknown: "var(--muted-foreground)",
} as const;

function formatMovementDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsePlainDate(date));
}

function MovementControls({ order }: { order: "asc" | "desc" }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const fromId = useId();
  const toId = useId();
  return (
    <Row align="end" wrap gap="sm">
      <label htmlFor={fromId} className="text-xs text-muted-foreground">
        From
        <DatePickerInput
          id={fromId}
          value={search.movementFrom ?? null}
          max={search.movementTo}
          clearable
          onChange={(value) =>
            navigate({
              search: (previous) => ({
                ...previous,
                movementFrom: value ?? undefined,
              }),
              replace: true,
            })
          }
          className="mt-1 w-40"
        />
      </label>
      <label htmlFor={toId} className="text-xs text-muted-foreground">
        To
        <DatePickerInput
          id={toId}
          value={search.movementTo ?? null}
          min={search.movementFrom}
          clearable
          onChange={(value) =>
            navigate({
              search: (previous) => ({
                ...previous,
                movementTo: value ?? undefined,
              }),
              replace: true,
            })
          }
          className="mt-1 w-40"
        />
      </label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          navigate({
            search: (previous) => ({
              ...previous,
              movementOrder: order === "desc" ? "asc" : "desc",
            }),
          })
        }
      >
        {order === "desc" ? <ArrowDown /> : <ArrowUp />}
        {order === "desc" ? "Newest first" : "Oldest first"}
      </Button>
    </Row>
  );
}

function MovementSummary({
  summary,
}: {
  summary: {
    matchingProducts: number;
    movementCount: number;
    spent: number;
    recovered: number;
    netCost: number;
    unknownAmountCount: number;
  };
}) {
  return (
    <Grid cols="summary">
      <StatTile label="Products">{summary.matchingProducts}</StatTile>
      <StatTile label="Movements">{summary.movementCount}</StatTile>
      <StatTile label="Spent">{formatCurrency(summary.spent)}</StatTile>
      <StatTile label="Recovered">{formatCurrency(summary.recovered)}</StatTile>
      <StatTile label="Net cost">{formatCurrency(summary.netCost)}</StatTile>
      <StatTile label="Unknown / unitemized">
        {summary.unknownAmountCount}
      </StatTile>
    </Grid>
  );
}

function MovementAmount({ movement }: { movement: ProductMovementLineOut }) {
  if (movement.provenanceOnly) {
    return <Description size="xs">Unitemized</Description>;
  }
  if (movement.cost === null) {
    return <Description size="xs">Amount unknown</Description>;
  }
  if (movement.cost < 0) {
    return (
      <span className="font-mono text-positive tabular-nums">
        {formatCurrency(-movement.cost)} recovered
      </span>
    );
  }
  return (
    <span className="font-mono tabular-nums">
      {formatCurrency(movement.cost)}
    </span>
  );
}

function MovementLine({
  movement,
  product,
  groupDate,
}: {
  movement: ProductMovementLineOut;
  product: ProductMovementProductOut | undefined;
  groupDate: string;
}) {
  return (
    <div className="grid gap-2 border-t border-[var(--border)] px-4 py-2 md:grid-cols-[minmax(14rem,1fr)_8rem_10rem_minmax(12rem,1fr)] md:items-center">
      <Stack gap="tight" className="min-w-0">
        <EntityInlineLink
          displayImage={undefined}
          entity="product"
          data={{
            id: movement.productId,
            name: product?.name ?? movement.name,
            manufacturer: product?.manufacturer,
          }}
          truncate
        />
        {movement.expenseId ? (
          <EntityInlineLink
            displayImage={undefined}
            entity="expense"
            data={{
              id: movement.expenseId,
              name: movement.name,
              cost: movement.cost,
              projectName: movement.chargedTo?.name,
            }}
            compact
          />
        ) : (
          <Description size="xs">Purchase provenance only</Description>
        )}
      </Stack>
      <Stack gap="tight">
        <DotLabel color={KIND_COLOR[movement.kind]}>
          {KIND_LABEL[movement.kind]}
        </DotLabel>
        <Description size="xs">
          {movement.provenanceOnly
            ? "Amount and quantity not itemized"
            : movement.quantity === null
              ? "Quantity unknown"
              : movement.quantity === 0
                ? "No unit moved"
                : `${Math.abs(movement.quantity)} unit${Math.abs(movement.quantity) === 1 ? "" : "s"}`}
        </Description>
      </Stack>
      <MovementAmount movement={movement} />
      <Stack gap="tight">
        {movement.chargedTo ? (
          <Row align="center" gap="xs">
            <Description size="xs">Charged to</Description>
            <EntityInlineLink
              displayImage={undefined}
              entity="project"
              data={movement.chargedTo}
              compact
            />
          </Row>
        ) : (
          <Description size="xs">No charged project</Description>
        )}
        {movement.expenseDate !== groupDate && (
          <Description size="xs">
            Ledger date {formatMovementDate(movement.expenseDate)}
          </Description>
        )}
      </Stack>
    </div>
  );
}

function EventGroup({
  group,
  productsById,
}: {
  group: ProductMovementGroupOut;
  productsById: Map<string, ProductMovementProductOut>;
}) {
  return (
    <section className="border border-[var(--border)]">
      <Row
        align="center"
        justify="between"
        wrap
        gap="sm"
        className="bg-muted/40 p-4"
      >
        <Stack gap="tight">
          <span className="font-mono text-sm tabular-nums">
            {formatMovementDate(group.date)}
          </span>
          {group.purchase ? (
            <EntityInlineLink
              displayImage={undefined}
              entity="purchase"
              data={{
                id: group.purchase.id,
                orderId: group.purchase.orderId,
                displayLabel: group.purchase.displayLabel,
                vendorName: group.purchase.vendor?.name,
                date: group.purchase.date,
              }}
            />
          ) : (
            <Description size="xs">Standalone movement</Description>
          )}
        </Stack>
        {group.purchase?.vendor && (
          <EntityInlineLink
            displayImage={undefined}
            entity="vendor"
            data={group.purchase.vendor}
          />
        )}
      </Row>
      {group.movements.map((movement) => (
        <MovementLine
          key={movement.expenseId ?? `${group.key}:${movement.productId}`}
          movement={movement}
          product={productsById.get(movement.productId)}
          groupDate={group.date}
        />
      ))}
    </section>
  );
}

function EventsView({
  groups,
  products,
}: {
  groups: ProductMovementGroupOut[];
  products: ProductMovementProductOut[];
}) {
  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );
  if (groups.length === 0) {
    return (
      <ChartEmpty
        icon={CalendarClock}
        title="No recorded movements match this window."
      />
    );
  }
  return (
    <Stack gap="sm">
      {groups.map((group) => (
        <EventGroup key={group.key} group={group} productsById={productsById} />
      ))}
    </Stack>
  );
}

type LifecycleMarker = ProductMovementLineOut & {
  date: string;
  groupKey: string;
};

function markerClass(kind: ProductMovementLineOut["kind"]): string {
  if (kind === "acquired") return "border-positive bg-positive";
  if (kind === "exited") return "border-destructive bg-destructive";
  if (kind === "discarded") return "border-warning bg-warning";
  // Muted like "unknown": a concession moved money, not units, so it should not
  // read on the lifecycle strip as an ownership event.
  return "border-muted-foreground bg-muted-foreground";
}

function LifecyclesView({
  groups,
  products,
  extent,
}: {
  groups: ProductMovementGroupOut[];
  products: ProductMovementProductOut[];
  extent: { from: string; to: string } | null;
}) {
  const markersByProduct = useMemo(() => {
    const result = new Map<string, LifecycleMarker[]>();
    for (const group of groups) {
      for (const movement of group.movements) {
        const current = result.get(movement.productId);
        const marker = { ...movement, date: group.date, groupKey: group.key };
        if (current) current.push(marker);
        else result.set(movement.productId, [marker]);
      }
    }
    return result;
  }, [groups]);

  if (!extent) {
    return (
      <ChartEmpty
        icon={CalendarClock}
        title="No recorded movements match this window."
      />
    );
  }

  const start = parsePlainDate(extent.from).getTime();
  const end = parsePlainDate(extent.to).getTime();
  const span = Math.max(end - start, 86_400_000);
  const position = (date: string) =>
    Math.max(
      0,
      Math.min(100, ((parsePlainDate(date).getTime() - start) / span) * 100),
    );
  const visibleProducts = products.filter(
    (product) => (markersByProduct.get(product.id)?.length ?? 0) > 0,
  );

  return (
    <div className="overflow-x-auto border border-[var(--border)]">
      <div className="min-w-[64rem]">
        <div className="grid grid-cols-[16rem_1fr] border-b border-[var(--border)] bg-muted/40">
          <div className="sticky left-0 z-10 border-r border-[var(--border)] bg-muted p-2 font-mono text-xs tracking-wider uppercase">
            Product
          </div>
          <Row justify="between" className="p-2 font-mono text-xs">
            <span>{formatMovementDate(extent.from)}</span>
            <span>{formatMovementDate(extent.to)}</span>
          </Row>
        </div>
        {visibleProducts.map((product) => {
          const markers = markersByProduct.get(product.id) ?? [];
          const visibleIntervals = clipOwnershipIntervals(
            product.ownershipIntervals,
            extent.from,
            extent.to,
          );
          return (
            <div
              key={product.id}
              className="grid grid-cols-[16rem_1fr] border-b border-[var(--border)] last:border-b-0"
            >
              <Stack
                gap="tight"
                className="sticky left-0 z-10 min-w-0 border-r border-[var(--border)] bg-background p-2"
              >
                <EntityInlineLink
                  displayImage={undefined}
                  entity="product"
                  data={product}
                  truncate
                />
                {product.usedOnProjects.length > 0 && (
                  <Row align="center" wrap gap="xs">
                    <Description size="xs">Used on</Description>
                    {product.usedOnProjects.slice(0, 2).map((project) => (
                      <EntityInlineLink
                        displayImage={undefined}
                        key={project.id}
                        entity="project"
                        data={project}
                        compact
                      />
                    ))}
                    {product.usedOnProjects.length > 2 && (
                      <Description size="xs">
                        +{product.usedOnProjects.length - 2} more
                      </Description>
                    )}
                  </Row>
                )}
                {product.confidenceLostAt && (
                  <Description size="xs">
                    Ownership uncertain after {product.confidenceLostAt}
                  </Description>
                )}
              </Stack>
              <div className="relative h-16 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[length:25%_100%]">
                {visibleIntervals.map((interval) => {
                  const left = position(interval.start);
                  const right = position(interval.end);
                  return (
                    <div
                      key={`${interval.start}:${interval.end}`}
                      className="absolute top-7 h-2 rounded-full bg-positive/30"
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(right - left, 0.5)}%`,
                      }}
                    />
                  );
                })}
                {markers.map((marker) => (
                  <Tooltip
                    key={
                      marker.expenseId ??
                      `${marker.groupKey}:${marker.productId}:provenance`
                    }
                  >
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "absolute top-5 size-3 -translate-x-1/2 rounded-full border-2",
                            markerClass(marker.kind),
                          )}
                          style={{ left: `${position(marker.date)}%` }}
                        />
                      }
                    />
                    <TooltipContent>
                      {formatMovementDate(marker.date)} ·{" "}
                      {KIND_LABEL[marker.kind]}
                      {marker.cost === null
                        ? " · amount unknown"
                        : ` · ${formatCurrency(Math.abs(marker.cost))}`}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProductMovementViews({
  filters,
  view,
}: {
  filters: ProductFilters;
  view: TimelineView;
}) {
  const search = route.useSearch();
  const order = search.movementOrder ?? "desc";
  const { data, isError, isLoading } = useQuery({
    ...productOperations.movementTimeline.queryOptions({
      filters,
      movementFrom: search.movementFrom,
      movementTo: search.movementTo,
      order,
    }),
    staleTime: 60_000,
  });

  if (isError) {
    return (
      <ChartEmpty
        icon={CalendarClock}
        title="The Product movement timeline could not be loaded. Check the date range and try again."
      />
    );
  }

  if (isLoading || !data) {
    return (
      <Stack gap="md">
        <Skeleton className="h-10 w-full" />
        <Grid cols="summary">
          {[
            "products",
            "movements",
            "spent",
            "recovered",
            "net-cost",
            "unknown",
          ].map((label) => (
            <Skeleton key={label} className="h-14 w-full" />
          ))}
        </Grid>
        <Skeleton className="h-64 w-full" />
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <MovementControls order={order} />
      <MovementSummary summary={data.summary} />
      {(data.omitted.productsWithoutMovements > 0 ||
        data.omitted.plannedMovements > 0) && (
        <Description>
          {data.omitted.productsWithoutMovements > 0 && (
            <>
              {data.omitted.productsWithoutMovements} matching Product
              {data.omitted.productsWithoutMovements === 1 ? " has" : "s have"}
              no displayed movement in this window.{" "}
              <Link
                to="/products"
                search={(previous) => ({ ...previous, view: undefined })}
                className="underline underline-offset-2"
              >
                Open the complete Table
              </Link>
              .{" "}
            </>
          )}
          {data.omitted.plannedMovements > 0 && (
            <>
              {data.omitted.plannedMovements} planned movement
              {data.omitted.plannedMovements === 1
                ? " is"
                : "s are"} omitted.{" "}
              <Link
                to="/expenses"
                search={{ future: "true", product: "has" }}
                className="underline underline-offset-2"
              >
                Open planned product expenses
              </Link>
              .
            </>
          )}
        </Description>
      )}
      {view === "events" ? (
        <EventsView groups={data.groups} products={data.products} />
      ) : (
        <LifecyclesView
          groups={data.groups}
          products={data.products}
          extent={data.extent}
        />
      )}
    </Stack>
  );
}
