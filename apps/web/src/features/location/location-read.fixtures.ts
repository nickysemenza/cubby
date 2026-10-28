import {
  locationDetailOut as infLocation,
  type LocationDetailOut as InfLocation,
} from "@cubby/schemas/entities/location";
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import {
  inventoryItemForTree,
  type LocationType,
} from "@cubby/schemas/location";
import { z } from "zod";

import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";

export type LocationFixtureOverrides = Omit<Partial<InfLocation>, "fields"> & {
  fields?: Partial<InfLocation["fields"]>;
  type?: LocationType | null;
  product?: unknown;
  images?: unknown[];
  displayImages?: unknown[];
  aiDescription?: unknown;
  valuation?: unknown;
  dataQuality?: unknown;
};

/** Synthetic records specify outcomes independently from ordinary topology. */
export function locationReadFixture(input: unknown): InfLocation {
  const record = z.record(z.string(), z.unknown()).parse(input);
  const fields = z.record(z.string(), z.unknown()).parse(record.fields ?? {});
  const product =
    record.product == null
      ? record.product
      : z.record(z.string(), z.unknown()).parse(record.product);
  if (product && !Object.hasOwn(product, "fields")) {
    const schema = entityFieldEnvelopeSchemas.product.output;
    record.product = entityReadFixture(schema, {
      ...product,
      fields: {
        brandName: fieldValueFixture(
          schema.shape.fields.shape.brandName,
          product.brandName,
        ),
        price: fieldValueFixture(
          schema.shape.fields.shape.price,
          product.price,
        ),
      },
    });
  }
  const inventoryItems =
    record.inventoryItems === undefined
      ? undefined
      : z
          .array(z.record(z.string(), z.unknown()))
          .parse(record.inventoryItems)
          .map((item) =>
            Object.hasOwn(item, "amount")
              ? entityReadFixture(inventoryItemForTree, {
                  ...item,
                  fields: {
                    amount: fieldValueFixture(
                      inventoryItemForTree.shape.fields.shape.amount,
                      item.amount,
                    ),
                  },
                })
              : item,
          );
  return entityReadFixture(infLocation, {
    ...record,
    ...(record.children === undefined
      ? {}
      : {
          children: z
            .array(z.unknown())
            .parse(record.children)
            .map(locationReadFixture),
        }),
    ...(record.parent == null
      ? {}
      : { parent: locationReadFixture(record.parent) }),
    ...(inventoryItems === undefined ? {} : { inventoryItems }),
    fields: Object.fromEntries(
      Object.entries(infLocation.shape.fields.shape).map(([key, schema]) => [
        key,
        Object.hasOwn(record, key)
          ? fieldValueFixture(schema, record[key])
          : (fields[key] ?? fieldValueFixture(schema, undefined)),
      ]),
    ),
  });
}
