import type { ActorContext } from "@cubby/schemas/context";
import {
  gardenCreatePlantingInput,
  gardenCorrectLocationDatesInput,
  gardenEntriesInput,
  gardenFinishPlantingInput,
  gardenMovePlantingInput,
  gardenJournalInput,
  gardenLocationHistoryInput,
  gardenRecordEntryInput,
  gardenSplitPlantingInput,
  gardenStartPlantingInput,
} from "@cubby/schemas/garden";
import { gardenGuidesDocument } from "@cubby/schemas/garden-guide";

import type { Database } from "~/server/db";
import plantingGuides from "~/server/garden/planting-guides.json";
import * as repo from "~/server/repo/garden";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

type Context = { db: Database; actorContext: ActorContext };
const plantingGuidesDocument = gardenGuidesDocument.parse(plantingGuides);

export const gardenOverviewWorkflow = defineWorkflowOperation(
  "garden.overview",
  (ctx: Context) => repo.gardenOverview(ctx.db),
);
export const gardenOptionsWorkflow = defineWorkflowOperation(
  "garden.options",
  (ctx: Context) => repo.gardenOptions(ctx.db),
);
export const gardenGuidesWorkflow = defineWorkflowOperation(
  "garden.guides",
  async () => plantingGuidesDocument,
);
export const gardenEntriesWorkflow = defineWorkflowOperation(
  "garden.entries",
  (ctx: Context, input: unknown) =>
    repo.gardenEntries(ctx.db, gardenEntriesInput.parse(input)),
);
export const gardenJournalWorkflow = defineWorkflowOperation(
  "garden.journal",
  (ctx: Context, input: unknown) =>
    repo.gardenJournal(ctx.db, gardenJournalInput.parse(input)),
);
export const gardenLocationHistoryWorkflow = defineWorkflowOperation(
  "garden.locationHistory",
  (ctx: Context, input: unknown) =>
    repo.gardenLocationHistory(ctx.db, gardenLocationHistoryInput.parse(input)),
);
export const gardenCorrectLocationDatesWorkflow = defineWorkflowOperation(
  "garden.correctLocationDates",
  (ctx: Context, input: unknown) =>
    repo.correctLocationDates(
      ctx.db,
      gardenCorrectLocationDatesInput.parse(input),
      ctx.actorContext,
    ),
);
export const gardenCreatePlantingWorkflow = defineWorkflowOperation(
  "garden.createPlanting",
  (ctx: Context, input: unknown) =>
    repo.createPlanting(
      ctx.db,
      gardenCreatePlantingInput.parse(input),
      ctx.actorContext,
    ),
);
export const gardenRecordEntryWorkflow = defineWorkflowOperation(
  "garden.recordEntry",
  (ctx: Context, input: unknown) =>
    repo.recordGardenEntry(
      ctx.db,
      gardenRecordEntryInput.parse(input),
      ctx.actorContext,
    ),
);
export const gardenStartPlantingWorkflow = defineWorkflowOperation(
  "garden.startPlanting",
  (ctx: Context, input: unknown) =>
    repo.startPlanting(
      ctx.db,
      gardenStartPlantingInput.parse(input),
      ctx.actorContext,
    ),
);
export const gardenMovePlantingWorkflow = defineWorkflowOperation(
  "garden.movePlanting",
  (ctx: Context, input: unknown) =>
    repo.movePlanting(
      ctx.db,
      gardenMovePlantingInput.parse(input),
      ctx.actorContext,
    ),
);
export const gardenSplitPlantingWorkflow = defineWorkflowOperation(
  "garden.splitPlanting",
  (ctx: Context, input: unknown) =>
    repo.splitPlanting(
      ctx.db,
      gardenSplitPlantingInput.parse(input),
      ctx.actorContext,
    ),
);
export const gardenFinishPlantingWorkflow = defineWorkflowOperation(
  "garden.finishPlanting",
  (ctx: Context, input: unknown) =>
    repo.finishPlanting(
      ctx.db,
      gardenFinishPlantingInput.parse(input),
      ctx.actorContext,
    ),
);
