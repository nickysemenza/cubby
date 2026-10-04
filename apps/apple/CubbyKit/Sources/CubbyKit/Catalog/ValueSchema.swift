import CubbyAPISupport
import Foundation

/// The schema description of a structured field's value: what the server's input schema accepts,
/// with no validation rules. `pnpm generate` derives it from the field's Zod input schema
/// (`scripts/generator/entities/render/value-schema.ts`) and writes it into the manifest as
/// `FieldDescriptor.valueSchema`; `StructuredValueEditor` draws any schema, so a new structured
/// field needs a declaration, not Swift. Synthesized `Codable` — the generator emits
/// `{"array": {"item": …}}` for a labelled payload and `{"boolean": {}}` for none.
public struct ValueSchema: Codable, Sendable, Hashable {
    /// The server accepts `null` here; the editor offers a way to clear it.
    public let nullable: Bool
    public let node: Node

    public init(nullable: Bool = false, node: Node) {
        self.nullable = nullable
        self.node = node
    }

    public indirect enum Node: Codable, Sendable, Hashable {
        /// `format` is `uri`, `date` (`yyyy-MM-dd`), `uuid` (opaque: preserved, never edited) or `email`.
        case text(format: String?)
        case number(integer: Bool)
        case boolean
        case `enum`(options: [LabeledOption])
        /// A shortcode of this entity, picked rather than typed.
        case reference(entity: EntityKey)
        /// `{value, unit}`; `upper` when the schema also takes an `upperValue` range end.
        case amount(upper: Bool)
        /// A value the server fixes (a union's `null` arm): written when a row is created, never edited.
        case constant(value: JSONValue)
        case object(fields: [Field])
        case array(item: ValueSchema)
        /// An object keyed by one of `keys` (a partial record): rows are the present keys.
        case map(keys: [LabeledOption], value: ValueSchema)
        /// An object of one of several schemas, told apart by a literal `discriminator` key.
        case variant(discriminator: String, cases: [Case])
    }

    public struct Field: Codable, Sendable, Hashable {
        public let key: String
        public let label: String
        /// The input schema rejects this key absent; an absent optional key is left out of the value.
        public let required: Bool
        public let schema: ValueSchema
        /// Where the read payload carries this key when it is not at the same key (dotted, from
        /// the input schema's `readFrom`): a recipe line's `ingredientId` is read at
        /// `ingredient.id`. `StructuredValue.project` fills the key from there.
        public let readPath: String?

        public init(key: String, label: String, required: Bool, schema: ValueSchema, readPath: String? = nil)
        {
            self.key = key
            self.label = label
            self.required = required
            self.schema = schema
            self.readPath = readPath
        }
    }

    public struct Case: Codable, Sendable, Hashable {
        public let value: String
        public let label: String
        public let fields: [Field]
    }
}
