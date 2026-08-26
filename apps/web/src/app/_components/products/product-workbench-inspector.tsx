import { displayGtin } from "@cubby/schemas/external-id";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { isNonFoodCategory } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, MapPin, Package, X } from "lucide-react";
import { type FC, type ReactNode, useMemo, useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { formatCurrency } from "~/lib/utils";
import { CategoryLabel } from "./CategoryLabel";

type InspectorTab = "overview" | "relations" | "activity";

const PRIMARY_SECTION_LINKS = [
  { label: "Purchases", hash: "purchases" },
  { label: "Expenses", hash: "expense-history" },
] as const;

const DERIVED_SECTION_LINKS = [
  { label: "Vendors", hash: "vendors" },
  { label: "Purchased for projects", hash: "expense-history" },
] as const;

function DetailAnchorLink({
  productId,
  hash,
  children,
}: {
  productId: string;
  hash: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/products/$shortcode"
      params={{ shortcode: productId }}
      hash={hash}
      className="text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {children}
    </Link>
  );
}

/**
 * The embedded-only portion of a Product's relationship topology. It never
 * claims expense, purchase, project, or task evidence: those branches belong
 * to the specialist Relations tab and their canonical detail sections.
 */
export const ProductRelationshipRoute: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const hasStock = product.inventoryEntry.length > 0;
  const hasIdentityLocations = product.servingAsLocations.length > 0;

  if (!hasStock && !hasIdentityLocations) return null;

  return (
    <section aria-label="Embedded product relationships" className="space-y-2">
      <h3 className="font-semibold text-foreground text-xs">
        Relationship route
      </h3>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-center gap-2 text-xs">
          <DetailAnchorLink productId={product.id} hash="basic-information">
            <span className="inline-flex min-h-11 items-center rounded-md border border-[var(--domain-pantry)] bg-[var(--domain-pantry-surface)] px-2 font-medium text-foreground md:min-h-8">
              Product
            </span>
          </DetailAnchorLink>
          <span aria-hidden className="h-px w-4 bg-border" />
          <div className="grid gap-1.5 border-border border-l pl-2">
            {product.inventoryEntry.slice(0, 2).map((entry) => (
              <Link
                key={entry.id}
                to="/inventory/$shortcode"
                params={{ shortcode: entry.id }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-card px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-8"
              >
                <Package className="size-3.5 text-[var(--domain-pantry)]" />
                <span className="font-medium">Stock</span>
                <span className="max-w-36 truncate text-muted-foreground">
                  {entry.location.name}
                </span>
              </Link>
            ))}
            {product.inventoryEntry.length > 2 ? (
              <DetailAnchorLink productId={product.id} hash="stocked-at">
                +{product.inventoryEntry.length - 2} more stock records
              </DetailAnchorLink>
            ) : null}
            {product.servingAsLocations.slice(0, 2).map((location) => (
              <Link
                key={location.id}
                to="/locations/$shortcode"
                params={{ shortcode: location.id }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-card px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-8"
              >
                <MapPin className="size-3.5 text-[var(--domain-pantry)]" />
                <span className="font-medium">Also a location</span>
                <span className="max-w-36 truncate text-muted-foreground">
                  {location.name}
                </span>
              </Link>
            ))}
            {product.servingAsLocations.length > 2 ? (
              <DetailAnchorLink productId={product.id} hash="stocked-at">
                +{product.servingAsLocations.length - 2} more locations
              </DetailAnchorLink>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
};

const Field: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <div className="grid grid-cols-[7.25rem_minmax(0,1fr)] gap-2 border-border border-b py-1.5 last:border-b-0">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-right text-foreground">{children}</dd>
  </div>
);

const Overview: FC<{ product: ProductWithFoodOut }> = ({ product }) => {
  const price = product.pricing.effectivePrice ?? product.price;

  return (
    <div className="space-y-3 px-3 py-3">
      <ProductRelationshipRoute product={product} />

      <dl className="border-border border-y">
        <Field label="Category">
          <span className="inline-flex justify-end">
            <CategoryLabel category={product.category} />
          </span>
        </Field>
        <Field label="Manufacturer">{product.manufacturer || "—"}</Field>
        <Field label="Model">{product.model || "—"}</Field>
        <Field label="Price">
          {price === null ? "No price" : formatCurrency(price)}
          {product.pricing.source !== "none" ? (
            <span className="ml-1 text-muted-foreground">
              ({product.pricing.source})
            </span>
          ) : null}
        </Field>
        <Field label="Identifier">
          {product.primaryGtin ? displayGtin(product.primaryGtin) : "—"}
        </Field>
        <Field label="External IDs">
          {product.externalIds.length > 0
            ? product.externalIds
                .map(({ externalId, source }) => `${source}: ${externalId}`)
                .join(", ")
            : "—"}
        </Field>
        <Field label="Ingredient">
          {product.ingredient ? (
            <Link
              to="/ingredients/$shortcode"
              params={{ shortcode: product.ingredient.id }}
              className="text-primary underline-offset-2 hover:underline"
            >
              {product.ingredient.name}
            </Link>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Tags">
          {product.tags.length > 0 ? (
            <span className="flex flex-wrap justify-end gap-1">
              {product.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </span>
          ) : (
            "—"
          )}
        </Field>
      </dl>

      <div className="grid grid-cols-2 divide-x divide-y divide-border border border-border text-xs">
        <span className="p-2">
          <strong className="block text-sm tabular-nums">
            {product.inventoryEntry.length}
          </strong>
          Stock records
        </span>
        <span className="p-2">
          <strong className="block text-sm tabular-nums">
            {product.servingAsLocations.length}
          </strong>
          Location identities
        </span>
        <span className="p-2">
          <strong className="block text-sm tabular-nums">
            {product.ingredient ? 1 : 0}
          </strong>
          Ingredient
        </span>
        <span className="p-2">
          <strong className="block text-sm tabular-nums">
            {product.recipeUsages.length}
          </strong>
          Recipe uses
        </span>
        <span className="col-span-2 p-2">
          <strong className="block text-sm tabular-nums">
            {product.componentCount}
          </strong>
          Kit components
        </span>
      </div>

      {product.notes ? (
        <section className="border-border border-t pt-2">
          <h3 className="font-semibold text-foreground text-xs">Notes</h3>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {product.notes}
          </p>
        </section>
      ) : null}
    </div>
  );
};

const Relations: FC<{ product: ProductWithFoodOut }> = ({ product }) => {
  const isProjectTool =
    product.category === "tools" || product.category === "software";
  const hasTasks = isNonFoodCategory(product.category);
  const hasStock = product.inventoryEntry.length > 0;
  const hasIdentityLocations = product.servingAsLocations.length > 0;

  return (
    <div className="space-y-3 px-3 py-3">
      <ProductRelationshipRoute product={product} />
      <section className="border-border border-b pb-3">
        <h3 className="font-semibold text-foreground text-xs">
          Direct relationship sections
        </h3>
        <p className="mt-1 text-muted-foreground">
          Open the canonical record for the specialist source behind each
          relationship. Empty states and provenance remain owned there.
        </p>
        <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          {hasStock || hasIdentityLocations ? (
            <li>
              <DetailAnchorLink productId={product.id} hash="stocked-at">
                Stock and locations
              </DetailAnchorLink>
            </li>
          ) : null}
          {PRIMARY_SECTION_LINKS.map((link) => (
            <li key={link.hash}>
              <DetailAnchorLink productId={product.id} hash={link.hash}>
                {link.label}
              </DetailAnchorLink>
            </li>
          ))}
          {isProjectTool ? (
            <li>
              <DetailAnchorLink productId={product.id} hash="project-uses">
                Used on projects
              </DetailAnchorLink>
            </li>
          ) : null}
          {hasTasks ? (
            <li>
              <DetailAnchorLink productId={product.id} hash="tasks">
                Tasks
              </DetailAnchorLink>
            </li>
          ) : null}
        </ul>
      </section>
      <section>
        <h3 className="font-semibold text-foreground text-xs">
          Derived relationship sections
        </h3>
        <p className="mt-1 text-muted-foreground">
          Rollups and attribution are secondary to the direct record edges
          above.
        </p>
        <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          {DERIVED_SECTION_LINKS.map((link) => (
            <li key={link.label}>
              <DetailAnchorLink productId={product.id} hash={link.hash}>
                {link.label}
              </DetailAnchorLink>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};

export function ProductWorkbenchInspector({
  productId,
  onClose,
}: {
  productId: string;
  onClose?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const queryOptions = useMemo(
    () => entityPreviewQueryOptions("product", productId),
    [productId],
  );
  // `entityPreviewQueryOptions` is deliberately a cross-entity union. Its
  // runtime entity is fixed above, but TanStack cannot recover that narrowing
  // from the generated query-options union.
  // biome-ignore lint/suspicious/noExplicitAny: useQuery cannot narrow the generated cross-entity options union
  const query = useQuery(queryOptions as any);
  const parsedProduct = productWithFoodOut.safeParse(query.data);
  const product = parsedProduct.success ? parsedProduct.data : undefined;

  if (query.isLoading) {
    return (
      <aside
        aria-label="Product inspector"
        className="h-full w-full max-w-full bg-card p-3 text-muted-foreground text-sm"
      >
        Loading product…
      </aside>
    );
  }

  if (!product) {
    return (
      <aside
        aria-label="Product inspector"
        className="h-full w-full max-w-full bg-card p-3 text-muted-foreground text-sm"
      >
        Product could not be loaded.
      </aside>
    );
  }

  const coverImage = product.images.find(isDisplayableImageFile);

  return (
    <aside
      aria-label={`${product.name} inspector`}
      className="h-full w-full max-w-full overflow-y-auto bg-card text-foreground text-xs"
    >
      <header className="border-border border-b p-3">
        <div className="flex items-start gap-2">
          {coverImage ? (
            <img
              src={coverImage.url}
              alt=""
              width={40}
              height={40}
              className="size-10 rounded-md border border-border object-cover"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <span className="inline-flex items-center gap-1 font-medium text-2xs text-[var(--domain-pantry)]">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-[var(--domain-pantry)]"
              />
              Pantry
            </span>
            <h2
              className="truncate font-semibold text-foreground text-sm"
              title={product.name}
            >
              {product.name}
            </h2>
            <p className="truncate text-muted-foreground">{product.id}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              mobileSize="compact"
              aria-label="Open full product details"
              render={
                <Link
                  to="/products/$shortcode"
                  params={{ shortcode: product.id }}
                />
              }
            >
              <ExternalLink />
            </Button>
            {onClose ? (
              <Button
                variant="ghost"
                size="icon-xs"
                mobileSize="compact"
                aria-label="Close inspector"
                onClick={onClose}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as InspectorTab)}
      >
        <TabsList
          variant="line"
          className="w-full justify-start border-border border-b px-2"
        >
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="relations">Relations</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        {activeTab === "overview" ? (
          <TabsContent value="overview">
            <Overview product={product} />
          </TabsContent>
        ) : null}
        {activeTab === "relations" ? (
          <TabsContent value="relations">
            <Relations product={product} />
          </TabsContent>
        ) : null}
        {activeTab === "activity" ? (
          <TabsContent value="activity">
            <div className="px-3 py-3">
              <AuditLogList
                entityType="product"
                entityId={product.id}
                showEntityLink={false}
              />
            </div>
          </TabsContent>
        ) : null}
      </Tabs>
    </aside>
  );
}
