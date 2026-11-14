import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  type VendorId,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ProductCategoryFeature } from "@cubby/schemas/product-category-fields";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import type { TestDbContext } from "tooling/test-setup";

import type { DecisionPort } from "~/server/ai/decision-model";
import type { ReferenceSuggestSpec } from "~/server/ai/field-suggest/registry";
import type { Database } from "~/server/db";
import { entityKernelContextSchema } from "~/server/entity-kernel/adapter";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

type Ctx = Pick<TestDbContext, "db" | "actor">;

export const PRIMARY_MODEL =
  "typesafe/jev" as const satisfies SupportedDecisionModel;

export const kernelCtx = (ctx: Ctx) =>
  entityKernelContextSchema.parse(
    createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
  );

/** Provider seam shared by the existing review journeys. */

export async function recordId<E extends ShortcodeEntity>(
  db: Database,
  shortcode: string,
  entity: E,
) {
  const id = await resolveLiveShortcode(db, shortcode, entity);
  if (!id) throw new Error(`Synthetic ${entity} record is missing`);
  return id;
}

/** The review queue filters by a Run's public shortcode. */

export const productFixture = (
  ctx: Ctx,
  name: string,
  input: {
    brandId?: VendorId | VendorShortcode | null;
    model?: ReturnType<typeof makeProductInput>["model"];
    notes?: string;
    categoryId?: ReturnType<typeof taxonomyId>;
  } = {},
) =>
  createProductFixture(ctx.db, makeProductInput({ name, ...input }), ctx.actor);

/** The single category the decision roster offers, so every decision proposes it. */
const SUGGESTED_CATEGORY: ProductCategoryFeature = "food";

type CategoryCandidate = { id: string; title: string };
const categorySpec: ReferenceSuggestSpec<CategoryCandidate> = {
  kind: "reference",
  entity: "productCategory",
  rules: "Choose the category.",
  maxCandidates: 5,
  roster: async () => [
    { id: taxonomyShortcode(SUGGESTED_CATEGORY), title: "Synthetic food" },
  ],
  idOf: (candidate) => candidate.id,
  labelOf: (candidate) => candidate.title,
  renderLine: ({ id, title }) => `${id} | ${title}`,
  subject: (basis) => `Product: ${basis.name ?? ""}`,
};

const decisionAt =
  (confidence: number): DecisionPort =>
  async (input) => {
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = keys[0]!;
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice
                ? confidence
                : (1 - confidence) / Math.max(1, keys.length - 1),
            ]),
          ),
        },
      },
    };
  };

/** Real field-suggest path for `product.categoryId` with a scripted the decision model. */
export const categoryPorts = (confidence = 0.97) => ({
  suggestPorts: {
    decisionPort: decisionAt(confidence),
    registry: { "product.categoryId": categorySpec },
  },
});

/** Existing review journeys use the production key reader and field hydrator. */
