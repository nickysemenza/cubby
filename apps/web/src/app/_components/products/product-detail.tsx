import { partitionEntityFiles } from "@cubby/schemas/image";
import type {
  ProductCreateInput,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import { isNonFoodCategory } from "@cubby/shared";
import {
  Apple,
  BookOpen,
  Boxes,
  ChefHat,
  FileText,
  HandCoins,
  Info,
  Link2,
  ListChecks,
  MapPin,
  PackageX,
  Plus,
  Receipt,
  ReceiptText,
  Scale,
  Wrench,
} from "lucide-react";
import { type FC, useCallback, useState } from "react";

import { EntityActionButtons } from "~/app/_components/actions/entity-actions";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { OptionalStatusText, StatusText } from "~/components/ui/status-text";
import {
  expenseCaptureRequest,
  taskCaptureRequest,
} from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";

import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import {
  DocumentViewerList,
  type DocumentViewTarget,
} from "../DocumentViewerList";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { tryFormatAmount } from "../inventory/format-amount";
import { FullNutrientBreakdown } from "../nutrition/FullNutrientBreakdown";
import { NutrientDensityStats } from "../nutrition/NutrientDensityStats";
import { ProductNutritionLabel } from "../nutrition/ProductNutritionLabel";
import { RecipeUsagesTable } from "../recipe/recipe-usages-table";
import { RelatednessRail } from "../relatedness/relatedness-rail";
import { RelationshipSummaryTable } from "../relationships/relationship-summary-table";
import { UnitCoveragePanel } from "../units/UnitCoveragePanel";
import { ProductBasicInfo } from "./product-basic-info";
import { ProductCookbook } from "./product-cookbook";
import { ProductDiscardDialog } from "./product-discard-dialog";
import { ProductExpenseHistory } from "./product-expense-history";
import { ProductForm } from "./product-form";
import { heroPresence } from "./product-hero-presence";
import { ProductKitComponents } from "./product-kit-components";
import {
  ProductProjectUses,
  shouldShowProductProjectUses,
} from "./product-project-uses";
import { ProductPurchases } from "./product-purchases";
import {
  ProductRelationshipRouteContent,
  useProductRelationshipRoute,
} from "./product-relationship-route";
import { ProductStockedAt } from "./product-stocked-at";
import { ProductTaskHistory } from "./product-task-history";

interface ProductDetailProps {
  product: ProductWithFoodOut;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const relationshipRouteQuery = useProductRelationshipRoute(product.id);
  const { commonSections, editMode, mappings } = useEntityDetail<
    ProductWithFoodOut,
    { id: string; data: Partial<ProductCreateInput> }
  >({
    entity: "product",
    data: product,
    getMappings: getAllUnitMappingsFromProduct,
  });

  const isNonFood = isNonFoodCategory(product.category);
  const shouldShowProjectUses = shouldShowProductProjectUses(
    product.category,
    relationshipRouteQuery.data?.direct.usedOnProjects.count ?? 0,
  );

  // PDF manuals share the images relation — hero/gallery get only real
  // images; documents render in their own Manuals section.
  const { images, documents } = partitionEntityFiles(product.images);

  // Wiki links in the notes ([[manual#page=N]]) jump the inline viewer here.
  const [manualTarget, setManualTarget] = useState<DocumentViewTarget | null>(
    null,
  );
  const handleManualLink = useCallback((documentId: string, page: number) => {
    setManualTarget({ documentId, page, nonce: Date.now() });
  }, []);

  const [recordSaleOpen, setRecordSaleOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);

  const sections: DetailSection[] = [
    editableDetailSection({
      id: "basic-information",
      title: "Basic Information",
      icon: Info,
      placement: "supporting",
      editMode,
      Form: ProductForm,
      entity: product,
      children: (
        <ProductBasicInfo
          product={product}
          onEdit={editMode.startEditing}
          documents={documents}
          onManualLink={handleManualLink}
        />
      ),
    }),
    {
      id: "relationships",
      title: "Relationships",
      icon: Link2,
      placement: "primary" as const,
      content: (
        <ProductRelationshipRouteContent
          product={product}
          query={relationshipRouteQuery}
        />
      ),
    },
    // Custom section: Stocked At — where the product lives, the primary
    // content of the page (the hero's On hand / Locations stats are the
    // glanceable summary of this table).
    {
      id: "stocked-at",
      title: "Stocked At",
      icon: MapPin,
      placement: "primary" as const,
      // From the registry, so the same verb the row menus and the palette offer
      // is the one this page offers — including its kit over-accounting
      // warning, which the action now derives itself.
      headerAction: (
        <EntityActionButtons
          entity="product"
          record={{ id: product.id, name: product.name }}
        />
      ),
      content: <ProductStockedAt product={product} />,
    },
    // Custom section: Expense History — every expense linked to this
    // product (arrivals and dispositions), the primary way cost basis gets
    // tracked over time.
    {
      id: "expense-history",
      title: "Expense History",
      icon: Receipt,
      placement: "primary" as const,
      // Sale and discard are siblings: both record a unit leaving, and they
      // differ only in whether money came back.
      headerAction: (
        <Row gap="sm">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRecordSaleOpen(true)}
          >
            <HandCoins />
            Record sale
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDiscardOpen(true)}
          >
            <PackageX />
            Discard
          </Button>
        </Row>
      ),
      content: <ProductExpenseHistory product={product} />,
    },
    // Custom section: Purchases — the orders that acquired this product, the
    // transpose of a purchase's own Products section. Two sources: the orders
    // named by this product's own acquisition expenses, and any explicit
    // `PurchaseProduct` link (which exists for orders whose expenses can't
    // carry a product at all). Distinct from "Vendors" below: that's the
    // derived vendor/spend rollup, this is per-order provenance.
    {
      id: "purchases",
      title: "Purchases",
      icon: ReceiptText,
      placement: "primary" as const,
      content: <ProductPurchases productId={product.id} />,
    },
    // Custom section: Kit Components — what this Product is made of via
    // `ProductComponent` (if it's a kit or multi-pack), and every kit it's
    // listed inside (if it's a part). This edge carries no money: the kit
    // keeps its own Expense History above, never split per component.
    {
      id: "kit-components",
      title: "Kit Components",
      icon: Boxes,
      placement: "primary" as const,
      content: <ProductKitComponents productId={product.id} />,
    },
    {
      id: "vendors",
      title: "Vendors",
      icon: Receipt,
      placement: "supporting",
      content: (
        <RelationshipSummaryTable
          relationKey="product.vendors"
          sourceId={product.id}
          columns={[
            "target",
            "acquired",
            "purchases",
            "expenses",
            "unpriced",
            "netSpend",
            "latestActivity",
          ]}
          defaultSort={{ field: "latestActivity", direction: "desc" }}
          emptyCopy="No vendor spend is attributed to this product yet."
          nullLabel="No purchase/vendor"
          expenseHref={(target) =>
            `/expenses?productId=${encodeURIComponent(product.id)}&vendor=${encodeURIComponent(target?.id ?? "__none__")}`
          }
        />
      ),
    },
    ...(shouldShowProjectUses
      ? [
          {
            id: "project-uses",
            title: "Used on projects",
            icon: Wrench,
            placement: "primary" as const,
            content: <ProductProjectUses productId={product.id} />,
          },
        ]
      : []),
    ...(isNonFood
      ? [
          {
            id: "tasks",
            title: "Tasks",
            icon: ListChecks,
            placement: "primary" as const,
            headerAction: (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateTaskOpen(true)}
              >
                <Plus />
                New task
              </Button>
            ),
            content: <ProductTaskHistory product={product} />,
          },
        ]
      : []),
    {
      id: "fits-with",
      title: "Fits With",
      icon: Link2,
      placement: "supporting" as const,
      content: <RelatednessRail product={product} />,
    },
    // The book behind the book: this product is a cookbook's physical copy.
    // Gated on the link existing, so it never draws on the ~3,000 products
    // that aren't books.
    ...(product.cookbook
      ? [
          {
            id: "cookbook",
            title: "Cookbook",
            icon: BookOpen,
            placement: "supporting" as const,
            content: <ProductCookbook cookbook={product.cookbook} />,
          },
        ]
      : []),
    // Custom section: Manuals — attached PDF instruction manuals (only if any)
    ...(documents.length > 0
      ? [
          {
            id: "manuals",
            title: "Manuals",
            icon: FileText,
            placement: "primary" as const,
            content: (
              <DocumentViewerList documents={documents} target={manualTarget} />
            ),
          },
        ]
      : []),
    // Custom section: Nutrition (only if available) — an FDA-style label view
    // (per 100g, toggling to per-serving when a serving basis resolves — a
    // custom "1 serving = X g" alias, a branded serving edge, or the food's
    // USDA household portion) leads, with the full raw USDA nutrient join
    // behind a disclosure so non-tier-1 nutrients stay reachable without
    // competing with the label for attention.
    ...(product.food?.nutritionInfo
      ? [
          {
            id: "nutrition-information",
            title: "Nutrition Information",
            icon: Apple,
            placement: "supporting" as const,
            content: (
              <Stack gap="md">
                <ProductNutritionLabel
                  nutrients={product.food.nutritionInfo.nutrientsPer100}
                  mappings={mappings}
                  portions={product.food.portionInfoRaw}
                />
                <NutrientDensityStats
                  nutrients={product.food.nutritionInfo.nutrientsPer100}
                  mappings={mappings}
                  price={product.pricing.effectivePrice ?? product.price}
                  mappingProduct={{
                    id: product.id,
                    name: product.name,
                    manufacturer: product.manufacturer,
                  }}
                />
                <FullNutrientBreakdown
                  nutritionInfo={product.food.nutritionInfo}
                />
              </Stack>
            ),
          },
        ]
      : []),
    // Custom section: Unit Mappings — conversion capabilities + Convert modal
    // above the source-attributed rows table, mirroring the ingredient page.
    // Non-food (household/garage) products skip food-coverage grading entirely
    // (no calories/price chips, no USDA nudge) — and with no mappings at all,
    // collapse to a minimal note instead of an empty converter surface.
    ...(isNonFood && mappings.length === 0
      ? [
          {
            id: "unit-mappings",
            title: "Unit Mappings",
            icon: Scale,
            placement: "primary" as const,
            content: (
              <Description>
                No unit conversions — not needed for non-food items.
              </Description>
            ),
          },
        ]
      : [
          {
            id: "unit-mappings",
            title: "Unit Mappings",
            icon: Scale,
            placement: "primary" as const,
            content: (
              <Stack gap="sm">
                <UnitCoveragePanel
                  mappings={mappings}
                  showCoverage={!isNonFood}
                  servingAlias={{
                    productId: product.id,
                    storedMappings: product.unitMappings,
                  }}
                />
              </Stack>
            ),
          },
        ]),
    // Custom section: Appears In Recipes — recipes the product's linked ingredient
    // is used in, one row per usage with amount, source line, and parser-drift flag.
    // Full-width so the 5-column table has room (esp. the source line).
    ...(product.ingredient
      ? [
          {
            id: "recipe-appearances",
            title: "Appears In Recipes",
            icon: ChefHat,
            placement: "full" as const,
            content:
              product.recipeUsages.length > 0 ? (
                <RecipeUsagesTable
                  usages={product.recipeUsages}
                  ingredientName={product.ingredient.name}
                  aliases={product.ingredient.aliases}
                />
              ) : (
                <Description>Not used in any recipes yet.</Description>
              ),
          },
        ]
      : []),
    // Common sections from entity config (History)
    ...commonSections,
  ];

  const entries = product.inventoryEntry ?? [];
  const { quantityLedger, onHandUnits, quantityVariance } = product;
  // "Locations" has broken in both directions here. It first counted
  // `uniq(entries.map(e => e.location.id))` while the section below read
  // `quantityLedger.locationCount` — one word, two meanings, on one page, and
  // a rack in service as a shelf read "LOCATIONS 0" above a list containing it.
  // Switching to the ledger's count fixed that and broke the mirror image: a
  // product merely sitting on a shelf read "LOCATIONS 0" above the very row
  // holding it. Neither population is the answer on its own, so the stat is
  // the union of both and `heroPresence` owns it — see the rule there.
  //
  // `onHandUnits` is the SERVER's answer to "do these entries have a
  // meaningful total?" — null when they carry more than one unit ("3 lb + 2
  // each" has no sum) or when nothing is stocked. Read rather than recomputed:
  // this page deriving its own on-hand is what let the list's filters and the
  // rendered cells disagree twice. Only the formatting is local, and the unit
  // is safe to take from the first entry because a non-null total means they
  // all share one.
  //
  // The rules live in `heroPresence` — pure, and unit-tested — because all of
  // them were wrong at once while buried in this JSX.
  const presence = heroPresence({
    entryCount: entries.length,
    entryUnit: entries[0]?.amount.unit,
    onHandUnits,
    stockedLocationIds: entries.map((entry) => entry.location.id),
    identityLocationIds: product.servingAsLocations.map((loc) => loc.id),
    componentCount: product.componentCount,
  });

  const onHandStat: DetailHeroStat =
    presence.onHand.kind === "amount"
      ? {
          label: presence.onHand.label,
          value: (
            <OptionalStatusText tone={quantityVariance ? "warning" : undefined}>
              {tryFormatAmount(presence.onHand.amount)}
            </OptionalStatusText>
          ),
        }
      : { label: presence.onHand.label, value: presence.onHand.count };
  // Bought minus gone, from the Expense ledger below. Sits beside On hand
  // because the comparison is the whole point — the two disagreeing is the
  // signal, so the shelf figure takes the warning tone rather than adding a
  // third number stat nobody scans.
  const expectedStat: DetailHeroStat = {
    label: "Expected",
    value: (
      <span className="tabular-nums">
        <OptionalStatusText
          tone={quantityLedger.expectedQuantity < 0 ? "destructive" : undefined}
        >
          {quantityLedger.expectedQuantity}
        </OptionalStatusText>
        {/* Same honesty cue as the products table: an expense line with no
            recorded quantity contributes nothing, so without this a product
            with six unquantified receipts reads as a confident number. */}
        {quantityLedger.unknownAcquisitionLines > 0 ? (
          <StatusText tone="warning">
            {` +${quantityLedger.unknownAcquisitionLines}?`}
          </StatusText>
        ) : null}
        {quantityLedger.unknownExitLines > 0 ? (
          <StatusText tone="warning">
            {` −${quantityLedger.unknownExitLines}?`}
          </StatusText>
        ) : null}
      </span>
    ),
  };
  // No Price stat here — the editable price field in Basic Information is
  // the source of truth and sits right in the aside rail.
  const heroStats: DetailHeroStat[] = [
    onHandStat,
    expectedStat,
    { label: "Locations", value: presence.locationCount },
  ];

  return (
    <Page
      variant="detail"
      entity="product"
      title={product.name}
      rawData={product}
      heroImages={images}
      heroNo={product.id ?? undefined}
      heroStamp={presence.stamp}
      heroStats={heroStats}
    >
      <DetailSections
        sections={sections}
        rawData={product}
        heroImages={images}
        relationshipPreview={
          <div className="border-b border-border bg-card px-2 py-2 md:px-4">
            <ProductRelationshipRouteContent
              product={product}
              query={relationshipRouteQuery}
              variant="strip"
            />
          </div>
        }
      />
      <EntityEditDialog
        open={recordSaleOpen}
        onOpenChange={setRecordSaleOpen}
        request={expenseCaptureRequest({
          productId: product.id,
          disposition: true,
        })}
      />
      <ProductDiscardDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        product={product}
      />
      <EntityEditDialog
        open={createTaskOpen}
        onOpenChange={setCreateTaskOpen}
        request={taskCaptureRequest({ subjectProductId: product.id })}
      />
    </Page>
  );
};
