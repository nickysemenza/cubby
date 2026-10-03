import Foundation

/// How a hero action is confirmed before it runs. `destructive` means a record is removed or
/// stock leaves a shelf, so the UI must show an explicit confirmation; never one tap.
public enum HeroActionConfirmation: String, Decodable, Sendable, Hashable {
    case none
    case destructive
}

/// One input the generic hero-action form asks for, from `nativeHeroActionPlans`
/// (`packages/schemas/src/native-coverage.ts`).
public struct HeroActionField: Decodable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Decodable, Sendable, Hashable {
        case number, text, date, toggle, choice, location, amount
        /// Options come from the plan's preview (`shelves`), never a guess.
        case shelf
    }

    public let key: String
    public let label: String
    public let kind: Kind
    public let defaultValue: JSONValue?
    public let options: [LabeledOption]?
    public let optional: Bool
    /// Shown, and sent, only while this toggle field is on; otherwise sent as null.
    public let showWhen: String?

    public var id: String { key }

    private enum CodingKeys: String, CodingKey {
        case key, label, kind, options, optional, showWhen
        case defaultValue = "default"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        label = try container.decode(String.self, forKey: .label)
        kind = try container.decode(Kind.self, forKey: .kind)
        defaultValue = try container.decodeIfPresent(JSONValue.self, forKey: .defaultValue)
        options = try container.decodeIfPresent([LabeledOption].self, forKey: .options)
        optional = try container.decodeIfPresent(Bool.self, forKey: .optional) ?? false
        showWhen = try container.decodeIfPresent(String.self, forKey: .showWhen)
    }
}

/// A verb that calls one RPC operation with a form-built body.
public struct HeroOperationPlan: Decodable, Sendable, Hashable {
    public struct Preview: Decodable, Sendable, Hashable {
        public let operation: String
        public let body: JSONValue
    }

    /// An HTTP operation id (`product.discard`); the runner maps it to a generated client call.
    public let operation: String
    public let confirmation: HeroActionConfirmation
    public let preview: Preview?
    public let fields: [HeroActionField]
    /// The request body with `$row.id` and `$<field key>` slots.
    public let body: JSONValue
}

/// What the one generic runner does for a manifest hero action, decoded from
/// `native-coverage.json`'s `heroActionPlan`. The verb is the manifest's; nothing is per entity
/// except the `entities` gate.
public struct HeroActionPlan: Decodable, Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        /// `resources.<entity>.delete`, behind the connection-impact preview.
        case delete
        case operation(HeroOperationPlan)
        /// Opens the generic create editor with `seed` (`$row.id` filled) pre-set.
        case create(entity: EntityKey, seed: [String: JSONValue])
        /// Picks a value for one declared enum field, then updates the row.
        case setField(field: String)
        /// Flips a boolean update field whose current state is read from `stateField`.
        case toggleField(field: String, stateField: String)
    }

    public let kind: Kind
    /// The menu title and its SF Symbol, single-sourced with the plan.
    public let label: String
    public let symbol: String
    /// Entities that may offer the verb; nil means any entity whose declaration names it.
    public let entities: [EntityKey]?

    /// The form's fields; empty for verbs with no input beyond a confirmation.
    public var fields: [HeroActionField] {
        if case .operation(let plan) = kind { return plan.fields }
        return []
    }

    public var confirmation: HeroActionConfirmation {
        switch kind {
        case .delete: .destructive
        case .operation(let plan): plan.confirmation
        case .create, .setField, .toggleField: .none
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, label, symbol, entities, entity, seed, field, stateField
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = try container.decode(String.self, forKey: .label)
        symbol = try container.decode(String.self, forKey: .symbol)
        entities = try container.decodeIfPresent([EntityKey].self, forKey: .entities)
        switch try container.decode(String.self, forKey: .kind) {
        case "delete":
            kind = .delete
        case "operation":
            kind = .operation(try HeroOperationPlan(from: decoder))
        case "create":
            kind = .create(
                entity: try container.decode(EntityKey.self, forKey: .entity),
                seed: try container.decode([String: JSONValue].self, forKey: .seed))
        case "setField":
            kind = .setField(field: try container.decode(String.self, forKey: .field))
        case "toggleField":
            kind = .toggleField(
                field: try container.decode(String.self, forKey: .field),
                stateField: try container.decode(String.self, forKey: .stateField))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container, debugDescription: "Unknown hero action plan kind \(other)")
        }
    }
}
