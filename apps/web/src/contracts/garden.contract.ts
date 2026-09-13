import {
  gardenCreatePlantingInput,
  gardenEntriesInput,
  gardenEntriesOut,
  gardenEntryOut,
  gardenFinishPlantingInput,
  gardenMovePlantingInput,
  gardenOverviewOut,
  gardenOptionsOut,
  gardenRecordEntryInput,
  gardenSplitPlantingInput,
  gardenStartPlantingInput,
  plantingOut,
} from "@cubby/schemas/garden";
import { gardenGuidesDocument } from "@cubby/schemas/garden-guide";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const gardenContract = defineContract("garden", {
  overview: query({ input: z.undefined(), output: gardenOverviewOut }),
  options: query({ input: z.undefined(), output: gardenOptionsOut }),
  guides: query({ input: z.undefined(), output: gardenGuidesDocument }),
  entries: query({ input: gardenEntriesInput, output: gardenEntriesOut }),
  createPlanting: mutation({
    input: gardenCreatePlantingInput,
    output: plantingOut,
  }),
  recordEntry: mutation({
    input: gardenRecordEntryInput,
    output: gardenEntryOut,
  }),
  startPlanting: mutation({
    input: gardenStartPlantingInput,
    output: plantingOut,
  }),
  movePlanting: mutation({
    input: gardenMovePlantingInput,
    output: plantingOut,
  }),
  splitPlanting: mutation({
    input: gardenSplitPlantingInput,
    output: plantingOut,
  }),
  finishPlanting: mutation({
    input: gardenFinishPlantingInput,
    output: plantingOut,
  }),
});
