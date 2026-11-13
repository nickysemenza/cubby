import { sql } from "drizzle-orm";
import { z } from "zod";

import { product, productIdentityObservation } from "~/server/db/schema";
import {
  defineEvidence,
  defineModule,
  defineReconciler,
  recordSubject,
  source,
  writes,
} from "~/server/kernel/api";

import { productPairObservation } from "./product-pair-observation";

export const productIdentityEvidence = defineEvidence({
  kind: "productPairObservation",
  table: productIdentityObservation,
  keys: (row) => [`productPair:${row.scopeKey}`],
  discovers: (row) => [{ kind: "productIdentity", key: row.scopeKey }],
});

export const productPairRecords = writes(product, [], {
  entity: "product",
  merge: async (db, { keepId, loserIds, actor }) => {
    const { mergeProducts } =
      await import("~/server/domains/product/repo/merge");
    const { repositoryQueries } =
      await import("~/server/db/repository-access.boundary");
    const { parseShortcodeFor } = await import("@cubby/schemas/identifiers");
    const { uuidArrayParam } = await import("~/server/db/helpers/query");
    const rows = await repositoryQueries(db)
      .select({ id: product.id, shortcode: product.shortcode })
      .from(product)
      .where(sql`${product.id}=ANY(${uuidArrayParam([keepId, ...loserIds])})`);
    const keeper = rows.find((row) => row.id === keepId);
    if (!keeper) throw new Error("Product survivor is no longer available");
    await mergeProducts(
      db,
      {
        keepId: parseShortcodeFor("product", keeper.shortcode),
        mergeIds: rows
          .filter((row) => row.id !== keepId)
          .map((row) => parseShortcodeFor("product", row.shortcode)),
      },
      actor,
    );
  },
});

type Input = {
  key: string;
  facts: (typeof productIdentityObservation.$inferSelect)[];
  products: (typeof product.$inferSelect)[];
};
const productIdentity = defineReconciler<Input>({
  scope: "productIdentity",
  lane: "money",
  version: 1,
  reads: [
    source.evidence(productIdentityEvidence),
    source.table(productIdentityObservation, [
      "scopeKey",
      "payload",
      "createdAt",
    ]),
    source.table(product, ["name", "model", "deletedAt"]),
  ],
  writes: [productPairRecords],
  async load(reads, keys) {
    const [facts, products] = await Promise.all([
      reads.select(productIdentityObservation, [], sql`true`),
      reads.select(product, [], sql`true`),
    ]);
    return new Map(keys.map((key) => [key, { key, facts, products }]));
  },
  reconcile(input, c) {
    const fact = input.facts
      .filter(
        (row) =>
          productPairObservation.safeParse(row.payload).data?.productPair ===
          input.key,
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      )[0];
    if (!fact) return c.done();
    const observed = productPairObservation.parse(fact.payload);
    const [a, b] = observed.productIds.map((id) => c.reference("product", id));
    if (!a || !b || a === b) return c.done();
    const first = input.products.find((row) => row.id === a && !row.deletedAt);
    const second = input.products.find((row) => row.id === b && !row.deletedAt);
    if (!first || !second) return c.done();
    const left = recordSubject("product", a),
      right = recordSubject("product", b);
    const choice = c.decision("identity", left, right);
    if (choice?.kind === "distinct") return c.done();
    const history = input.facts.flatMap((row) => {
      const value = productPairObservation.safeParse(row.payload);
      if (!value.success) return [];
      const ids = value.data.productIds
        .map((id) => c.reference("product", id))
        .sort();
      if (ids.join("|") !== [a, b].sort().join("|")) return [];
      const variant = z
        .object({
          variantEvidence: z
            .object({ dimensions: z.array(z.object({ relation: z.string() })) })
            .optional(),
        })
        .safeParse(value.data.data.signals).data;
      const conflict =
        value.data.data.conflict ||
        variant?.variantEvidence?.dimensions.some(
          (value) => value.relation === "different",
        );
      return conflict ? [value.data] : [];
    });
    const historical = history.some(
      (prior) =>
        prior.productIds.some((id) => c.reference("product", id) !== id) ||
        !observed.fingerprint ||
        !prior.fingerprint ||
        prior.fingerprint === observed.fingerprint,
    );
    if (
      observed.data.conflict ||
      historical ||
      (first.model && second.model && first.model !== second.model)
    ) {
      c.gap.unsupported(
        "conflicting Product variants need corrected identity evidence",
      );
      return c.done();
    }
    if (choice?.kind === "same") {
      const chosen = c.decision(
        "assignment",
        `productPair:${input.key}`,
        "keepId",
      );
      const keepId =
        typeof chosen?.value === "string"
          ? c.reference("product", chosen.value)
          : null;
      c.merge(
        productPairRecords,
        a,
        b,
        "decision",
        keepId ? { keepId } : undefined,
      );
      return c.done();
    }
    if (observed.data.actionable)
      c.gap.decision("whether these Products identify the same item", {
        actions: [
          {
            channel: "identity",
            kind: "same",
            subject: left,
            field: right,
            label: "Same Product",
          },
          {
            channel: "identity",
            kind: "distinct",
            subject: left,
            field: right,
            label: "Distinct Products",
          },
        ],
      });
    return c.done();
  },
});
export const productIdentityKernelModule = defineModule({
  name: "productIdentity",
  evidence: [productIdentityEvidence],
  reconcilers: [productIdentity],
});
