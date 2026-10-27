import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import {
  fieldEnvelopeFor,
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { z } from "zod";

import { projectProductUnitPrices } from "~/server/domains/product/repo/list-enrichment";
import {
  buildFieldEnvelopeRow,
  type FieldEnvelopeProjector,
} from "~/server/generic/derived/repo/envelope";
import { currentReadFacts } from "~/server/generic/derived/repo/read-context";

/** Cost and unit-price reads share the selected valuation, even when price is not returned. */
export function projectProductFieldEnvelopes({
  entity,
  row,
  stored,
  ownership,
  assignments,
  built,
}: Parameters<FieldEnvelopeProjector>[0]): ReturnType<FieldEnvelopeProjector> {
  const cost = fieldEnvelopeFor(built, "cost");
  const unitFields = ["unitPrice", "unitPriceLabel", "unitPriceDetailLabel"];
  const needsUnitPrice = unitFields.some((key) => fieldEnvelopeFor(built, key));
  if (!cost && !needsUnitPrice) return built;
  let price = fieldEnvelopeFor(built, "price");
  if (!price) {
    const productSchema = entityFieldEnvelopeSchemas.product.output;
    if (
      !(productSchema instanceof z.ZodObject) ||
      !(productSchema.shape.fields instanceof z.ZodObject)
    )
      throw new Error("Product output requires concrete envelope fields");
    price = fieldEnvelopeFor(
      buildFieldEnvelopeRow({
        schema: z.object({
          fields: productSchema.shape.fields.pick({ price: true }),
        }),
        entity,
        row,
        stored,
        ownership,
        assignments,
      }),
      "price",
    );
  }
  if (!price)
    throw new Error(
      "Product price projections require their selected valuation",
    );
  const selectedFields = currentReadFacts.parse(built.fields);
  if (cost) selectedFields.cost = projectProductCost(price, cost);
  let output = built;
  if (needsUnitPrice) {
    const selectedPrice = z.number().nullable().parse(fieldValueOf(price));
    const units = projectProductUnitPrices({
      product: row,
      price: selectedPrice,
      service:
        price.result.kind !== "missing" &&
        price.result.decision.outcome.kind === "empty" &&
        price.result.decision.outcome.reason === "not_applicable",
    });
    output = { ...built, unitPriceMappings: units.unitPriceMappings };
    // This is a current computation over selected inputs, not the historical
    // graph that produced a cached price. Keep its decision computed and carry work separately.
    for (const [key, value] of Object.entries(units.values)) {
      const original = fieldEnvelopeFor(built, key);
      if (!original) continue;
      selectedFields[key] = {
        current: original.current,
        result:
          value === null && price.result.kind === "missing"
            ? { kind: "missing" }
            : {
                kind: "live",
                decision: {
                  outcome:
                    value === null
                      ? {
                          kind: "empty",
                          reason: units.service ? "not_applicable" : "unset",
                        }
                      : { kind: "value", value },
                  provenance: { kind: "computed" },
                },
              },
        work: price.work,
      };
    }
  }
  return { ...output, fields: selectedFields };
}

/** Physical Cost has exactly the selected price snapshot, provenance and work. */
function projectProductCost(
  price: ReadableFieldEnvelope,
  serviceCost: ReadableFieldEnvelope,
): ReadableFieldEnvelope {
  const result = price.result;
  if (
    result.kind !== "missing" &&
    result.decision.outcome.kind === "empty" &&
    result.decision.outcome.reason === "not_applicable"
  )
    return serviceCost;
  return {
    current: {
      assignment: null,
      controls: { kind: "readonly", reason: "computed" },
    },
    result:
      result.kind === "missing"
        ? result
        : {
            ...result,
            decision: {
              ...result.decision,
              outcome:
                result.decision.outcome.kind === "empty"
                  ? result.decision.outcome
                  : {
                      kind: "value",
                      value: {
                        kind: "item",
                        amount: z.number().parse(result.decision.outcome.value),
                      },
                    },
            },
          },
    work: price.work,
  };
}
