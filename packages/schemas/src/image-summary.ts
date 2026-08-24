import { z } from "zod";

export const imageUrlSummary = z.object({ url: z.url() });
export type ImageUrlSummary = z.infer<typeof imageUrlSummary>;
