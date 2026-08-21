import {
  filterOptionsInput,
  filterOptionsOut,
} from "@cubby/schemas/filter-options";
import { getFilterOptions } from "~/server/repo/filter-options";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const filterOptionsRouter = createTRPCRouter({
  search: protectedProcedure
    .input(filterOptionsInput)
    .output(strictOutput(filterOptionsOut))
    .query(({ ctx, input }) => getFilterOptions(ctx.db, input)),
});
