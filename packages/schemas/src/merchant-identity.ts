import { z } from "zod";

export const merchantIdentityProposal = z.object({
  name: z.string().trim().min(1).nullable(),
  counterparty: z.enum(["business", "person", "payment_processor", "unknown"]),
  confidence: z.enum(["low", "medium", "high"]),
});
