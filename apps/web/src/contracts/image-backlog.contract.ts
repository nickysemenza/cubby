import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

/** The native image-processing backlog wire contract. */
const deviceBacklog = z.object({
  waiting: z.number().int().nonnegative(),
  runsWaiting: z.number().int().nonnegative(),
  workingDevices: z.number().int().nonnegative(),
  claimsPerMinute: z.number().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type DeviceBacklog = z.infer<typeof deviceBacklog>;
// The native client's operation identifier is independent of the queue implementation.
export const imageBacklogContract = defineContract(
  "job",
  {
    deviceBacklog: query({
      description:
        "Apple-device image work waiting now, active devices and completion pace.",
      input: z.strictObject({}),
      output: deviceBacklog,
      cache: { tags: [["run"], ["image"]], profile: "live-status" },
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);
