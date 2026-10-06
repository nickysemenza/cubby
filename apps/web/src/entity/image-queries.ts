import type { projectImageSummariesOut } from "@cubby/schemas/image";
import type { z } from "zod";

export type ProjectImageSummaries = z.output<typeof projectImageSummariesOut>;
