import { z } from "zod";

export const plantingStatus = z.enum(["planned", "growing", "finished"]);
export const gardenEntryKind = z.enum(["note", "harvest"]);
export const plantingOutcome = z.enum(["succeeded", "failed"]);
export const plantVerdict = z.enum(["yes", "maybe", "no"]);
export const plantBreeding = z.enum(["open-pollinated", "hybrid"]);
