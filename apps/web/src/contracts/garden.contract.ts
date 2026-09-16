import {
  gardenCreatePlantingInput,
  gardenCorrectLocationDatesInput,
  gardenEntriesInput,
  gardenEntriesOut,
  gardenEntryOut,
  gardenFinishPlantingInput,
  gardenMovePlantingInput,
  gardenJournalInput,
  gardenJournalOut,
  gardenLocationHistoryInput,
  gardenLocationHistoryOut,
  gardenOverviewOut,
  gardenOptionsInput,
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
  overview: query({
    native: "Garden overview",
    input: z.undefined(),
    output: gardenOverviewOut,
  }),
  options: query({
    native: "Garden planting form choices",
    input: gardenOptionsInput,
    output: gardenOptionsOut,
  }),
  guides: query({
    native: "Garden planting guides",
    input: z.undefined(),
    output: gardenGuidesDocument,
  }),
  entries: query({
    native: "Garden entry history and corrections",
    input: gardenEntriesInput,
    output: gardenEntriesOut,
  }),
  journal: query({
    native: "Planting journal",
    input: gardenJournalInput,
    output: gardenJournalOut,
  }),
  locationHistory: query({
    native: "Planting location periods",
    input: gardenLocationHistoryInput,
    output: gardenLocationHistoryOut,
  }),
  correctLocationDates: mutation({
    native: "Garden location-period correction",
    input: gardenCorrectLocationDatesInput,
    output: gardenLocationHistoryOut,
  }),
  createPlanting: mutation({
    native: "Garden planting form",
    input: gardenCreatePlantingInput,
    output: plantingOut,
  }),
  recordEntry: mutation({
    native: "Garden notes harvests and photos",
    input: gardenRecordEntryInput,
    output: gardenEntryOut,
  }),
  startPlanting: mutation({
    native: "Garden start planting",
    input: gardenStartPlantingInput,
    output: plantingOut,
  }),
  movePlanting: mutation({
    native: "Garden transplant",
    input: gardenMovePlantingInput,
    output: plantingOut,
  }),
  splitPlanting: mutation({
    native: "Garden partial transplant",
    input: gardenSplitPlantingInput,
    output: plantingOut,
  }),
  finishPlanting: mutation({
    native: "Garden seasonal reset",
    input: gardenFinishPlantingInput,
    output: plantingOut,
  }),
});
