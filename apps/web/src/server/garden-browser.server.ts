import { gardenContract } from "~/contracts/garden.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  gardenCreatePlantingWorkflow,
  gardenEntriesWorkflow,
  gardenFinishPlantingWorkflow,
  gardenGuidesWorkflow,
  gardenMovePlantingWorkflow,
  gardenOverviewWorkflow,
  gardenOptionsWorkflow,
  gardenRecordEntryWorkflow,
  gardenSplitPlantingWorkflow,
  gardenStartPlantingWorkflow,
} from "~/server/workflows/garden.server";

export const gardenHandlers = implementOperationDomain(gardenContract, {
  overview: gardenOverviewWorkflow,
  options: gardenOptionsWorkflow,
  guides: gardenGuidesWorkflow,
  entries: gardenEntriesWorkflow,
  createPlanting: gardenCreatePlantingWorkflow,
  recordEntry: gardenRecordEntryWorkflow,
  startPlanting: gardenStartPlantingWorkflow,
  movePlanting: gardenMovePlantingWorkflow,
  splitPlanting: gardenSplitPlantingWorkflow,
  finishPlanting: gardenFinishPlantingWorkflow,
});
