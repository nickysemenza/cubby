import { AlertTriangle, Apple, Scale } from "lucide-react";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { LocationTree } from "~/app/_components/inventory/location-tree-view";
import { NYTView } from "~/app/_components/recipe/NYTView";
import { formatRichText } from "~/app/_components/recipe/richtext";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import {
  EntitySummaryCard,
  entitySummaryDataSchema,
} from "~/components/entity/entity-summary-card";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { entities } from "~/entities/entities";
import { wasm } from "~/lib/wasm";
import { infLocation } from "~/schemas/location";
import { recipeOut } from "~/schemas/recipe";
import { unitMappingWithMetadata } from "~/schemas/unitmapping";
import { EditableComponentDemo } from "./_components/EditableComponentDemo";
import { Prose } from "./_components/Prose";
import {
  entityRelationshipsDot,
  richTextInputSchema,
  sampleLocations,
  sampleRecipe,
  sampleRichTextInput,
  sampleSummaryData,
  sampleUnitMappings,
} from "./_data/samples";

const Graphviz = lazy(() => import("graphviz-react"));

interface RichTextInput {
  text: string;
  ingredientNames: string[];
}

function RichTextDemoInner({ data }: { data: RichTextInput }) {
  // Parse the raw text into RichItems using WASM, then format for display
  const richItems = wasm.parse_rich_text(data.text, data.ingredientNames);
  return <div className="text-lg">{formatRichText(richItems)}</div>;
}

export function DocsPage() {
  return (
    <>
      <Prose>
        <h1>cubby Documentation</h1>
        <p>
          cubby helps you organize recipes, track ingredients, manage inventory,
          and keep everything in its place.
        </p>

        <h2>Core Concepts</h2>
        <p>cubby is built around five key entity types that work together:</p>
      </Prose>

      <div className="my-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.ingredient.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Ingredients</CardTitle>
            </div>
            <CardDescription>
              The building blocks of recipes. Generic items like "flour" or
              "butter" that appear across multiple recipes.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.product.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Products</CardTitle>
            </div>
            <CardDescription>
              Specific purchasable items linked to ingredients. Products can
              have unit mappings, UPC barcodes, and optional USDA nutrition
              data.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.location.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Locations</CardTitle>
            </div>
            <CardDescription>
              Hierarchical storage areas (Kitchen → Pantry → Top Shelf).
              Supports types like room, shelf, drawer, and CSV import/export
              with parent references.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.recipe.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Recipes</CardTitle>
            </div>
            <CardDescription>
              Collections of ingredients with amounts, organized into sections
              with step-by-step instructions.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.inventory.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Inventory</CardTitle>
            </div>
            <CardDescription>
              Tracks what products you have and where. Links products to
              locations with quantities.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div className="my-8">
        <div className="mb-3 font-medium">Entity Relationships</div>
        <div className="overflow-hidden rounded-lg border bg-card p-4">
          <Suspense fallback={<div className="h-75" />}>
            <Graphviz
              dot={entityRelationshipsDot}
              options={{
                width: "100%",
                height: 300,
                fit: true,
                useWorker: false,
              }}
            />
          </Suspense>
        </div>
      </div>

      <Prose>
        <h2>Features</h2>
      </Prose>

      <div className="my-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.recipe.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Recipes</CardTitle>
            </div>
            <CardDescription>
              Create recipes with multiple sections, import from URLs, and nest
              recipes within other recipes as sub-components.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.product.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Products</CardTitle>
            </div>
            <CardDescription>
              Link to ingredients, add unit mappings, connect to USDA for
              nutrition. Use <code className="text-xs">misc:</code> prefix for
              items not worth tracking individually.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <entities.inventory.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Inventory Management</CardTitle>
            </div>
            <CardDescription>
              Track quantities at locations, bulk edit/move items, and
              automatically detect duplicate unique products.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Apple className="h-5 w-5 text-muted-foreground" />
              <CardTitle>USDA Integration</CardTitle>
            </div>
            <CardDescription>
              Search FoodData Central by name, UPC, or NDB number. View detailed
              nutrition and link products to USDA entries.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Unit Conversions</CardTitle>
            </div>
            <CardDescription>
              WASM-powered engine that chains conversions through multiple units
              (cups → grams → dollars) using product mappings.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Problems Dashboard</CardTitle>
            </div>
            <CardDescription>
              Find duplicate products, missing inventory, invalid UPCs, products
              without unit mappings, and empty locations.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <Prose>
        <h2>Component Demos</h2>
        <p>
          Below are key view-only UI components used throughout cubby, rendered
          with static sample data.
        </p>
      </Prose>

      <EditableComponentDemo
        title="ConversionCapabilities"
        description="Displays unit conversion mappings for a product. Click 'Convert' to open the full converter with graph visualization."
        schema={z.array(unitMappingWithMetadata)}
        defaultData={sampleUnitMappings}
      >
        {(data) => <ConversionCapabilities mappings={data} />}
      </EditableComponentDemo>

      <EditableComponentDemo
        title="NYTView"
        description="NYT Cooking-style recipe display with ingredients and instructions side by side."
        schema={recipeOut}
        defaultData={sampleRecipe}
      >
        {(data) => <NYTView recipe={data} />}
      </EditableComponentDemo>

      <EditableComponentDemo
        title="EntitySummaryCard"
        description="Summary card showing aggregated data for an entity like a recipe's nutritional info and cost."
        schema={entitySummaryDataSchema}
        defaultData={sampleSummaryData}
      >
        {(data) => (
          <EntitySummaryCard
            title="Recipe Summary"
            description="Chocolate Chip Cookies"
            summaryData={data}
          />
        )}
      </EditableComponentDemo>

      <EditableComponentDemo
        title="formatRichText"
        description="Rich text formatting with highlighted ingredients and measurements, powered by WASM parsing."
        schema={richTextInputSchema}
        defaultData={sampleRichTextInput}
      >
        {(data) => <RichTextDemoInner data={data} />}
      </EditableComponentDemo>

      <EditableComponentDemo
        title="LocationTree"
        description="Hierarchical tree view of storage locations using react-arborist."
        schema={z.array(infLocation)}
        defaultData={sampleLocations}
      >
        {(data) => (
          <div className="h-64">
            <LocationTree data={data} />
          </div>
        )}
      </EditableComponentDemo>
    </>
  );
}
