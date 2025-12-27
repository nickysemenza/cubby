"use client";

import dynamic from "next/dynamic";
import { z } from "zod";
import { LocationTree } from "~/app/_components/inventory/location-tree-view";
import { NYTView } from "~/app/_components/recipe/NYTView";
import { formatRichText } from "~/app/_components/recipe/richtext";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import {
  EntitySummaryCard,
  entitySummaryDataSchema,
} from "~/components/entity/entity-summary-card";
import { wasm } from "~/lib/wasm";
import { infLocation, locationType } from "~/schemas/location";
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

const Graphviz = dynamic(() => import("graphviz-react"), { ssr: false });

interface RichTextInput {
  text: string;
  ingredientNames: string[];
}

function RichTextDemoInner({ data }: { data: RichTextInput }) {
  // Parse the raw text into RichItems using WASM, then format for display
  const richItems = wasm.parse_rich_text(data.text, data.ingredientNames);
  return <div className="text-lg">{formatRichText(richItems)}</div>;
}

export default function DocsPage() {
  return (
    <>
      <Prose>
        <h1>RecipeHub Documentation</h1>
        <p>
          RecipeHub helps you organize recipes, track ingredients, manage
          inventory, and keep everything in its place.
        </p>

        <h2>Core Concepts</h2>
        <p>
          RecipeHub is built around five key entity types that work together:
        </p>

        <h3>Ingredients</h3>
        <p>
          The building blocks of recipes. Generic items like &ldquo;flour&rdquo;
          or &ldquo;butter&rdquo; that appear across multiple recipes.
        </p>

        <h3>Products</h3>
        <p>
          Specific purchasable items linked to ingredients. For example,
          &ldquo;King Arthur All-Purpose Flour 5lb&rdquo; links to the
          &ldquo;flour&rdquo; ingredient. Products can have unit mappings
          (conversions between volume, weight, and price) and optional USDA
          nutrition data.
        </p>

        <h3>Locations</h3>
        <p>
          Hierarchical storage areas like Kitchen → Pantry → Top Shelf. Used to
          organize where inventory is stored.
        </p>

        <h4>Location Types</h4>
        <p>
          Each location has a <strong>type</strong> that describes what kind of
          storage it is. Valid types:{" "}
          <code>{locationType.options.join(", ")}</code>
        </p>

        <h4>CSV Format</h4>
        <p>
          When importing/exporting via CSV or Google Sheets, locations use a
          simple name-based format. Each location has a unique{" "}
          <code>location_name</code> and optionally references its parent via{" "}
          <code>parent_name</code>.
        </p>
        <p>
          <strong>Default types:</strong> Root locations (no parent) default to{" "}
          <code>room</code>, and child locations default to <code>shelf</code>.
          You can specify a different type via the <code>location_type</code>{" "}
          column.
        </p>

        <h3>Recipes</h3>
        <p>
          Collections of ingredients with amounts, organized into sections with
          step-by-step instructions.
        </p>

        <h3>Inventory</h3>
        <p>
          Tracks what products you have and where. Links products to locations
          with quantities.
        </p>
      </Prose>

      <div className="my-8">
        <div className="mb-3 font-medium">Entity Relationships</div>
        <div className="overflow-hidden rounded-lg border bg-card p-4">
          <Graphviz
            dot={entityRelationshipsDot}
            options={{
              width: "100%",
              height: 300,
              fit: true,
              useWorker: false,
            }}
          />
        </div>
      </div>

      <Prose>
        <h2>Features</h2>

        <h3>Recipes</h3>
        <ul>
          <li>Create recipes with multiple sections (e.g., Dough, Filling)</li>
          <li>Each section has its own ingredients and instructions</li>
          <li>Import recipes directly from URLs</li>
          <li>Nest recipes within other recipes as sub-components</li>
        </ul>

        <h3>Products</h3>
        <ul>
          <li>Link products to ingredients for inventory tracking</li>
          <li>Add unit mappings for volume, weight, and price conversions</li>
          <li>Connect to USDA database via UPC barcode or NDB number</li>
          <li>Pull in nutrition data from linked USDA entries</li>
          <li>
            <strong>Misc products:</strong> Name a product starting with{" "}
            <code>misc:</code> (e.g., &ldquo;misc: assorted cables&rdquo;) to
            skip validation for pricing, UPC, etc. Useful for bulk bins or items
            not worth individually tracking.
          </li>
        </ul>

        <h3>Inventory Management</h3>
        <ul>
          <li>Track product quantities at specific locations</li>
          <li>Bulk edit multiple items at once</li>
          <li>Bulk move items between locations</li>
          <li>Automatic detection of duplicate unique products</li>
        </ul>

        <h3>USDA Integration</h3>
        <ul>
          <li>Search FoodData Central by name, UPC, or NDB number</li>
          <li>View detailed nutrition information</li>
          <li>Link products to USDA entries for enriched data</li>
        </ul>

        <h3>Unit Conversions</h3>
        <ul>
          <li>WASM-powered conversion engine</li>
          <li>
            Chain conversions through multiple units (cups &rarr; grams &rarr;
            dollars)
          </li>
          <li>Conversion graphs built automatically from product mappings</li>
        </ul>

        <h3>Problems Dashboard</h3>
        <ul>
          <li>Duplicate unique products across locations</li>
          <li>Products missing inventory entries</li>
          <li>Invalid UPC codes</li>
          <li>Products without unit mappings</li>
          <li>Empty locations</li>
        </ul>
      </Prose>

      <Prose>
        <h2>Component Demos</h2>
        <p>
          Below are key view-only UI components used throughout RecipeHub,
          rendered with static sample data.
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
