import { z } from "zod";

import { LocationTree } from "~/features/inventory/location-tree-view";
import { LocationBrowser } from "~/features/location/location-gallery";
import { formatRichText, parseRichTextSafe } from "~/features/recipe/richtext";
import { ConversionCapabilities } from "~/features/units/conversion-capabilities";
import { Stack } from "~/ui/layout";

import { Demo } from "../components/design-section";
import {
  richTextInputSchema,
  sampleLocations,
  sampleRichTextInput,
  sampleUnitMappings,
} from "../data/samples";

function RichText({ data }: { data: z.infer<typeof richTextInputSchema> }) {
  // WASM parses the raw text into rich items; the formatter highlights them.
  const richItems = parseRichTextSafe(data.text, data.ingredientNames);
  return <div className="text-lg">{formatRichText(richItems)}</div>;
}

export function LocationTreeSection() {
  return (
    <Stack gap="md">
      <Demo
        name="<LocationTree data />"
        note="Searchable household index: location hierarchy, inventory rollups and direct record navigation."
      >
        <LocationTree data={sampleLocations} />
      </Demo>
      <Demo
        name="<LocationBrowser data />"
        note="Compact navigation tracks a continuous gallery of every location, with contents on demand."
      >
        <LocationBrowser data={sampleLocations} />
      </Demo>
    </Stack>
  );
}

export function RecipeUnitsSection() {
  return (
    <Stack gap="md">
      <div className="grid gap-4 xl:grid-cols-2">
        <Demo
          name="formatRichText(parseRichTextSafe(text, ingredients))"
          note="Ingredients and measurements highlighted by the WASM parser."
        >
          <RichText data={sampleRichTextInput} />
        </Demo>
        <Demo
          name="<ConversionCapabilities mappings />"
          note="A product's unit mappings; Convert opens the converter with its graph."
        >
          <ConversionCapabilities mappings={sampleUnitMappings} />
        </Demo>
      </div>
    </Stack>
  );
}
