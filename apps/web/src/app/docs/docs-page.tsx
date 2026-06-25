import { infLocation } from "@cubby/schemas/location";
import { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
import { AlertTriangle, Apple, Scale } from "lucide-react";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { LocationTree } from "~/app/_components/inventory/location-tree-view";
import { formatRichText } from "~/app/_components/recipe/richtext";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import {
  EntitySummaryCard,
  entitySummaryDataSchema,
} from "~/components/entity/entity-summary-card";
import { Grid, Row } from "~/components/layout";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { entities } from "~/entities/entities";
import { wasm } from "~/lib/wasm";
import { EditableComponentDemo } from "./_components/EditableComponentDemo";
import { Prose } from "./_components/Prose";
import {
  entityRelationshipsDot,
  richTextInputSchema,
  sampleLocations,
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
  // Parse the raw text into WRichItems using WASM, then format for display
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

      <Grid cols="cards3" className="my-6">
        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.ingredient.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Ingredients</CardTitle>
            </Row>
            <CardDescription>
              The building blocks of recipes. Generic items like "flour" or
              "butter" that appear across multiple recipes.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.product.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Products</CardTitle>
            </Row>
            <CardDescription>
              Specific purchasable items linked to ingredients. Products can
              have unit mappings, UPC barcodes, and optional USDA nutrition
              data.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.location.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Locations</CardTitle>
            </Row>
            <CardDescription>
              Hierarchical storage areas (Kitchen → Pantry → Top Shelf).
              Supports types like room, shelf, drawer, and CSV import/export
              with parent references.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.recipe.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Recipes</CardTitle>
            </Row>
            <CardDescription>
              Collections of ingredients with amounts, organized into sections
              with step-by-step instructions.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.inventory.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Inventory</CardTitle>
            </Row>
            <CardDescription>
              Tracks what products you have and where. Links products to
              locations with quantities.
            </CardDescription>
          </CardHeader>
        </Card>
      </Grid>

      <div className="my-6">
        <div className="mb-2 font-medium">Entity Relationships</div>
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-card p-4">
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

      <Grid cols="cards3" className="my-6">
        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.recipe.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Recipes</CardTitle>
            </Row>
            <CardDescription>
              Create recipes with multiple sections, import from URLs, and nest
              recipes within other recipes as sub-components.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.product.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Products</CardTitle>
            </Row>
            <CardDescription>
              Link to ingredients, add unit mappings, connect to USDA for
              nutrition. Use <code className="text-xs">misc:</code> prefix for
              items not worth tracking individually.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.inventory.lucideIcon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Inventory Management</CardTitle>
            </Row>
            <CardDescription>
              Track quantities at locations, bulk edit/move items, and
              automatically detect duplicate unique products.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <Apple className="h-5 w-5 text-muted-foreground" />
              <CardTitle>USDA Integration</CardTitle>
            </Row>
            <CardDescription>
              Search FoodData Central by name, UPC, or NDB number. View detailed
              nutrition and link products to USDA entries.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <Scale className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Unit Conversions</CardTitle>
            </Row>
            <CardDescription>
              WASM-powered engine that chains conversions through multiple units
              (cups → grams → dollars) using product mappings.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <AlertTriangle className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Problems Dashboard</CardTitle>
            </Row>
            <CardDescription>
              Find duplicate products, missing inventory, invalid UPCs, products
              without unit mappings, and empty locations.
            </CardDescription>
          </CardHeader>
        </Card>
      </Grid>

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
