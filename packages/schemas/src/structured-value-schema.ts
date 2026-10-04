/**
 * The structured-value description every client's generic editor draws, derived from a field's
 * Zod input schema by `pnpm generate` (`scripts/generator/entities/render/value-schema.ts`). The
 * Swift manifest carries the same JSON as `FieldDescriptor.valueSchema` (encoded as Swift's
 * synthesized `Codable` encodes `ValueSchema`: a case with a labelled payload is
 * `{"case": {"label": value}}`, a payload-less one `{"boolean": {}}`), and web reads it from
 * `generated/structured-value-schemas.gen.ts`. Validation rules are not described here: the
 * server stays the only validator and its issues are mapped back onto this tree.
 */
export type StructuredOption = {
  readonly value: string;
  readonly label: string;
};

export type StructuredField = {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly schema: StructuredValueSchema;
  /**
   * Where the read payload carries this key when it is not at the same key (a dotted path, from
   * the input schema's `readFrom` metadata): the client's read-to-input projection fills the key
   * from there.
   */
  readonly readPath?: string;
};

/**
 * `date` is a calendar day (`yyyy-MM-dd`); `uuid` and `opaque` are carried untouched and never
 * shown (a row's id; a claim's identity key).
 */
export type StructuredTextFormat =
  | "uri"
  | "date"
  | "uuid"
  | "email"
  | "opaque"
  | null;

export type StructuredNode =
  | { readonly text: { readonly format: StructuredTextFormat } }
  | { readonly number: { readonly integer: boolean } }
  | { readonly boolean: Record<string, never> }
  | { readonly enum: { readonly options: readonly StructuredOption[] } }
  | { readonly reference: { readonly entity: string } }
  | { readonly amount: { readonly upper: boolean } }
  | { readonly constant: { readonly value: StructuredJson } }
  | { readonly object: { readonly fields: readonly StructuredField[] } }
  | { readonly array: { readonly item: StructuredValueSchema } }
  | {
      readonly map: {
        readonly keys: readonly StructuredOption[];
        readonly value: StructuredValueSchema;
      };
    }
  | {
      readonly variant: {
        readonly discriminator: string;
        readonly cases: readonly {
          readonly value: string;
          readonly label: string;
          readonly fields: readonly StructuredField[];
        }[];
      };
    };

export type StructuredJson =
  | string
  | number
  | boolean
  | null
  | readonly StructuredJson[]
  | { readonly [key: string]: StructuredJson };

export type StructuredValueSchema = {
  readonly nullable: boolean;
  readonly node: StructuredNode;
};
