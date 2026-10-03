import CubbyAPISupport
import Foundation

public enum HeroActionError: Error, Equatable, Sendable {
    /// A destructive plan ran without the explicit confirmation its UI collects.
    case confirmationRequired
    /// A required form field has no value.
    case missing(String)
    /// The plan names an operation or entity the runner has no typed handler for.
    case unsupported(String)
}

/// What a finished hero action asks the screen to do next.
public enum HeroActionOutcome: Sendable, Equatable {
    /// The write happened; `changed` lists every entity kind it could have touched, so the
    /// screens showing them refresh.
    case completed(String, changed: Set<EntityKey>)
    /// Open the generic editor (create mode) on `entity`, seeded with `prefill`.
    case editor(entity: EntityKey, prefill: [String: JSONValue])
}

/// The server's answer to "what will this do?" for a verb that has one.
public enum HeroActionPreview: Sendable {
    case discard(ProductDiscardPreviewOut)
    case deleteImpact(EntityConnectionsOut)
}

/// The one generic native path for manifest hero actions. The verb picks a `HeroActionPlan`
/// (declared in `packages/schemas/src/native-coverage.ts`, not per entity), the plan names the
/// generated operation, and the form is the plan's field list. The only Swift per operation is
/// the typed call below, and `HeroActionRunnerTests` check every plan operation against the
/// generated route table.
public struct HeroActionRunner: Sendable {
    public let client: CubbyClient

    public init(client: CubbyClient) {
        self.client = client
    }

    // MARK: - Verb to plan

    /// The plan for `verb` on `entity`, or nil when the verb is not implemented natively
    /// (`edit`, `bulkEdit`) or the entity is outside the plan's gate.
    public static func plan(for verb: EntityHeroActionID, on entity: EntityKey) -> HeroActionPlan? {
        guard let plan = NativeCoverageManifest.shared.heroActionPlan[verb.rawValue] else { return nil }
        if let entities = plan.entities, !entities.contains(entity) { return nil }
        if case .delete = plan.kind, !entity.nativeActions.contains(.delete) { return nil }
        return plan
    }

    /// The generated HTTP operation id the plan executes for `entity`.
    public static func operationID(for plan: HeroActionPlan, on entity: EntityKey) -> String? {
        switch plan.kind {
        case .delete: return "resources.\(entity.rawValue).delete"
        case .operation(let operation): return operation.operation
        case .create(let target, _): return "resources.\(target.rawValue).create"
        case .setField, .toggleField: return "resources.\(entity.rawValue).update"
        }
    }

    /// Operation ids with a typed handler in `perform`, and previews in `preview`.
    public static let handledOperations: Set<String> = ["product.discard", "inventory.bulkAdd"]
    public static let handledPreviews: Set<String> = ["product.discardPreview"]

    // MARK: - Form

    /// Starting values for a form: each field's declared default, with `today` resolved.
    public static func defaults(for fields: [HeroActionField], now: Date = Date()) -> [String: JSONValue] {
        var values: [String: JSONValue] = [:]
        for field in fields {
            switch field.defaultValue {
            case .string("today"): values[field.key] = .string(plainDate(now))
            case .string("one"): values[field.key] = ["value": 1, "unit": "each"]
            case let value?: values[field.key] = value
            case nil: break
            }
        }
        return values
    }

    /// The values to send: a field gated by an off `showWhen` toggle and a blank optional field
    /// are null; a blank required field is refused so no request goes out half-filled.
    public static func resolvedValues(
        _ fields: [HeroActionField], values: [String: JSONValue]
    ) throws -> [String: JSONValue] {
        var resolved: [String: JSONValue] = [:]
        for field in fields {
            if let gate = field.showWhen, values[gate]?.boolValue != true {
                resolved[field.key] = .null
                continue
            }
            var value = values[field.key] ?? .null
            if case .string(let text) = value {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                value = trimmed.isEmpty ? .null : .string(trimmed)
            }
            if value == .null, field.kind == .toggle { value = .bool(false) }
            if value == .null, !field.optional { throw HeroActionError.missing(field.key) }
            resolved[field.key] = value
        }
        return resolved
    }

    /// Replaces `$row.id` and `$<field key>` slots in a plan template; everything else is literal.
    public static func fill(_ template: JSONValue, rowID: String, values: [String: JSONValue]) -> JSONValue {
        switch template {
        case .string(let text) where text == "$row.id": return .string(rowID)
        case .string(let text) where text.hasPrefix("$"): return values[String(text.dropFirst())] ?? .null
        case .array(let items): return .array(items.map { fill($0, rowID: rowID, values: values) })
        case .object(let fields): return .object(fields.mapValues { fill($0, rowID: rowID, values: values) })
        default: return template
        }
    }

    private static func plainDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    // MARK: - Preview

    /// The server's preview for this plan with the current form values; nil when it has none.
    public func preview(
        _ plan: HeroActionPlan, on entity: EntityKey, rowID: String, values: [String: JSONValue]
    ) async throws -> HeroActionPreview? {
        switch plan.kind {
        case .delete:
            return .deleteImpact(try await client.physicalConnections(id: rowID, previewDelete: true))
        case .operation(let operation):
            guard let preview = operation.preview else { return nil }
            let body = Self.fill(preview.body, rowID: rowID, values: values)
            switch preview.operation {
            case "product.discardPreview":
                return .discard(
                    try await client.discardPreview(
                        .init(
                            productId: rowID, quantity: body["quantity"]?.doubleValue,
                            adjustInventory: body["adjustInventory"]?.boolValue,
                            inventoryEntryId: body["inventoryEntryId"]?.stringValue)))
            default: throw HeroActionError.unsupported(preview.operation)
            }
        case .create, .setField, .toggleField:
            return nil
        }
    }

    // MARK: - Run

    /// Runs the plan. A destructive plan throws `confirmationRequired` unless `confirmed`; the
    /// screen sets it only after the person taps the confirmation button.
    @discardableResult
    public func perform(
        _ plan: HeroActionPlan, on entity: EntityKey, row: EntityRow, values: [String: JSONValue],
        confirmed: Bool
    ) async throws -> HeroActionOutcome {
        if plan.confirmation == .destructive, !confirmed { throw HeroActionError.confirmationRequired }
        let descriptor = EntityCatalog[entity]
        switch plan.kind {
        case .delete:
            try await client.delete(descriptor, id: row.id)
            return .completed("\(descriptor.singular) deleted", changed: [entity])
        case .operation(let operation):
            let resolved = try Self.resolvedValues(operation.fields, values: values)
            let body = Self.fill(operation.body, rowID: row.id, values: resolved)
            switch operation.operation {
            case "product.discard":
                let result = try await client.discardProduct(try body.decoded())
                let removed = result.inventory?.removed == true ? "; shelf entry removed" : ""
                return .completed(
                    "Discarded \(abs(result.storedQuantity).formatted())\(removed)",
                    changed: [entity, .expense, .inventory])
            case "inventory.bulkAdd":
                let result = try await client.bulkAddInventory(try body.decoded())
                return .completed(
                    result.mergedCount == 0
                        ? "Added to inventory" : "Added to inventory; merged into stock already there",
                    changed: [entity, .inventory, .location])
            default: throw HeroActionError.unsupported(operation.operation)
            }
        case .create(let target, let seed):
            var prefill: [String: JSONValue] = [:]
            for (key, value) in seed {
                let filled = Self.fill(value, rowID: row.id, values: values)
                if filled != .null { prefill[key] = filled }
            }
            return .editor(entity: target, prefill: prefill)
        case .setField(let field):
            guard let value = values[field], value != .null else { throw HeroActionError.missing(field) }
            try await client.update(descriptor, id: row.id, patch: EntityPatch(values: [field: value]))
            return .completed("\(descriptor.singular) updated", changed: [entity])
        case .toggleField(let field, let stateField):
            let isSet = row.raw[stateField].map { $0 != .null } ?? false
            try await client.update(
                descriptor, id: row.id, patch: EntityPatch(values: [field: .bool(!isSet)]))
            return .completed("\(descriptor.singular) updated", changed: [entity])
        }
    }
}
