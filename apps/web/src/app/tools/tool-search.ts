import { projectKindSchema, projectStatusSchema } from "@cubby/schemas/project";
import { z } from "zod";

import { urlStringParam } from "~/lib/search-params";

const commaSeparatedArray = <T extends z.ZodType>(itemSchema: T) =>
  z.preprocess((value) => {
    const text = z.string().safeParse(value);
    return text.success
      ? text.data.split(",").filter((item) => item.length > 0)
      : value;
  }, z.array(itemSchema).optional());

const completionYearParam = urlStringParam
  .refine(
    (value) => value === undefined || /^\d{4}$/.test(value),
    "Invalid completion year",
  )
  .catch(undefined);

const matrixFields = {
  kinds: commaSeparatedArray(projectKindSchema),
  statuses: commaSeparatedArray(projectStatusSchema),
  completed: completionYearParam,
  project: urlStringParam,
  page: z.coerce.number().int().positive().optional().catch(undefined),
  tool: urlStringParam,
  floor: z.coerce.number().nonnegative().optional().catch(undefined),
};

/** The Usage renderer's route-independent search contract. */
export const toolMatrixSearchSchema = z
  .object({
    ...matrixFields,
    group: z.enum(["trade", "manufacturer"]).optional().catch(undefined),
  })
  .default({});

export type ToolMatrixSearch = z.infer<typeof toolMatrixSearchSchema>;

/** Canonical URL state for the combined Tools workbench. */
export const toolsSearchSchema = z
  .object({
    view: z.enum(["gallery", "usage"]).optional().catch(undefined),
    q: urlStringParam,
    galleryGroup: z
      .enum(["location", "manufacturer", "trade"])
      .optional()
      .catch(undefined),
    section: urlStringParam,
    ...matrixFields,
    usageGroup: z.enum(["trade", "manufacturer"]).optional().catch(undefined),
  })
  .default({});

export type ToolsSearch = z.infer<typeof toolsSearchSchema>;

export function matrixSearchFromTools(search: ToolsSearch): ToolMatrixSearch {
  return {
    kinds: search.kinds,
    statuses: search.statuses,
    completed: search.completed,
    project: search.project,
    page: search.page,
    tool: search.tool,
    floor: search.floor,
    group: search.usageGroup,
  };
}

export function legacyToolSearchToTools(search: ToolMatrixSearch): ToolsSearch {
  const { group, ...matrix } = search;
  return { ...matrix, view: "usage", usageGroup: group };
}
