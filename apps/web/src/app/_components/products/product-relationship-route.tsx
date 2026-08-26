import type {
  ProductRelationshipRouteOut,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import { isNonFoodCategory } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ExternalLink, Package } from "lucide-react";
import { type FC, type ReactNode, useId, useMemo, useState } from "react";
import { product as productOperations } from "~/app/products/product.functions";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type RouteTone = "direct" | "derived";

type RouteSample = {
  id: string;
  label: string;
  to: string;
  detail?: string | null;
  provenance?: string | null;
};

type RouteBranch = {
  id: string;
  label: string;
  kind: RouteTone;
  count: number;
  samples: RouteSample[];
  detailHash: string;
  emptyCopy: string;
  evidence?: string;
};

type BranchShape<T> = {
  count: number;
  preview: readonly T[];
};

function ProductSectionLink({
  productId,
  hash,
  className,
  children,
  ariaLabel,
}: {
  productId: string;
  hash: string;
  className: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <Link
      to="/products/$shortcode"
      params={{ shortcode: productId }}
      hash={hash}
      className={className}
      aria-label={ariaLabel}
    >
      {children}
    </Link>
  );
}

function InternalRouteLink({
  to,
  className,
  children,
  title,
  ariaLabel,
}: {
  to: string;
  className: string;
  children: ReactNode;
  title?: string;
  ariaLabel?: string;
}) {
  // The route summaries already expose canonical, public shortcodes. Keep
  // navigation in the running application (and its workbench state) while
  // retaining Link's native anchor semantics for keyboard and assistive tech.
  return (
    <Link
      to={to as never}
      className={className}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </Link>
  );
}

function routeBranch<T>(
  id: string,
  label: string,
  kind: RouteTone,
  branch: BranchShape<T>,
  detailHash: string,
  emptyCopy: string,
  sample: (record: T) => RouteSample,
): RouteBranch {
  return {
    id,
    label,
    kind,
    count: branch.count,
    samples: branch.preview.map(sample),
    detailHash,
    emptyCopy,
  };
}

function toRouteModel(
  product: ProductWithFoodOut,
  summary: ProductRelationshipRouteOut,
): { direct: RouteBranch[]; derived: RouteBranch[] } {
  const direct: RouteBranch[] = [
    routeBranch(
      "stock",
      "Stock",
      "direct",
      summary.direct.inventory,
      "stocked-at",
      "No stock records yet.",
      (record) => ({
        id: record.id,
        label: record.location.name,
        to: `/inventory/${encodeURIComponent(record.id)}`,
        detail: record.placement === "installed" ? "Installed" : "Stock",
      }),
    ),
    routeBranch(
      "identity-locations",
      "Also a location",
      "direct",
      summary.direct.identityLocations,
      "stocked-at",
      "This product does not identify a location.",
      (record) => ({
        id: record.id,
        label: record.name,
        to: `/locations/${encodeURIComponent(record.id)}`,
      }),
    ),
    routeBranch(
      "expenses",
      "Expenses",
      "direct",
      summary.direct.expenses,
      "expense-history",
      "No product expenses recorded.",
      (record) => ({
        id: record.id,
        label: record.name,
        to: `/expenses/${encodeURIComponent(record.id)}`,
        detail: record.date,
      }),
    ),
    routeBranch(
      "purchases",
      "Purchases",
      "direct",
      summary.direct.purchases,
      "purchases",
      "No acquisition purchases recorded.",
      (record) => ({
        id: record.id,
        label: record.displayLabel ?? record.orderId ?? "Purchase",
        to: `/purchases/${encodeURIComponent(record.id)}`,
        detail: record.vendor?.name,
        provenance:
          record.source === "link"
            ? "Direct order link"
            : record.source === "both"
              ? "Expense + order link"
              : "Via expense",
      }),
    ),
    ...(product.category === "tools" ||
    product.category === "software" ||
    summary.direct.usedOnProjects.count > 0
      ? [
          routeBranch(
            "used-on-projects",
            "Used on projects",
            "direct",
            summary.direct.usedOnProjects,
            "project-uses",
            "Not used on a project yet.",
            (record) => ({
              id: record.id,
              label: record.name,
              to: `/projects/${encodeURIComponent(record.id)}`,
            }),
          ),
        ]
      : []),
    ...(isNonFoodCategory(product.category)
      ? [
          routeBranch(
            "tasks",
            "Tasks",
            "direct",
            summary.direct.tasks,
            "tasks",
            "No tasks are attached to this product.",
            (record) => ({
              id: record.id,
              label: record.name,
              to: `/tasks/${encodeURIComponent(record.id)}`,
              detail: record.dueDate ?? record.status,
            }),
          ),
        ]
      : []),
  ];

  const purchasedForProjects = routeBranch(
    "purchased-for-projects",
    "Purchased for projects",
    "derived",
    summary.derived.purchasedForProjects,
    "expense-history",
    "No project purchases are attributed from product expenses.",
    (record) => ({
      id: record.id,
      label: record.name,
      to: `/projects/${encodeURIComponent(record.id)}`,
    }),
  );
  if (summary.derived.purchasedForProjects.unassignedExpenseCount > 0) {
    const count = summary.derived.purchasedForProjects.unassignedExpenseCount;
    purchasedForProjects.evidence = `${count} acquisition expense${count === 1 ? "" : "s"} not assigned to a project.`;
  }

  const derived: RouteBranch[] = [
    purchasedForProjects,
    routeBranch(
      "vendors",
      "Vendors",
      "derived",
      summary.derived.vendors,
      "vendors",
      "No vendor rollups from product spend yet.",
      (record) => ({
        id: record.id,
        label: record.name,
        to: `/vendors/${encodeURIComponent(record.id)}`,
      }),
    ),
  ];

  return { direct, derived };
}

function fallbackRouteModel(product: ProductWithFoodOut): {
  direct: RouteBranch[];
  derived: RouteBranch[];
} {
  const direct: RouteBranch[] = [];
  if (product.inventoryEntry.length > 0) {
    direct.push({
      id: "stock",
      label: "Stock",
      kind: "direct",
      count: product.inventoryEntry.length,
      detailHash: "stocked-at",
      emptyCopy: "No stock records yet.",
      samples: product.inventoryEntry.slice(0, 3).map((entry) => ({
        id: entry.id,
        label: entry.location.name,
        to: `/inventory/${encodeURIComponent(entry.id)}`,
        detail: entry.placement === "installed" ? "Installed" : "Stock",
      })),
    });
  }
  if (product.servingAsLocations.length > 0) {
    direct.push({
      id: "identity-locations",
      label: "Also a location",
      kind: "direct",
      count: product.servingAsLocations.length,
      detailHash: "stocked-at",
      emptyCopy: "This product does not identify a location.",
      samples: product.servingAsLocations.slice(0, 3).map((location) => ({
        id: location.id,
        label: location.name,
        to: `/locations/${encodeURIComponent(location.id)}`,
      })),
    });
  }
  return { direct, derived: [] };
}

function RouteBranchRows({
  branch,
  productId,
}: {
  branch: RouteBranch;
  productId: string;
}) {
  const [expanded, setExpanded] = useState(branch.kind === "direct");
  const panelId = useId();
  const samples = branch.samples.slice(0, 3);
  const showDetailLink = branch.count > 0 || Boolean(branch.evidence);

  return (
    <li className="border-border border-b last:border-b-0">
      <div className="flex min-h-11 items-center gap-2 py-1.5 md:min-h-8">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-8"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
              !expanded && "-rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 font-medium text-foreground">
            {branch.label}
          </span>
          <span className="font-mono text-[0.625rem] text-muted-foreground tabular-nums">
            {branch.count}
          </span>
        </button>
        {showDetailLink ? (
          <ProductSectionLink
            productId={productId}
            hash={branch.detailHash}
            className="inline-flex min-h-11 shrink-0 items-center text-primary text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-8"
          >
            View all
            <ExternalLink aria-hidden className="ml-1 size-3" />
          </ProductSectionLink>
        ) : null}
      </div>
      {expanded ? (
        <ul
          id={panelId}
          className="border-border border-l pb-2 pl-3"
          aria-label={`${branch.label} records`}
        >
          {samples.length > 0 ? (
            samples.map((sample) => (
              <li
                key={sample.id}
                className="flex min-h-11 items-center gap-2 py-1 md:min-h-8"
              >
                <InternalRouteLink
                  to={sample.to}
                  className="min-w-0 flex-1 truncate text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  title={sample.label}
                  ariaLabel={`${branch.kind === "direct" ? "Direct" : "Derived"} ${branch.label}: ${sample.label}`}
                >
                  {sample.label}
                </InternalRouteLink>
                {sample.detail ? (
                  <span className="shrink-0 text-muted-foreground">
                    {sample.detail}
                  </span>
                ) : null}
                {sample.provenance ? (
                  <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
                    {sample.provenance}
                  </span>
                ) : null}
              </li>
            ))
          ) : (
            <li className="py-1 text-muted-foreground">{branch.emptyCopy}</li>
          )}
          {branch.evidence ? (
            <li className="py-1 text-muted-foreground">{branch.evidence}</li>
          ) : null}
          {branch.count > samples.length ? (
            <li className="pt-1">
              <ProductSectionLink
                productId={productId}
                hash={branch.detailHash}
                className="inline-flex min-h-11 items-center text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-8"
              >
                View all {branch.count} {branch.label.toLowerCase()}
              </ProductSectionLink>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function ProductRelationshipRouteFrame({
  product,
  direct,
  derived,
  variant = "ledger",
}: {
  product: Pick<ProductWithFoodOut, "id" | "name">;
  direct: RouteBranch[];
  derived: RouteBranch[];
  variant?: "ledger" | "strip";
}) {
  const directHeadingId = useId();
  const derivedHeadingId = useId();

  if (variant === "strip") {
    const populatedDirect = direct.filter((branch) => branch.count > 0);
    return (
      <nav
        aria-label={`${product.name} direct relationships`}
        className="overflow-x-auto"
      >
        <ol className="flex min-w-max items-center gap-2 py-1 text-xs">
          <li>
            <span
              aria-current="page"
              className="inline-flex min-h-11 items-center border border-foreground bg-card px-2 font-medium text-foreground md:min-h-8"
            >
              <Package
                aria-hidden
                className="mr-1.5 size-3.5 text-[var(--domain-pantry)]"
              />
              <span className="max-w-48 truncate" title={product.name}>
                {product.name}
              </span>
            </span>
          </li>
          {populatedDirect.map((branch) => (
            <li key={branch.id} className="flex items-center gap-2">
              <span aria-hidden className="h-px w-3 bg-border" />
              <ProductSectionLink
                productId={product.id}
                hash={branch.detailHash}
                className="inline-flex min-h-11 items-center gap-1.5 border border-border bg-card px-2 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-8"
                ariaLabel={`Direct ${branch.label}: ${branch.count} records`}
              >
                <span>{branch.label}</span>
                <span className="font-mono text-[0.625rem] text-muted-foreground tabular-nums">
                  {branch.count}
                </span>
              </ProductSectionLink>
            </li>
          ))}
          {populatedDirect.length === 0 ? (
            <li className="text-muted-foreground">No direct records yet.</li>
          ) : null}
        </ol>
      </nav>
    );
  }

  return (
    <section
      aria-label="Product relationship route"
      className="border-border border-y"
    >
      <header className="border-border border-b px-3 py-2">
        <h3 className="font-semibold text-foreground text-xs">
          Relationship route
        </h3>
        <p className="mt-0.5 text-muted-foreground">
          Direct records first; derived rollups stay separate.
        </p>
      </header>
      <div className="px-3 py-1">
        <div
          aria-current="page"
          className="flex min-h-11 items-center gap-2 border-border border-b py-1.5 font-medium text-foreground md:min-h-8"
        >
          <Package
            aria-hidden
            className="size-3.5 text-[var(--domain-pantry)]"
          />
          <span className="truncate" title={product.name}>
            {product.name}
          </span>
          <span className="font-mono text-[0.625rem] text-muted-foreground">
            Current product
          </span>
        </div>
        <section aria-labelledby={directHeadingId} className="py-1.5">
          <h4 id={directHeadingId} className="sr-only">
            Direct relationships
          </h4>
          {direct.length > 0 ? (
            <ol className="border-border border-l pl-3">
              {direct.map((branch) => (
                <RouteBranchRows
                  key={branch.id}
                  branch={branch}
                  productId={product.id}
                />
              ))}
            </ol>
          ) : (
            <p className="py-2 text-muted-foreground">No direct records yet.</p>
          )}
        </section>
        <section
          aria-labelledby={derivedHeadingId}
          className="border-border border-t py-1.5"
        >
          <h4
            id={derivedHeadingId}
            className="font-medium text-foreground text-xs"
          >
            Derived from those records
          </h4>
          {derived.length > 0 ? (
            <ol className="mt-1">
              {derived.map((branch) => (
                <RouteBranchRows
                  key={branch.id}
                  branch={branch}
                  productId={product.id}
                />
              ))}
            </ol>
          ) : (
            <p className="py-2 text-muted-foreground">
              No derived rollups yet.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

export function useProductRelationshipRoute(productId: string) {
  return useQuery(
    productOperations.relationshipRoute.queryOptions({ productId }),
  );
}

type ProductRelationshipRouteQuery = ReturnType<
  typeof useProductRelationshipRoute
>;

export const ProductRelationshipRouteContent: FC<{
  product: ProductWithFoodOut;
  query: ProductRelationshipRouteQuery;
  variant?: "ledger" | "strip";
}> = ({ product, query, variant }) => {
  const model = useMemo(
    () => (query.data ? toRouteModel(product, query.data) : null),
    [product, query.data],
  );

  if (query.isPending) {
    return (
      <section
        aria-label="Product relationship route"
        className="border-border border-y px-3 py-2"
      >
        <div className="h-3 w-28 animate-pulse bg-muted motion-reduce:animate-none" />
        <div className="mt-2 h-8 w-full animate-pulse bg-muted motion-reduce:animate-none" />
        <div className="mt-1 h-8 w-4/5 animate-pulse bg-muted motion-reduce:animate-none" />
      </section>
    );
  }

  if (query.isError) {
    const fallback = fallbackRouteModel(product);
    return (
      <div className="space-y-2">
        <section
          aria-label="Relationship route error"
          className="border-border border-y px-3 py-2 text-xs"
        >
          <p className="text-muted-foreground">
            Other relationships could not be loaded.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        </section>
        <ProductRelationshipRouteFrame
          product={product}
          variant={variant}
          {...fallback}
        />
      </div>
    );
  }

  return model ? (
    <ProductRelationshipRouteFrame
      product={product}
      variant={variant}
      {...model}
    />
  ) : null;
};

export const ProductRelationshipRoute: FC<{
  product: ProductWithFoodOut;
  variant?: "ledger" | "strip";
}> = ({ product, variant }) => {
  const query = useProductRelationshipRoute(product.id);
  return (
    <ProductRelationshipRouteContent
      product={product}
      query={query}
      variant={variant}
    />
  );
};
