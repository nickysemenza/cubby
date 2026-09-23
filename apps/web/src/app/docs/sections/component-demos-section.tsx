import { infLocation } from "@cubby/schemas/location";
import { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
import { z } from "zod";

import { LocationTree } from "~/app/_components/inventory/location-tree-view";
import {
  formatRichText,
  parseRichTextSafe,
} from "~/app/_components/recipe/richtext";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import {
  EntitySummaryCard,
  entitySummaryDataSchema,
} from "~/components/entity/entity-summary-card";

import { EditableComponentDemo } from "../_components/EditableComponentDemo";
import { Prose } from "../_components/Prose";
import {
  richTextInputSchema,
  sampleLocations,
  sampleRichTextInput,
  sampleSummaryData,
  sampleUnitMappings,
} from "../_data/samples";

interface RichTextInput {
  text: string;
  ingredientNames: string[];
}

function RichTextDemoInner({ data }: { data: RichTextInput }) {
  // Parse the raw text into WRichItems using WASM, then format for display
  const richItems = parseRichTextSafe(data.text, data.ingredientNames);
  return <div className="text-lg">{formatRichText(richItems)}</div>;
}

export function ComponentDemosSection() {
  return (
    <>
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
        description="Searchable household index with location hierarchy, inventory rollups, and direct record navigation."
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
