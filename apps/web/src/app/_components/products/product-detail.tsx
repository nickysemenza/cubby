import { partitionEntityFiles } from "@cubby/schemas/image";
import type {
  ProductCreateInput,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import { isNonFoodCategory } from "@cubby/shared";
import { getNutrientUnitString } from "@cubby/usda-schemas";
import { uniq } from "es-toolkit";
import {
  Apple,
  ChefHat,
  FileText,
  HandCoins,
  Info,
  Link2,
  ListChecks,
  MapPin,
  Package,
  PackageX,
  Plus,
  Receipt,
  ReceiptText,
  Scale,
  Wrench,
} from "lucide-react";
import { type FC, useCallback, useState } from "react";
import { CreateExpenseDialog } from "~/app/expenses/create-expense-dialog";
import { CreateTaskDialog } from "~/app/tasks/create-task-dialog";
import { Row, Stack } from "~/components/layout";
import { MutedBox } from "~/components/layout/muted-box";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { OptionalStatusText, StatusText } from "~/components/ui/status-text";
import { useTRPC } from "~/integrations/trpc/react";
import { safeConvertAmount } from "~/lib/recipe-costing";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { formatCurrency } from "~/lib/utils";
import {
  DocumentViewerList,
  type DocumentViewTarget,
} from "../DocumentViewerList";
import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { tryFormatAmount } from "../inventory/format-amount";
import { ProductNutritionLabel } from "../nutrition/ProductNutritionLabel";
import { RecipeUsagesTable } from "../recipe/recipe-usages-table";
import { RelationshipSummaryTable } from "../relationships/relationship-summary-table";
import { UnitCoveragePanel } from "../units/UnitCoveragePanel";
import { NutritionInfoTable } from "../usda/nutrition";
import { ProductAddToInventoryDialog } from "./product-add-to-inventory-dialog";
import { ProductBasicInfo } from "./product-basic-info";
import { ProductDiscardDialog } from "./product-discard-dialog";
import { ProductExpenseHistory } from "./product-expense-history";
import { ProductForm } from "./product-form";
import { ProductProjectUses } from "./product-project-uses";
import { ProductPurchases } from "./product-purchases";
import { ProductStockedAt } from "./product-stocked-at";
import { ProductTagSiblings } from "./product-tag-siblings";
import { ProductTaskHistory } from "./product-task-history";

interface ProductDetailProps {
  product: ProductWithFoodOut;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const api = useTRPC();

  const { commonSections, editMode, mappings } = useEntityDetail<
    ProductWithFoodOut,
    { id: string; data: Partial<ProductCreateInput> }
  >({
    entity: "product",
    data: product,
    mutationOptions: api.product.update.mutationOptions(),
    getMappings: getAllUnitMappingsFromProduct,
  });

  const isNonFood = isNonFoodCategory(product.category);

  // Cost per gram of protein, via the same WASM graph conversion the costing
  // engine uses: "1 g protein" resolved to kind "money" against this
  // product's full synthesized mappings (stored + food + price edges — same
  // graph UnitCoveragePanel below renders). A single-product graph carries at
  // most one `each → dollar` price edge, so it never hits the dormant
  // multi-priced-product collision documented in
  // recipebridge/src/costing/engine.rs (that hazard is about an *ingredient's*
  // merged multi-product graph, not a lone product's). Hidden entirely when
  // the product has no price or no protein edge — there's no path to convert.
  const proteinCost = safeConvertAmount(
    { value: 1, unit: getNutrientUnitString("protein") },
    mappings,
    "money",
  );
  const costPerGramProtein =
    proteinCost.isOk() &&
    Number.isFinite(proteinCost.value.value) &&
    proteinCost.value.value > 0
      ? proteinCost.value.value
      : null;

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

  const [addToInventoryOpen, setAddToInventoryOpen] = useState(false);
  const [recordSaleOpen, setRecordSaleOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);

  const sections: DetailSection[] = [
    editableDetailSection({
      title: "Basic Information",
      icon: Info,
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
    // Custom section: Stocked At — where the product lives, the primary
    // content of the page (the hero's On hand / Locations stats are the
    // glanceable summary of this table).
    {
      title: "Stocked At",
      icon: MapPin,
      zone: "main" as const,
      headerAction: (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddToInventoryOpen(true)}
        >
          <Package className="mr-2 size-4" />
          Add to Inventory
        </Button>
      ),
      content: <ProductStockedAt product={product} />,
    },
    // Custom section: Expense History — every expense linked to this
    // product (arrivals and dispositions), the primary way cost basis gets
    // tracked over time.
    {
      title: "Expense History",
      icon: Receipt,
      zone: "main" as const,
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
    // Custom section: Purchases — the orders this product is linked to via
    // `PurchaseProduct`, the transpose of a purchase's own Products section.
    // Distinct from "Vendors" below: that's the derived vendor/spend rollup,
    // this is the explicit per-order provenance link.
    {
      title: "Purchases",
      icon: ReceiptText,
      zone: "main" as const,
      content: <ProductPurchases productId={product.id} />,
    },
    {
      title: "Vendors",
      icon: Receipt,
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
          compact
          expenseHref={(target) =>
            `/expenses?productId=${encodeURIComponent(product.id)}&vendor=${encodeURIComponent(target?.id ?? "__none__")}`
          }
        />
      ),
    },
    ...(product.category === "tools" || product.category === "software"
      ? [
          {
            title: "Used on projects",
            icon: Wrench,
            zone: "main" as const,
            content: <ProductProjectUses productId={product.id} />,
          },
        ]
      : []),
    ...(isNonFood
      ? [
          {
            title: "Tasks",
            icon: ListChecks,
            zone: "main" as const,
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
    // Custom section: Fits With — the other products sharing a tag. Sidebar
    // zone and tags-only: on an untagged product it would be a permanently
    // empty panel, and most of the catalog is untagged food.
    ...(product.tags.length > 0
      ? [
          {
            title: "Fits With",
            icon: Link2,
            content: <ProductTagSiblings product={product} />,
          },
        ]
      : []),
    // Custom section: Manuals — attached PDF instruction manuals (only if any)
    ...(documents.length > 0
      ? [
          {
            title: "Manuals",
            icon: FileText,
            zone: "main" as const,
            content: (
              <DocumentViewerList documents={documents} target={manualTarget} />
            ),
          },
        ]
      : []),
    // Custom section: Nutrition (only if available) — the raw USDA nutrient
    // table plus an FDA-style label view (per 100g, toggling to per-serving
    // when a serving basis resolves — a custom "1 serving = X g" alias, a
    // branded serving edge, or the food's USDA household portion), side by
    // side so both readings of the same data coexist.
    ...(product.food?.nutritionInfo
      ? [
          {
            title: "Nutrition Information",
            icon: Apple,
            content: (
              <Stack gap="md">
                <ProductNutritionLabel
                  nutrients={product.food.nutritionInfo.nutrientsPer100}
                  mappings={mappings}
                  portions={product.food.portionInfoRaw}
                />
                <MutedBox>
                  <NutritionInfoTable n={product.food.nutritionInfo} />
                </MutedBox>
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
            title: "Unit Mappings",
            icon: Scale,
            zone: "main" as const,
            content: (
              <Description>
                No unit conversions — not needed for non-food items.
              </Description>
            ),
          },
        ]
      : [
          {
            title: "Unit Mappings",
            icon: Scale,
            zone: "main" as const,
            content: (
              <Stack gap="sm">
                {costPerGramProtein != null && (
                  <Description>
                    {formatCurrency(costPerGramProtein)} / g protein
                  </Description>
                )}
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
            title: "Appears In Recipes",
            icon: ChefHat,
            zone: "full" as const,
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
  const locationCount = uniq(entries.map((e) => e.location.id)).length;
  const { quantityLedger, onHandUnits, quantityVariance } = product;
  // `onHandUnits` is the SERVER's answer to "do these entries have a
  // meaningful total?" — null when they carry more than one unit ("3 lb + 2
  // each" has no sum) or when nothing is stocked. Read rather than recomputed:
  // this page deriving its own on-hand is what let the list's filters and the
  // rendered cells disagree twice. Only the formatting is local, and the unit
  // is safe to take from the first entry because a non-null total means they
  // all share one.
  const onHandStat: DetailHeroStat =
    onHandUnits !== null && entries[0]
      ? {
          label: "On hand",
          value: (
            <OptionalStatusText tone={quantityVariance ? "warning" : undefined}>
              {tryFormatAmount({
                value: onHandUnits,
                unit: entries[0].amount.unit,
              })}
            </OptionalStatusText>
          ),
        }
      : {
          label: entries.length === 0 ? "On hand" : "Entries",
          value: entries.length,
        };
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
    { label: "Locations", value: locationCount },
  ];

  return (
    <Page
      variant="detail"
      entity="product"
      title={product.name}
      rawData={product}
      heroImages={images}
      heroNo={product.id ?? undefined}
      heroStamp={
        entries.length > 0
          ? { label: "In stock", tone: "green" }
          : { label: "Not stocked", tone: "ink" }
      }
      heroStats={heroStats}
    >
      <DetailSections
        sections={sections}
        rawData={product}
        heroImages={images}
      />
      <ProductAddToInventoryDialog
        open={addToInventoryOpen}
        onOpenChange={setAddToInventoryOpen}
        product={product}
      />
      <CreateExpenseDialog
        open={recordSaleOpen}
        onOpenChange={setRecordSaleOpen}
        presetProductId={product.id}
        intent="disposition"
      />
      <ProductDiscardDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        product={product}
      />
      <CreateTaskDialog
        open={createTaskOpen}
        onOpenChange={setCreateTaskOpen}
        presetSubjectProductId={product.id}
        presetSubjectProductName={product.name}
      />
    </Page>
  );
};
