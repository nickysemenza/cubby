import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";
import { cookbook } from "~/entities/cookbook.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getCookbookSummary, listCookbooks } from "~/server/repo/cookbook";

/**
 * The client declares a plain-string shortcode; the server owns brand
 * validation so a malformed code fails at the input stage as BAD_REQUEST.
 */
const cookbookDetailInput = z.object({ shortcode: cookbookShortcode });

export const cookbookHandlers = implementOperationDomain(cookbook, {
  list: (context) => listCookbooks(context.readDb),
  detail: {
    readPolicy: "strong",
    input: cookbookDetailInput,
    run: (context, input) =>
      getCookbookSummary(context.db, cookbookShortcode.parse(input.shortcode)),
  },
});
