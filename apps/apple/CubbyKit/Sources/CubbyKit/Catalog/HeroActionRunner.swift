import CubbyAPISupport
import Foundation

public enum HeroActionError: Error, Equatable, Sendable {
    /// A destructive plan ran without the explicit confirmation its UI collects.
    case confirmationRequired
    /// A required form field has no value.
    case missing(String)
    /// The plan names an operation or entity the runner has no typed handler for.
    case unsupported(String)
    /// The server has nothing to act on yet (a label with no detected nutrition).
    case unavailable(String)
}

extension HeroActionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .confirmationRequired: "Confirm before running this action."
        case .missing(let field): "Fill in \(field) first."
        case .unsupported(let operation): "\(operation) is not available in this app."
        case .unavailable(let reason): reason
        }
    }
}

/// What a finished hero action asks the screen to do next.
public enum HeroActionOutcome: Sendable, Equatable {
    /// The write happened; `changed` lists every entity kind it could have touched, so the
    /// screens showing them refresh.
    case completed(String, changed: Set<EntityKey>)
    /// Open the generic editor (create mode) on `entity`, seeded with `prefill`.
    case editor(entity: EntityKey, prefill: [String: JSONValue], context: HeroEditorContext?)
    /// Open the update editor on an existing record with `staged` values set for review; Save is
    /// the only write.
    case editRecord(entity: EntityKey, id: String, staged: [String: JSONValue])
    /// An AI answer the server already saved, shown against what it replaced before the person
    /// moves on. Keep and Hide both just close it, as on web.
    case review(HeroActionReview)
}

/// One AI answer set beside the text it replaced. The server composes both sides (`previous` is
/// the description before this run), so nothing here is derived from a record that refetched.
public struct HeroActionReview: Sendable, Equatable {
    public let label: String
    public let previous: String?
    public let proposed: String
    public let confidence: String
    public let reasoning: String
    public let model: String
    public let analyzedAt: Date
    /// `hit` replays a stored analysis, `miss` read the photos again.
    public let cacheStatus: String
    /// The entity kinds the run changed, so the screens showing them refresh.
    public let changed: Set<EntityKey>

    public init(
        label: String, previous: String?, proposed: String, confidence: String, reasoning: String,
        model: String, analyzedAt: Date, cacheStatus: String, changed: Set<EntityKey>
    ) {
        self.label = label
        self.previous = previous
        self.proposed = proposed
        self.confidence = confidence
        self.reasoning = reasoning
        self.model = model
        self.analyzedAt = analyzedAt
        self.cacheStatus = cacheStatus
        self.changed = changed
    }
}

/// The server's answer to "what will this do?" for a verb that has one.
public enum HeroActionPreview: Sendable {
    case discard(ProductDiscardPreviewOut)
    case addToInventory(ProductAddToInventoryPreviewOut)
    case deleteImpact(EntityConnectionsOut)
    case launch(TargetedLaunchPreview)
}

/// What a targeted purchase-validation launch can replay: whether validation may start, why not,
/// and the evidence sources to choose from.
public struct TargetedLaunchPreview: Sendable, Equatable {
    public struct Source: Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let kind: String
        public let accountLabel: String?
        public let usable: Bool
        public let reason: String?
        public let isDefault: Bool

        public var detail: String {
            [kind, accountLabel, reason].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }

    public let canValidate: Bool
    public let reason: String?
    public let sources: [Source]

    init(_ output: RunTargetedLaunchOutput) throws {
        let purchase = try JSONValue(encoding: output)["purchase"]
        canValidate = purchase?["canValidate"]?.boolValue ?? false
        reason = purchase?["reason"]?.stringValue
        sources = (purchase?["sources"]?.arrayValue ?? []).compactMap { source in
            guard let id = source["id"]?.stringValue, let label = source["label"]?.stringValue else {
                return nil
            }
            return Source(
                id: id, label: label, kind: source["kind"]?.stringValue ?? "",
                accountLabel: source["vendorAccountLabel"]?.stringValue,
                usable: source["usable"]?.boolValue ?? false, reason: source["reason"]?.stringValue,
                isDefault: source["default"]?.boolValue ?? false)
        }
    }
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

    /// The plan for a collection-section verb on `entity`, or nil outside the plan's entity gate.
    public static func plan(for action: CollectionActionID, on entity: EntityKey) -> HeroActionPlan? {
        guard let plan = NativeCoverageManifest.shared.collectionActionPlan[action.rawValue] else {
            return nil
        }
        if let entities = plan.entities, !entities.contains(entity) { return nil }
        return plan
    }

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
        case .create(let target, _, _): return "resources.\(target.rawValue).create"
        case .setField, .toggleField: return "resources.\(entity.rawValue).update"
        }
    }

    /// Operation ids with a typed handler in `perform`, and previews in `preview`.
    public static let handledOperations: Set<String> = [
        "product.discard", "inventory.bulkAdd", "ai.describeLocation", "image.attachExisting",
        "imageProcessing.status", "run.startTargeted",
    ]
    public static let handledPreviews: Set<String> = [
        "product.discardPreview", "product.addToInventoryPreview", "run.targetedLaunch",
    ]

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

    /// The values as the server should see them: a field gated by an off `showWhen` toggle is
    /// null, a blank string is null, a missing toggle is off. Previews and the write both send
    /// these, so a preview describes exactly what submit would do.
    public static func normalizedValues(
        _ fields: [HeroActionField], values: [String: JSONValue]
    ) -> [String: JSONValue] {
        var normalized: [String: JSONValue] = [:]
        for field in fields {
            if let gate = field.showWhen, values[gate]?.boolValue != true {
                normalized[field.key] = .null
                continue
            }
            var value = values[field.key] ?? .null
            if case .string(let text) = value {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                value = trimmed.isEmpty ? .null : .string(trimmed)
            }
            if value == .null, field.kind == .toggle { value = .bool(false) }
            normalized[field.key] = value
        }
        return normalized
    }

    /// `normalizedValues`, refusing a blank required field so no request goes out half-filled.
    public static func resolvedValues(
        _ fields: [HeroActionField], values: [String: JSONValue]
    ) throws -> [String: JSONValue] {
        let normalized = normalizedValues(fields, values: values)
        for field in fields where !field.optional && normalized[field.key] == .null {
            throw HeroActionError.missing(field.key)
        }
        return normalized
    }

    /// Replaces `$row.id`, `$item.id` (the tapped collection row) and `$field.<key>` slots in a
    /// plan template; every other string is literal.
    public static func fill(
        _ template: JSONValue, rowID: String, itemID: String? = nil, values: [String: JSONValue]
    ) -> JSONValue {
        switch template {
        case .string("$row.id"): return .string(rowID)
        case .string("$item.id"): return itemID.map(JSONValue.string) ?? .null
        case .string(let text) where text.hasPrefix("$field."):
            return values[String(text.dropFirst("$field.".count))] ?? .null
        case .array(let items):
            return .array(items.map { fill($0, rowID: rowID, itemID: itemID, values: values) })
        case .object(let fields):
            return .object(fields.mapValues { fill($0, rowID: rowID, itemID: itemID, values: values) })
        default: return template
        }
    }

    /// Why the record cannot take the plan yet (the plan's `requires` is unmet), or nil when it can.
    public static func unmet(_ plan: HeroActionPlan, in raw: JSONValue) -> String? {
        guard let requirement = plan.operation?.requires else { return nil }
        switch raw.pathValue(requirement.path) {
        case nil, .null?: return requirement.reason
        case .array(let items)?: return items.isEmpty ? requirement.reason : nil
        case .string(let text)?: return text.isEmpty ? requirement.reason : nil
        default: return nil
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
        _ plan: HeroActionPlan, on entity: EntityKey, rowID: String, itemID: String? = nil,
        values: [String: JSONValue]
    ) async throws -> HeroActionPreview? {
        switch plan.kind {
        case .delete:
            return .deleteImpact(try await client.physicalConnections(id: rowID, previewDelete: true))
        case .operation(let operation):
            guard let preview = operation.preview else { return nil }
            let body = Self.fill(preview.body, rowID: rowID, itemID: itemID, values: values)
            switch preview.operation {
            case "product.discardPreview":
                return .discard(
                    try await client.discardPreview(
                        .init(
                            productId: rowID, quantity: body["quantity"]?.doubleValue,
                            adjustInventory: body["adjustInventory"]?.boolValue,
                            inventoryEntryId: body["inventoryEntryId"]?.stringValue)))
            case "product.addToInventoryPreview":
                return .addToInventory(
                    try await client.addToInventoryPreview(
                        .init(productId: rowID, locationId: body["locationId"]?.stringValue)))
            case "run.targetedLaunch":
                guard let targetID = body["targetId"]?.stringValue else {
                    throw HeroActionError.missing("targetId")
                }
                let enrichment = body["purpose"]?.stringValue == "product_enrichment"
                return .launch(
                    try TargetedLaunchPreview(
                        try await client.targetedRunLaunch(
                            .init(
                                purpose: enrichment ? .productEnrichment : .purchaseValidation,
                                targetId: targetID))))
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
        _ plan: HeroActionPlan, on entity: EntityKey, row: EntityRow, itemID: String? = nil,
        values: [String: JSONValue], confirmed: Bool
    ) async throws -> HeroActionOutcome {
        if plan.confirmation == .destructive, !confirmed { throw HeroActionError.confirmationRequired }
        let descriptor = EntityCatalog[entity]
        switch plan.kind {
        case .delete:
            try await client.delete(descriptor, id: row.id)
            return .completed("\(descriptor.singular) deleted", changed: [entity])
        case .operation(let operation):
            let resolved = try Self.resolvedValues(operation.fields, values: values)
            let body = Self.fill(operation.body, rowID: row.id, itemID: itemID, values: resolved)
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
            case "ai.describeLocation":
                let result = try await client.describeLocation(try body.decoded())
                return .review(
                    HeroActionReview(
                        label: "Analyzed contents", previous: result.previousDescription,
                        proposed: result.description, confidence: result.confidence.rawValue,
                        reasoning: "Read from this location's photos.", model: result.cache.model,
                        analyzedAt: result.analyzedAt, cacheStatus: result.cache.status.rawValue,
                        changed: [entity]))
            case "image.attachExisting":
                return try await attachExistingImage(body, changed: entity)
            case "imageProcessing.status":
                guard let itemID, let continuation = operation.continueWith else {
                    throw HeroActionError.missing("id")
                }
                return try await reviewDetectedValue(
                    row: row, entity: entity, imageID: itemID, continuation: continuation)
            case "run.startTargeted":
                return try await startTargetedRun(body)
            default: throw HeroActionError.unsupported(operation.operation)
            }
        case .create(let target, let seed, let editor):
            var prefill: [String: JSONValue] = [:]
            for (key, value) in seed {
                let filled = Self.fill(value, rowID: row.id, values: values)
                // An explicit null stays: it overrides a default the editor would otherwise seed.
                prefill[key] = filled
            }
            return .editor(entity: target, prefill: prefill, context: editor)
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

    // MARK: - Collection actions

    /// Attaches an existing image to a record. A purpose (item photo or label) only applies to a
    /// Product, and the server rejects it on any other record, so it is dropped for the rest.
    private func attachExistingImage(_ body: JSONValue, changed: EntityKey) async throws -> HeroActionOutcome
    {
        var fields = body.objectValue ?? [:]
        let target = fields["targetId"]?.stringValue?.trimmingCharacters(in: .whitespaces).uppercased()
        guard let target, !target.isEmpty else { throw HeroActionError.missing("targetId") }
        fields["targetId"] = .string(target)
        if EntityCatalog.descriptor(forShortcode: target)?.key != .product { fields["purpose"] = .null }
        let result = try await client.attachExistingImage(try JSONValue.object(fields).decoded())
        let reused = try JSONValue(encoding: result)["reused"]?.boolValue == true
        var touched: Set<EntityKey> = [changed]
        if let key = EntityCatalog.descriptor(forShortcode: target)?.key { touched.insert(key) }
        return .completed(reused ? "Image was already attached" : "Image attached", changed: touched)
    }

    /// Reads the image's preferred analysis and stages the detected value on the record's editor.
    /// Nothing is written until the person saves the reviewed values.
    private func reviewDetectedValue(
        row: EntityRow, entity: EntityKey, imageID: String, continuation: HeroOperationPlan.Continuation
    ) async throws -> HeroActionOutcome {
        guard case .editRecord(let field) = continuation else {
            throw HeroActionError.unsupported("continuation")
        }
        let status = try JSONValue(
            encoding: try await client.imageProcessingStatus(.init(id: .init(imageID))))
        let detected = try Self.detectedValue(in: status, imageID: imageID, saved: row.raw[field])
        return .editRecord(entity: entity, id: row.id, staged: [field: detected])
    }

    /// The nutrition facts of an image's preferred analysis, stamped with the evidence they came
    /// from (`Package label <id> · analysis <time>`), as a value to stage on the record. Refuses
    /// when the image has none yet, or when the record already carries this very analysis (the
    /// same rule web uses to hide its review button).
    static func detectedValue(in status: JSONValue, imageID: String, saved: JSONValue?) throws -> JSONValue {
        guard
            let analysis = status["analyses"]?.arrayValue?.first(where: { $0["preferred"]?.boolValue == true }
            ),
            var facts = analysis["result"]?["nutritionFacts"]?.objectValue
        else { throw HeroActionError.unavailable("No nutrition has been detected on this label yet.") }
        let source = "Package label \(imageID) · analysis \(analysis["createdAt"]?.stringValue ?? "")"
        if saved?["source"]?.stringValue == source {
            throw HeroActionError.unavailable("This label's detected nutrition is already saved.")
        }
        facts["source"] = .string(source)
        return .object(facts)
    }

    private func startTargetedRun(_ body: JSONValue) async throws -> HeroActionOutcome {
        let result = try JSONValue(encoding: try await client.startTargetedRun(try body.decoded()))
        let runs = result["runs"]?.arrayValue ?? []
        if let blocking = runs.compactMap({ $0["blockingRun"] }).first(where: { $0 != .null }) {
            let id = blocking["id"]?.stringValue ?? "another run"
            throw HeroActionError.unavailable(
                "\(id) (\(blocking["status"]?.stringValue ?? "running")) is already using this account.")
        }
        return .completed("Validation started", changed: [.run, .purchase])
    }
}
