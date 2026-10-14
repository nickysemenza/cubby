import { infLocation } from "@cubby/schemas/location";
import { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
import { z } from "zod";

import { LocationTree } from "~/features/inventory/location-tree-view";
import { formatRichText, parseRichTextSafe } from "~/features/recipes/richtext";
import { ConversionCapabilities } from "~/features/units/ConversionCapabilities";

import { DesignSection } from "../_components/design-section";
import { EditableComponentDemo } from "../_components/EditableComponentDemo";
import {
  richTextInputSchema,
  sampleLocations,
  sampleRichTextInput,
  sampleUnitMappings,
} from "../_data/samples";

function RichText({ data }: { data: z.infer<typeof richTextInputSchema> }) {
  // WASM parses the raw text into rich items; the formatter highlights them.
  const richItems = parseRichTextSafe(data.text, data.ingredientNames);
  return <div className="text-lg">{formatRichText(richItems)}</div>;
}

export function LocationTreeSection() {
  return (
    <DesignSection
      id="location-tree"
      title="LocationTree"
      components={["LocationTree"]}
      source={["features/inventory/location-tree-view.tsx"]}
    >
      <EditableComponentDemo
        title="<LocationTree data />"
        description="Searchable household index: location hierarchy, inventory rollups and direct record navigation."
        schema={z.array(infLocation)}
        defaultData={sampleLocations}
      >
        {(data) => (
          <div className="h-72">
            <LocationTree data={data} />
          </div>
        )}
      </EditableComponentDemo>
    </DesignSection>
  );
}

export function RecipeUnitsSection() {
  return (
    <DesignSection
      id="recipe-units"
      title="Recipe text and unit conversion"
      components={["formatRichText", "ConversionCapabilities"]}
      source={[
        "features/recipes/richtext.tsx",
        "features/units/ConversionCapabilities.tsx",
      ]}
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <EditableComponentDemo
          title="formatRichText(parseRichTextSafe(text, ingredients))"
          description="Ingredients and measurements highlighted by the WASM parser."
          schema={richTextInputSchema}
          defaultData={sampleRichTextInput}
        >
          {(data) => <RichText data={data} />}
        </EditableComponentDemo>
        <EditableComponentDemo
          title="<ConversionCapabilities mappings />"
          description="A product's unit mappings; Convert opens the converter with its graph."
          schema={z.array(unitMappingWithMetadata)}
          defaultData={sampleUnitMappings}
        >
          {(data) => <ConversionCapabilities mappings={data} />}
        </EditableComponentDemo>
      </div>
    </DesignSection>
  );
}
