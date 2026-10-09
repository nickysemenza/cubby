import { z } from "zod";

export const plantingStatus = z.enum(["planned", "growing", "finished"]);
export type PlantingStatus = z.infer<typeof plantingStatus>;
export const gardenEntryKind = z.enum(["note", "harvest"]);
export type GardenEntryKind = z.infer<typeof gardenEntryKind>;
export const plantingOutcome = z.enum(["succeeded", "failed"]);
export type PlantingOutcome = z.infer<typeof plantingOutcome>;
export const plantVerdict = z.enum(["yes", "maybe", "no"]);
export type PlantVerdict = z.infer<typeof plantVerdict>;
export const plantBreeding = z.enum(["open-pollinated", "hybrid"]);
export type PlantBreeding = z.infer<typeof plantBreeding>;
