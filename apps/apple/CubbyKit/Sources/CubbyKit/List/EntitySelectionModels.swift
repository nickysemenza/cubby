import Foundation
import Observation

/// The native merge sheet's state for a list selection: the server's merge preview, the member's
/// survivor (preselected from `suggestedKeepId`) and a value choice per conflicting field. Native
/// computes no survivor or conflict; it sends the same kernel merge web sends.
@MainActor
@Observable
public final class EntityMergeModel: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }

    public let descriptor: EntityDescriptor
    public let ids: [String]
    public private(set) var preview: EntityMergePreviewOut?
    public private(set) var loadError: String?
    public private(set) var isLoading = false
    public private(set) var isMerging = false
    /// The refused write's raw diagnostic; the selection and choices stay as they were.
    public private(set) var failure: String?
    /// The surviving record. Changing it resets every conflict to the new survivor's own value.
    public var keepID: String? {
        didSet { if keepID != oldValue { choices = [:] } }
    }
    /// The candidate whose value each conflicting field keeps; absent means the survivor's own.
    public var choices: [String: String] = [:]

    private let client: CubbyClient

    public init(descriptor: EntityDescriptor, ids: [String], client: CubbyClient) {
        self.descriptor = descriptor
        self.ids = ids
        self.client = client
    }

    public func load() async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            let preview = try await client.mergePreview(descriptor.key, ids: ids)
            self.preview = preview
            if keepID == nil || !preview.candidates.contains(where: { $0.id == keepID }) {
                keepID = preview.suggestedKeepId
            }
        } catch {
            loadError = error.userMessage
        }
    }

    /// The candidate a conflict currently keeps: the member's choice, else the survivor.
    public func chosen(_ conflict: EntityMergeConflict) -> String? {
        choices[conflict.field] ?? keepID
    }

    /// Values from other candidates that the survivor takes before the merge; empty when every
    /// conflict keeps the survivor's own value.
    public var survivorPatch: [String: JSONValue] {
        guard let preview, let keepID else { return [:] }
        var patch: [String: JSONValue] = [:]
        for conflict in preview.conflicts {
            guard let chosen = choices[conflict.field], chosen != keepID,
                let value = conflict.values.first(where: { $0.id == chosen })?.value
            else { continue }
            patch[conflict.field] = value
        }
        return patch
    }

    /// Updates the survivor with the kept values, then merges the others into it. A refused
    /// update stops before the merge, so nothing irreversible runs on a partial plan.
    @discardableResult
    public func merge() async -> Bool {
        guard let keepID, !isMerging else { return false }
        isMerging = true
        failure = nil
        defer { isMerging = false }
        do {
            let patch = survivorPatch
            if !patch.isEmpty {
                try await client.update(descriptor, id: keepID, patch: EntityPatch(values: patch))
            }
            try await client.merge(descriptor, keepID: keepID, mergeIDs: ids.filter { $0 != keepID })
            return true
        } catch {
            failure = error.userMessage
            return false
        }
    }
}

/// The native bulk edit sheet, mirroring web's: choose one field from the entity's atomic bulk
/// update roster, then set it (with the record editor's own control) or clear it. One kernel
/// `bulkUpdate` carries it; the server rolls the whole batch back on a refusal.
@MainActor
@Observable
public final class EntityBulkEditModel: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }

    public enum Mode: Sendable, Hashable { case set, clear }

    public let descriptor: EntityDescriptor
    public let ids: [String]
    /// Scalar fields the bulk update accepts that have an ordinary editor control. Collections,
    /// structured values and resolution companions stay with their owners, as on web.
    public let fields: [FieldDescriptor]
    /// The editor-control draft for the chosen field; it never saves itself.
    public let draft: GenericEntityEditModel
    public var fieldKey: String? {
        didSet {
            guard fieldKey != oldValue else { return }
            mode = .set
            validation = nil
            for key in draft.draft.keys { draft.draft[key] = nil }
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
                && !companions.contains(field.key) && field.collection == nil
                && field.reference?.multiple != true && field.kind != .textArray
                && field.valueSchema == nil
        }
        draft = GenericEntityEditModel(
            descriptor: descriptor, mode: .create(prefill: [:]), client: client,
            suppressDefaultKeys: Set(descriptor.fields.map(\.key)))
    }

    public var field: FieldDescriptor? { fieldKey.flatMap { key in fields.first { $0.key == key } } }

    /// Whether the chosen field can be cleared: nullable, as web's Clear assignment.
    public var canClear: Bool { field?.nullable ?? false }

    /// The bulk update body, or nil while the chosen field has nothing to send. Clearing sends
    /// the field's declared resolution "none" patch when it has one, else an explicit null; a set
    /// value carries the companions its control staged.
    public var body: [String: JSONValue]? {
        guard let field else { return nil }
        switch mode {
        case .clear:
            return field.resolution?.none ?? [field.key: .null]
        case .set:
            let companions =
                field.resolution.map { Array($0.reset.keys) + Array(($0.none ?? [:]).keys) } ?? []
            var body: [String: JSONValue] = [:]
            for key in [field.key] + companions {
                if let value = draft.draft[key], value != .null { body[key] = value }
            }
            return body[field.key] == nil && body.isEmpty ? nil : body
        }
    }

    /// Sends the one atomic bulk update; returns the updated count, or nil after a refusal.
    public func save() async -> Int? {
        guard !isSaving else { return nil }
        guard let body else {
            validation = field.map { "Enter a value for \($0.label)." } ?? "Choose a field to change."
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
