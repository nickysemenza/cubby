import { z } from "zod";

/** Minimal image payload for entity marks embedded in other list rows. */
export const imageUrlSummary = z.object({ url: z.url() });
