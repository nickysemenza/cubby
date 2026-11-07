import Foundation
import Observation

/// The native merge sheet's state for a list selection: the server's merge preview, the member's
/// survivor (preselected from `suggestedKeepId`) and a value choice per conflicting field. Native
/// computes no survivor, conflict, connection disposition or blocker; it sends the same kernel
/// merge web sends, with the chosen values riding in the merge's own transaction.
@MainActor
@Observable
public final class EntityMergeModel: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }

    public let descriptor: EntityDescriptor
    public let ids: [String]
    public private(set) var preview: EntityMergePreviewOut?
    public private(set) var loadError: String?
    public var isLoading: Bool { loads > 0 }
    public private(set) var isMerging = false
    /// The refused write's raw diagnostic; the selection and choices stay as they were.
    public private(set) var failure: String?
    /// The surviving record. Changing it resets every conflict to the new survivor's own value;
    /// `refreshPlan()` then reloads the preview so its blockers describe the new survivor.
    public var keepID: String? {
        didSet { if keepID != oldValue { choices = [:] } }
    }
    /// The candidate whose value each conflicting field keeps; absent means the survivor's own.
    public var choices: [String: String] = [:]

    private let client: CubbyClient
    private var loads = 0

    public init(descriptor: EntityDescriptor, ids: [String], client: CubbyClient) {
        self.descriptor = descriptor
        self.ids = ids
        self.client = client
    }

    /// Loads the preview for the current survivor (the server's suggestion before one is chosen).
    /// A response for a survivor the member has since replaced is dropped.
    public func load() async {
        let requested = keepID
        loads += 1
        loadError = nil
        defer { loads -= 1 }
        do {
            let preview = try await client.mergePreview(descriptor.key, ids: ids, keepID: requested)
            guard requested == keepID else { return }
            self.preview = preview
            if keepID == nil { keepID = preview.keepId }
        } catch {
            if requested == keepID { loadError = error.userMessage }
        }
    }

    /// Reloads the preview after the survivor changes; a no-op while it already describes it.
    public func refreshPlan() async {
        guard let keepID, let preview, preview.keepId != keepID else { return }
        await load()
    }

    /// Whether the loaded preview's blockers describe the chosen survivor.
    public var planIsCurrent: Bool { preview != nil && preview?.keepId == keepID }

    /// The server's refusals for merging into the chosen survivor; Merge stays off while any hold.
    public var blockers: [String] { planIsCurrent ? preview?.blockers ?? [] : [] }

    public var canMerge: Bool { planIsCurrent && blockers.isEmpty && !isLoading && !isMerging }

    /// The candidates folded into the survivor, with their connection dispositions.
    public var mergedAway: [EntityMergeCandidate] {
        preview?.candidates.filter { $0.id != keepID } ?? []
    }

    /// The candidate a conflict currently keeps: the member's choice, else the survivor.
    public func chosen(_ conflict: EntityMergeConflict) -> String? {
        choices[conflict.field] ?? keepID
    }

    /// Values from other candidates the survivor takes; empty when every conflict keeps the
    /// survivor's own value.
    public var survivorValues: [String: JSONValue] {
        guard let preview, let keepID else { return [:] }
        var values: [String: JSONValue] = [:]
        for conflict in preview.conflicts {
            guard let chosen = choices[conflict.field], chosen != keepID,
                let value = conflict.values.first(where: { $0.id == chosen })?.value
            else { continue }
            values[conflict.field] = value
        }
        return values
    }

    /// One kernel merge carrying the chosen values; a refusal leaves every record unchanged.
    @discardableResult
    public func merge() async -> Bool {
        guard let keepID, canMerge else { return false }
        isMerging = true
        failure = nil
        defer { isMerging = false }
        do {
            try await client.merge(
                descriptor, keepID: keepID, mergeIDs: ids.filter { $0 != keepID },
                survivorValues: survivorValues)
            return true
        } catch {
            failure = error.userMessage
            return false
        }
    }
}

/// The native bulk edit sheet, mirroring web's: choose one field from the entity's atomic bulk
/// update roster, then set it (with the record editor's own control) or clear it; a text list or
/// multi-reference adds and removes items instead, as web's bulk edit does. One kernel
/// `bulkUpdate` carries it; the server rolls the whole batch back on a refusal. A keyed
/// structured collection, which needs web's item editor, hands off to web rather than vanishing.
@MainActor
@Observable
public final class EntityBulkEditModel: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }

    public enum Mode: Sendable, Hashable { case set, clear }

    /// How the chosen field's change is entered.
    public enum Assignment: Sendable, Hashable {
        /// One value for every record (`set`, or `clear` when nullable).
        case value
        /// Items added to and removed from every record's list (web's add/remove patch).
        case addRemove
        /// A keyed structured collection: edited in web's bulk edit.
        case web
    }

    public let descriptor: EntityDescriptor
    public let ids: [String]
    /// Every field the bulk update accepts that has an editor control. Resolution companions are
    /// written by their owning field's control, as on web.
    public let fields: [FieldDescriptor]
    /// The editor-control draft for the chosen field (its value, or the items to add); it never
    /// saves itself.
    public let draft: GenericEntityEditModel
    /// The items to remove from an add/remove field.
    public let removeDraft: GenericEntityEditModel
    public var fieldKey: String? {
        didSet {
            guard fieldKey != oldValue else { return }
            mode = .set
            validation = nil
            for key in draft.draft.keys { draft.draft[key] = nil }
            for key in removeDraft.draft.keys { removeDraft.draft[key] = nil }
        }
    }
    public var mode: Mode = .set
    public private(set) var isSaving = false
    /// A refused bulk update's raw diagnostic; the selection stays unchanged.
    public private(set) var failure: String?
    /// A local "nothing to send" message for the chosen field.
    public private(set) var validation: String?

    private let client: CubbyClient

    public init(descriptor: EntityDescriptor, ids: [String], client: CubbyClient) {
        self.descriptor = descriptor
        self.ids = ids
        self.client = client
        let accepted = Set(descriptor.key.bulkUpdateFields)
        let companions = Set(
            descriptor.fields.flatMap { field -> [String] in
                guard let resolution = field.resolution else { return [] }
                return (Array(resolution.reset.keys) + Array((resolution.none ?? [:]).keys))
                    .filter { $0 != field.key }
            })
        fields = descriptor.fields.filter { field in
            accepted.contains(field.key) && field.inUpdate && field.controlKind != nil
                && !companions.contains(field.key)
        }
        let suppressed = Set(descriptor.fields.map(\.key))
        draft = GenericEntityEditModel(
            descriptor: descriptor, mode: .create(prefill: [:]), client: client,
            suppressDefaultKeys: suppressed)
        removeDraft = GenericEntityEditModel(
            descriptor: descriptor, mode: .create(prefill: [:]), client: client,
            suppressDefaultKeys: suppressed)
    }

    public var field: FieldDescriptor? { fieldKey.flatMap { key in fields.first { $0.key == key } } }

    public static func assignment(for field: FieldDescriptor) -> Assignment {
        if field.collection != nil { return .web }
        if field.reference?.multiple == true || field.kind == .textArray { return .addRemove }
        return .value
    }

    public var assignment: Assignment? { field.map(Self.assignment(for:)) }

    /// Whether the chosen field can be cleared: a nullable single value, as web's Clear assignment.
    public var canClear: Bool { assignment == .value && field?.nullable == true }

    public var canSave: Bool { !isSaving && assignment != nil && assignment != .web }

    /// The bulk update body, or nil while the chosen field has nothing to send. Clearing sends
    /// the field's declared resolution "none" patch when it has one, else an explicit null; a set
    /// value carries the companions its control staged; add/remove sends web's `{op, key}` items.
    public var body: [String: JSONValue]? {
        guard let field, let assignment else { return nil }
        switch (assignment, mode) {
        case (.web, _):
            return nil
        case (.addRemove, _):
            let items =
                Self.items(removeDraft.draft[field.key]).map { item -> JSONValue in
                    ["op": "remove", "key": item]
                }
                + Self.items(draft.draft[field.key]).map { item -> JSONValue in ["op": "add", "key": item] }
            return items.isEmpty ? nil : [field.key: .array(items)]
        case (.value, .clear):
            return field.resolution?.none ?? [field.key: .null]
        case (.value, .set):
            let companions =
                field.resolution.map { Array($0.reset.keys) + Array(($0.none ?? [:]).keys) } ?? []
            var body: [String: JSONValue] = [:]
            for key in [field.key] + companions {
                guard var value = draft.draft[key], value != .null else { continue }
                if let schema = descriptor.field(key)?.valueSchema {
                    value = StructuredValue.wireValue(value, schema: schema)
                }
                body[key] = value
            }
            return body.isEmpty ? nil : body
        }
    }

    private static func items(_ value: JSONValue?) -> [JSONValue] {
        value?.arrayValue?.filter { $0 != .null && $0 != .string("") } ?? []
    }

    /// Sends the one atomic bulk update; returns the updated count, or nil after a refusal.
    public func save() async -> Int? {
        guard canSave else { return nil }
        guard let body else {
            validation =
                field.map {
                    assignment == .addRemove
                        ? "Enter \($0.label) to add or remove." : "Enter a value for \($0.label)."
                } ?? "Choose a field to change."
            return nil
        }
        isSaving = true
        failure = nil
        validation = nil
        defer { isSaving = false }
        do {
            return try await client.bulkUpdate(descriptor, ids: ids, data: body)
        } catch {
            failure = error.userMessage
            return nil
        }
    }
}
