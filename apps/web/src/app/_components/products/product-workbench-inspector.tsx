import { displayGtin } from "@cubby/schemas/external-id";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, X } from "lucide-react";
import { type FC, type ReactNode, useMemo, useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { formatCurrency } from "~/lib/utils";
import { CategoryLabel } from "./CategoryLabel";
import { ProductRelationshipRoute } from "./product-relationship-route";

type InspectorTab = "overview" | "relations" | "activity";

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

const Relations: FC<{ product: ProductWithFoodOut }> = ({ product }) => (
  <div className="px-3 py-3">
    <ProductRelationshipRoute product={product} />
  </div>
);

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
