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
    /// Messages for a position inside a structured field's value: `validationIssues[].path` past
    /// the key, for the issues the structured editor has a place to draw (`StructuredValue.draws`).
    public private(set) var nestedErrors: [String: [[String]: String]] = [:]
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

    /// Fetches the current update record. A supplied detail projection may predate a save's
    /// asynchronous refresh, so it is only an initial presentation, never the edit baseline.
    public func load() async {
        guard case .update(let id) = mode, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let row = try await client.row(descriptor, id: id) else {
                bannerError = "No \(descriptor.singular) called \(id)"
                return
            }
            seed(original: row.raw)
        } catch {
            bannerError = error.userMessage
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
                    ? nil
                    : EditSection(
                        id: section.id, title: section.title, fields: fields,
                        collapsed: section.collapsed)
            }
        }
        var order: [String] = []
        var grouped: [String: [String]] = [:]
        for field in visible {
            let section = field.controlSection ?? "main"
            if grouped[section] == nil { order.append(section) }
            grouped[section, default: []].append(field.key)
        }
        return order.map {
            EditSection(id: $0, title: Self.sectionTitle($0), fields: grouped[$0] ?? [], collapsed: false)
        }
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

    /// Keys a person has changed through a control, as opposed to a seed/prefill. A caller-owned
    /// hint tied to a key's origin (e.g. the photo import editor's capture-date provenance
    /// caption, A2) reads this to know when to stop showing itself. Controls that write `draft`
    /// directly call `markEdited`; today only the date control does (the only kind a capture-date
    /// binding ever targets).
    public private(set) var editedKeys: Set<String> = []

    public func markEdited(_ key: String) {
        editedKeys.insert(key)
    }

    public func isEdited(_ key: String) -> Bool {
        editedKeys.contains(key)
    }

    /// A reviewed command saved one field independently of the editor's remaining draft.
    /// Advance only its diff base; a newer local choice must remain dirty against that base.
    public func acknowledgeSavedField(
        _ key: String, value: JSONValue, reviewedDraftValue: JSONValue
    ) {
        guard case .update = mode, var saved = original?.objectValue else { return }
        saved[key] = value
        if var resolutions = saved["fieldResolutions"]?.objectValue {
            resolutions.removeValue(forKey: key)
            saved["fieldResolutions"] = .object(resolutions)
        }
        original = .object(saved)
        if (draft[key] ?? .null) == reviewedDraftValue { draft[key] = value }
    }

    /// The server projection describes the saved record. Resolver dependencies are not a
    /// complete editable-key roster, so any changed draft invalidates this provenance.
    public func resolutionForEditor(_ field: FieldDescriptor) -> FieldResolutionPresentation? {
        guard let original,
            draft.allSatisfy({ key, value in value == (original[key] ?? .null) })
        else { return nil }
        return FieldResolutionPresentation(raw: original, field: field)
    }

    /// Stage the declaration's ordinary update patch; Save owns persistence.
    @discardableResult
    public func stageResolutionReset(_ key: String) -> Bool {
        guard let field = descriptor.field(key),
            let resolved = resolutionForEditor(field),
            let payload = resolved.resetPayload(field: field)
        else { return false }
        return stageResolutionPayload(payload)
    }

    @discardableResult
    public func stageResolutionNone(_ key: String) -> Bool {
        guard let payload = descriptor.field(key)?.resolution?.none else { return false }
        return stageResolutionPayload(payload)
    }

    private func stageResolutionPayload(_ payload: [String: JSONValue]) -> Bool {
        guard !isSaving, !isLoading, !payload.isEmpty,
            payload.keys.allSatisfy({ key in
                guard let field = descriptor.field(key) else { return false }
                return (isCreate ? field.inCreate : field.inUpdate) && !readOnly(key)
            })
        else { return false }
        for (key, value) in payload {
            draft[key] = value
            markEdited(key)
        }
        return true
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
        let editable = wireDraft().filter { !readOnly($0.key) }
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
        var body = wireDraft().filter { $0.value != .null }
        if imageField("pendingImageIds"), !pendingUploads.isEmpty {
            body["pendingImageIds"] = Self.codes(pendingUploads)
        }
        return body
    }

    /// The draft as sent: a structured field's value is shaped by its `ValueSchema` (unfilled
    /// optional text left out), every other field as drafted.
    private func wireDraft() -> [String: JSONValue] {
        draft.reduce(into: [:]) { wire, entry in
            if let schema = descriptor.field(entry.key)?.valueSchema {
                wire[entry.key] = StructuredValue.wireValue(entry.value, schema: schema)
            } else {
                wire[entry.key] = entry.value
            }
        }
    }

    /// The server's message for a position inside a structured field's value, or nil.
    public func nestedError(_ key: String, path: [String]) -> String? {
        nestedErrors[key]?[path]
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
        nestedErrors = [:]
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
            var nested: [String: [[String]: String]] = [:]
            for issue in issues {
                guard let key = issue.path.first else { continue }
                // A structured field's issue lands where the editor draws that position; one it
                // cannot place (a whole-value rule, a hidden key) stays on the field.
                let inner = Array(issue.path.dropFirst())
                if let schema = descriptor.field(key)?.valueSchema,
                    StructuredValue.draws(path: inner, in: draft[key], schema: schema)
                {
                    nested[key, default: [:]][inner] =
                        nested[key]?[inner].map { "\($0); \(issue.message)" } ?? issue.message
                    continue
                }
                named[key] = named[key].map { "\($0); \(issue.message)" } ?? issue.message
            }
            fieldErrors = named
            nestedErrors = nested
            if named.isEmpty && nested.isEmpty { bannerError = error.userMessage }
            return
        }
        bannerError = error.userMessage
    }

    // MARK: - Seeding

    private func seed(original: JSONValue) {
        var stored = original.objectValue ?? [:]
        for field in visibleFields {
            if let resolution = FieldResolutionPresentation(raw: original, field: field) {
                stored[field.key] = resolution.storedValue
            }
            // A read payload carries keys the input schema rejects and stored quirks (`""`, a
            // `null` the input omits). The diff base is exactly what the editor would send back
            // untouched, so an unedited structured field stays out of the patch.
            if let schema = field.valueSchema, let value = stored[field.key] {
                stored[field.key] = StructuredValue.wireValue(
                    StructuredValue.project(value, to: schema), schema: schema)
            }
        }
        let original = JSONValue.object(stored)
        self.original = original
        var seeded: [String: JSONValue] = [:]
        for field in visibleFields {
            if let value = original[field.key] {
                seeded[field.key] = value
            } else if field.reference?.multiple == true,
                let projected = descriptor.fields.first(where: {
                    $0.key != field.key
                        && $0.reference?.entity == field.reference?.entity
                        && $0.reference?.multiple == true
                        && original[$0.key]?.arrayValue != nil
                }),
                let value = original[projected.key]
            {
                // M:N writes use an id array while detail reads may expose the
                // hydrated relation under a separate, read-only field.
                seeded[field.key] =
                    value.arrayValue.map {
                        .array($0.compactMap { $0["id"]?.stringValue.map(JSONValue.string) })
                    } ?? .null
            } else {
                seeded[field.key] = .null
            }
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
