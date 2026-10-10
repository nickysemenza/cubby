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
    /// The request body with `$row.id`, `$item.id` and `$field.<key>` slots.
    public let body: JSONValue
    /// The record must carry a value here before the action is offered.
    public let requires: Requirement?
    /// What the screen does with the result instead of a plain "done" notice.
    public let continueWith: Continuation?

    public struct Requirement: Decodable, Sendable, Hashable {
        /// `readPath` grammar, read against the record.
        public let path: String
        /// Shown in the action's place while the record lacks the value.
        public let reason: String
    }

    public enum Continuation: Decodable, Sendable, Hashable {
        /// Opens the record's editor with a value the operation derives staged for `field`.
        case editRecord(field: String)

        private enum CodingKeys: String, CodingKey { case kind, field }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(String.self, forKey: .kind) {
            case "editRecord": self = .editRecord(field: try container.decode(String.self, forKey: .field))
            case let other:
                throw DecodingError.dataCorruptedError(
                    forKey: .kind, in: container, debugDescription: "Unknown continuation \(other)")
            }
        }
    }
}

/// The title and guidance a create-editor hero action opens with when the capture is not a plain
/// "New <entity>" (record sale opens the expense editor as "Record Sale or Disposal"). The copy
/// is declared once, beside the web editor's `disposition` context that shows the same words.
public struct HeroEditorContext: Decodable, Sendable, Hashable {
    public let title: String
    public let description: String
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
        case create(entity: EntityKey, seed: [String: JSONValue], editor: HeroEditorContext?)
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

    public var operation: HeroOperationPlan? {
        if case .operation(let plan) = kind { return plan }
        return nil
    }

    /// One explicit tap runs it: an operation with no form, no preview and nothing destructive.
    public var runsOnTap: Bool {
        guard let plan = operation else { return false }
        return plan.fields.isEmpty && plan.preview == nil && plan.confirmation == .none
    }

    public var confirmation: HeroActionConfirmation {
        switch kind {
        case .delete: .destructive
        case .operation(let plan): plan.confirmation
        case .create, .setField, .toggleField: .none
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, label, symbol, entities, entity, seed, editor, field, stateField
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
                seed: try container.decode([String: JSONValue].self, forKey: .seed),
                editor: try container.decodeIfPresent(HeroEditorContext.self, forKey: .editor))
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
