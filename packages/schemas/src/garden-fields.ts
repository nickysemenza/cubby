import { z } from "zod";

export const plantingStatus = z.enum(["planned", "growing", "finished"]);
export type PlantingStatus = z.infer<typeof plantingStatus>;
export const gardenEntryKind = z.enum(["note", "harvest"]);
export type GardenEntryKind = z.infer<typeof gardenEntryKind>;
