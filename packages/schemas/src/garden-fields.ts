import { z } from "zod";

export const plantingStatus = z.enum(["planned", "growing", "finished"]);
export type PlantingStatus = z.infer<typeof plantingStatus>;
export const gardenEntryKind = z.enum(["observation", "harvest", "move"]);
export type GardenEntryKind = z.infer<typeof gardenEntryKind>;
export const gardenLocationKind = z.enum(["bed", "tray", "other"]);
export type GardenLocationKind = z.infer<typeof gardenLocationKind>;
