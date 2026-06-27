import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { externalIdInput } from "./external-id";

export const externalIdOut = z
  .object({
    id: z.uuid(),
  })
  .extend(externalIdInput.omit({ id: true }).shape)
  .extend(dbTimestampsOut.shape);

export type ExternalIdOut = z.infer<typeof externalIdOut>;
