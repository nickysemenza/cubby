import { gardenContract } from "~/contracts/garden.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  gardenCreatePlantingWorkflow,
  gardenCorrectLocationDatesWorkflow,
  gardenEntriesWorkflow,
  gardenFinishPlantingWorkflow,
  gardenGuidesWorkflow,
  gardenMovePlantingWorkflow,
  gardenJournalWorkflow,
  gardenLocationHistoryWorkflow,
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
  journal: gardenJournalWorkflow,
  locationHistory: gardenLocationHistoryWorkflow,
  correctLocationDates: gardenCorrectLocationDatesWorkflow,
  createPlanting: gardenCreatePlantingWorkflow,
  recordEntry: gardenRecordEntryWorkflow,
  startPlanting: gardenStartPlantingWorkflow,
  movePlanting: gardenMovePlantingWorkflow,
  splitPlanting: gardenSplitPlantingWorkflow,
  finishPlanting: gardenFinishPlantingWorkflow,
});
