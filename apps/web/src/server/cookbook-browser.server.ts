import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { z } from "zod";
import { getCookbookSummary, listCookbooks } from "~/server/repo/cookbook";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";

export const cookbookDetailInput = z.object({
  shortcode: cookbookShortcode,
});

export const listCookbookSummaries = async (options: {
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "cookbook.list",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: cookbookSummariesOut,
    request: options.request,
    run: async (context) => await listCookbooks(context.readDb),
  });

export const getCookbookDetail = async (options: {
  data: z.input<typeof cookbookDetailInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "cookbook.detail",
    type: "query",
    input: options.data,
    inputSchema: cookbookDetailInput,
    outputSchema: cookbookSummary.nullable(),
    request: options.request,
    readPolicy: "strong",
    run: async (context, input) =>
      await getCookbookSummary(context.db, input.shortcode),
  });
