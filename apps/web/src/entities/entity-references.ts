import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { z } from "zod";

type ReferenceField = Pick<
  EntityFieldModel["fields"][number],
  "key" | "readKey" | "reference"
>;

const referenceObject = z.object({
  id: z.string(),
  name: z.string().nullish(),
});

export interface ReferenceItem {
  id: string;
  name: string | null;
}

export interface ReferenceFieldValue {
  entity: string;
  items: ReferenceItem[];
}

const projection = z.looseObject({});

/**
 * One declared key off a read projection, parsed with the schema the caller
 * knows that key by. The manifest names the key; the schema is the value's
 * own contract.
 */
export const readRecordField = <TRecord extends object, TValue>(
  record: TRecord,
  key: string,
  schema: z.ZodType<TValue>,
): TValue => schema.parse(projection.parse(record)[key]);

const referenceIds = z.union([z.string(), z.array(z.string())]).nullish();

const referenceObjectValue = referenceObject.nullish();
const referenceObjects = z.array(referenceObject).nullish();

const multipleItems = (raw: unknown, nested: unknown): ReferenceItem[] => {
  const ids = z.array(z.string()).nullish().parse(raw) ?? [];
  const nestedItems = z.array(referenceObject).nullish().safeParse(nested);
  if (ids.length === 0 && nestedItems.success && nestedItems.data)
    return nestedItems.data.map((item) => ({
      id: item.id,
      name: item.name ?? null,
    }));
  return ids.map((id) => ({ id, name: null }));
};

const singleItem = (
  raw: unknown,
  nested: unknown,
  nestedName: string | null,
): ReferenceItem[] => {
  const id = z.string().nullish().parse(raw) ?? null;
  const nestedItem = referenceObject.nullish().safeParse(nested);
  const resolved = nestedItem.success ? (nestedItem.data ?? null) : null;
  const itemId = id ?? resolved?.id ?? null;
  return itemId === null
    ? []
    : [{ id: itemId, name: nestedName ?? resolved?.name ?? null }];
};

/**
 * The linked record(s) a reference field names. A projection carries the
 * shortcode under the field's `readKey` (`projectId`), or nests the target
 * under the key minus `Id` (`parent`, `product`); the label comes from
 * `<key minus Id>Name` (`vendorName`), then the nested record's `name`, then
 * the shortcode itself. Kept free of React so the editor request builders
 * the eager route chunks load can seed from it.
 */
export function readReferenceField<TRecord extends object>(
  record: TRecord,
  field: ReferenceField,
): ReferenceFieldValue | null {
  const reference = field.reference;
  if (reference === null) return null;
  const base = field.key.replace(/Ids?$/u, "");
  const nested = readRecordField(record, base, z.unknown());
  if (z.number().safeParse(nested).success) return null;
  const nestedName =
    readRecordField(record, `${base}Name`, z.string().nullish()) ?? null;
  const raw =
    field.readKey === null
      ? undefined
      : readRecordField(record, field.readKey, z.unknown());
  // A reference whose read key carries a count (recipe `meals` reads
  // `meals`) names related records without listing them; it renders as
  // the scalar it is.
  const parsedIds = referenceIds.safeParse(raw);
  const parsedObject = referenceObjectValue.safeParse(raw);
  const parsedNested = referenceObjects.safeParse(raw);
  // Some enriched detail projections put the linked record itself under the
  // field's read key (for example location.product), while older projections
  // put a shortcode there. Normalize both shapes before rendering so an
  // expanded relation never falls through to the scalar identifier parser.
  if (!parsedIds.success && !parsedObject.success && !parsedNested.success)
    return null;
  const normalizedRaw =
    parsedIds.success && parsedIds.data !== undefined
      ? parsedIds.data
      : undefined;
  const normalizedNested = parsedNested.success
    ? (parsedNested.data ?? nested)
    : parsedObject.success
      ? (parsedObject.data ?? nested)
      : nested;
  return {
    entity: reference.entity,
    items: reference.multiple
      ? multipleItems(normalizedRaw, normalizedNested)
      : singleItem(normalizedRaw, normalizedNested, nestedName),
  };
}
