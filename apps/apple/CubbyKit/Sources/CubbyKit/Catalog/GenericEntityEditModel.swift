import Foundation
import Observation

/// Drives the generic create/update editor for one `EntityDescriptor`. The draft is keyed by
/// `FieldDescriptor.key`; `save()` sends only what changed (an `EntityPatch` on update, the
/// non-null draft on create) plus the image keys when the image block changed, and maps a
/// validation rejection back onto the fields it names. The draft survives every failed save.
@MainActor
@Observable
public final class GenericEntityEditModel {
    public enum Mode: Sendable, Hashable {
        case create(prefill: [String: JSONValue])
        case update(id: String)
    }

    public let descriptor: EntityDescriptor
    public let mode: Mode
    public var draft: [String: JSONValue]
    /// The record as loaded, for update; the diff base and the read-only rules' subject.
    public private(set) var original: JSONValue?
    /// Per-field messages from `validationIssues[].path[0]`, or a cleared non-nullable key.
    public private(set) var fieldErrors: [String: String] = [:]
    /// A rejection that names no field, or a transport failure.
    public private(set) var bannerError: String?
    public private(set) var isSaving = false
    public private(set) var isLoading = false
    /// The saved record's id: the created id, or the updated record's own.
    public private(set) var savedID: String?

    /// Uploaded-but-unattached image ids, attached by the save (`pendingImageIds`).
    public var pendingUploads: [ImageCode] = []
    /// Existing images the user removed (`removeImageIds`).
    public var removedImages: Set<ImageCode> = []
    /// The surviving existing images in the user's order (`imageOrder`, sent only when reordered).
    public var imageOrder: [ImageCode] = []
    public private(set) var originalImageOrder: [ImageCode] = []

    private let client: CubbyClient
    /// Create-mode keys to leave unseeded even when `FieldDescriptor.initial` names a default —
    /// a caller that supplies its own binding for a key (e.g. a photo's capture date) needs the
    /// field to come up empty when that binding has no value, not silently fall back to the
    /// field's generic default. Keyed by the caller, never by field or entity name.
    private let suppressDefaultKeys: Set<String>

    public init(
        descriptor: EntityDescriptor, mode: Mode, client: CubbyClient, original: JSONValue? = nil,
        suppressDefaultKeys: Set<String> = []
    ) {
        self.descriptor = descriptor
        self.mode = mode
        self.client = client
        self.suppressDefaultKeys = suppressDefaultKeys
        self.draft = [:]
        switch mode {
        case .create(let prefill):
            seedCreateDraft(prefill: prefill)
        case .update:
            if let original { seed(original: original) }
        }
    }

    public var isCreate: Bool {
        if case .create = mode { return true }
        return false
    }

    public var recordID: String? {
        if case .update(let id) = mode { return id }
        return nil
    }

    /// Fetches the record for an update editor constructed without `original`.
    public func load() async {
        guard case .update(let id) = mode, original == nil, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let row = try await client.row(descriptor, id: id) else {
                bannerError = "No \(descriptor.singular) called \(id)"
                return
            }
            seed(original: row.raw)
        } catch {
            bannerError = GenericEntityListModel.describe(error)
        }
    }

    // MARK: - Fields and sections

    /// The fields the editor shows: in the mode's payload roster and with a control.
    public var visibleFields: [FieldDescriptor] {
        descriptor.fields.filter { field in
            field.controlKind != nil && (isCreate ? field.inCreate : field.inUpdate)
        }
    }

    /// Declared editor sections, or the visible fields grouped by `controlSection` in order of
    /// first appearance. A declared section lists only its fields that are visible in this mode.
    public var sections: [EditSection] {
        let visible = visibleFields
        if let declared = descriptor.presentation.editSections {
            let visibleKeys = Set(visible.map(\.key))
            return declared.compactMap { section in
                let fields = section.fields.filter { visibleKeys.contains($0) }
                return fields.isEmpty
                    ? nil : EditSection(id: section.id, title: section.title, fields: fields)
            }
        }
        var order: [String] = []
        var grouped: [String: [String]] = [:]
        for field in visible {
            let section = field.controlSection ?? "main"
            if grouped[section] == nil { order.append(section) }
            grouped[section, default: []].append(field.key)
        }
        return order.map { EditSection(id: $0, title: Self.sectionTitle($0), fields: grouped[$0] ?? []) }
    }

    /// Whether `key` is locked in this mode: `readOnlyOnUpdate`, or a `readOnlyWhen` rule whose
    /// `field` on the original equals its `equals`. A locked key never enters the body.
    public func readOnly(_ key: String) -> Bool {
        guard case .update = mode else { return false }
        let presentation = descriptor.presentation
        if presentation.readOnlyOnUpdate.contains(key) { return true }
        return presentation.readOnlyWhen.contains { rule in
            guard rule.fields.contains(key), let value = original?[rule.field] else { return false }
            switch rule.equals {
            case .string(let expected): return value.stringValue == expected
            case .bool(let expected): return value.boolValue == expected
            }
        }
    }

    /// A create field the server rejects absent (`requiredOnCreate`); update never requires.
    public func isRequired(_ field: FieldDescriptor) -> Bool {
        isCreate && field.requiredOnCreate
    }

    public var nullableKeys: Set<String> {
        Set(descriptor.fields.filter(\.nullable).map(\.key))
    }

    // MARK: - Body

    public var hasImageChanges: Bool {
        !pendingUploads.isEmpty || !removedImages.isEmpty || imageOrderChanged
    }

    private var imageOrderChanged: Bool {
        imageOrder != originalImageOrder.filter { !removedImages.contains($0) }
    }

    /// The update patch for the current draft; locked keys and unchanged values are left out.
    public func patch() throws -> EntityPatch {
        let editable = draft.filter { !readOnly($0.key) }
        var patch = try EntityPatch.diff(original: original, draft: editable, nullableKeys: nullableKeys)
        if imageField("pendingImageIds"), !pendingUploads.isEmpty {
            patch.values["pendingImageIds"] = Self.codes(pendingUploads)
        }
        if imageField("removeImageIds"), !removedImages.isEmpty {
            patch.values["removeImageIds"] = Self.codes(
                originalImageOrder.filter { removedImages.contains($0) })
        }
        if imageField("imageOrder"), imageOrderChanged {
            patch.values["imageOrder"] = Self.codes(imageOrder)
        }
        return patch
    }

    /// The create body: every non-null draft value, plus the pending uploads.
    public func createBody() -> [String: JSONValue] {
        var body = draft.filter { $0.value != .null }
        if imageField("pendingImageIds"), !pendingUploads.isEmpty {
            body["pendingImageIds"] = Self.codes(pendingUploads)
        }
        return body
    }

    public var missingRequiredKeys: [String] {
        guard isCreate else { return [] }
        return visibleFields.filter { isRequired($0) && (draft[$0.key] ?? .null) == .null }.map(\.key)
    }

    public var canSave: Bool {
        guard !isSaving, !isLoading else { return false }
        switch mode {
        case .create:
            return missingRequiredKeys.isEmpty
        case .update:
            guard original != nil else { return false }
            return hasImageChanges || ((try? patch())?.isEmpty == false)
        }
    }

    // MARK: - Save

    /// Sends the draft. On success `savedID` is set and `true` returned; on a rejection the
    /// errors are set, the draft is kept, and `false` returned.
    @discardableResult
    public func save() async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        fieldErrors = [:]
        bannerError = nil
        defer { isSaving = false }
        do {
            switch mode {
            case .create:
                savedID = try await client.create(descriptor, body: createBody())
            case .update(let id):
                try await client.update(descriptor, id: id, patch: try patch())
                savedID = id
            }
            return true
        } catch let error as EntityPatch.DiffError {
            if case .clearedNonNullableKey(let key) = error {
                fieldErrors[key] = "Required"
            }
            return false
        } catch {
            apply(error)
            return false
        }
    }

    private func apply(_ error: any Error) {
        if let apiError = error as? CubbyAPIError, let issues = apiError.detail?.validationIssues,
            !issues.isEmpty
        {
            var named: [String: String] = [:]
            for issue in issues {
                guard let key = issue.path.first else { continue }
                named[key] = named[key].map { "\($0); \(issue.message)" } ?? issue.message
            }
            fieldErrors = named
            if named.isEmpty { bannerError = GenericEntityListModel.describe(error) }
            return
        }
        bannerError = GenericEntityListModel.describe(error)
    }

    // MARK: - Seeding

    private func seed(original: JSONValue) {
        self.original = original
        var seeded: [String: JSONValue] = [:]
        for field in visibleFields {
            seeded[field.key] = original[field.key] ?? .null
        }
        draft = seeded
        let existing =
            original["attachments"]?.arrayValue?.compactMap {
                $0["id"]?.stringValue.map { ImageCode($0) }
            } ?? []
        originalImageOrder = existing
        imageOrder = existing
        removedImages = []
    }

    private func seedCreateDraft(prefill: [String: JSONValue]) {
        var seeded: [String: JSONValue] = [:]
        for field in visibleFields {
            if let value = prefill[field.key] {
                seeded[field.key] = value
            } else if field.initial == "today", field.kind == .date,
                !suppressDefaultKeys.contains(field.key)
            {
                seeded[field.key] = .string(PlainDate(.now).rawValue)
            } else {
                seeded[field.key] = .null
            }
        }
        // A prefilled key outside the visible roster still travels (a relation section's
        // reference is a create-only key the control may not render).
        for (key, value) in prefill where seeded[key] == nil {
            seeded[key] = value
        }
        draft = seeded
    }

    private func imageField(_ key: String) -> Bool {
        guard let field = descriptor.field(key) else { return false }
        return isCreate ? field.inCreate : field.inUpdate
    }

    private static func codes(_ ids: [ImageCode]) -> JSONValue {
        .array(ids.map { .string($0.rawValue) })
    }

    private static func sectionTitle(_ section: String) -> String {
        section.split(whereSeparator: { $0 == "-" || $0 == "_" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
