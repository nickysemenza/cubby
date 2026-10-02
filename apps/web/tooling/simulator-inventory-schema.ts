import { z } from "zod";

export const simulatorInventorySchema = z.object({
  devices: z.record(
    z.string(),
    z.array(
      z
        .object({
          name: z.string(),
          udid: z.string(),
          state: z.string(),
          deviceTypeIdentifier: z.string(),
        })
        .loose(),
    ),
  ),
});

export type SimulatorInventory = z.infer<typeof simulatorInventorySchema>;
