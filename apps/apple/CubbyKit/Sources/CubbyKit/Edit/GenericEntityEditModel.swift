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
    /// Per-field messages from the server's validation paths, or a cleared non-nullable key.
    public private(set) var fieldErrors: [String: String] = [:]
    /// Messages for a position inside a structured field's value: `validationIssues[].path` past
    /// the key, for the issues the structured editor has a place to draw (`StructuredValue.draws`).
    public private(set) var nestedErrors: [String: [[String]: String]] = [:]
    /// A rejection that names no field, or a transport failure.
    public private(set) var bannerError: String?
    /// The update read's failure, kept apart from `bannerError` (a refused write). A supplied
    /// detail projection still seeds the form, but it is never an edit baseline, so a failed
    /// read blocks saving until a retried read succeeds.
    public private(set) var loadError: String?
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
    private var initialDraft: [String: JSONValue] = [:]
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
        initialDraft = draft
    }

    public var isCreate: Bool {
        if case .create = mode { return true }
        return false
    }

    public var recordID: String? {
        if case .update(let id) = mode { return id }
        return nil
    }

    /// Seeded defaults and prefills are clean; staged edits and image changes need review
    /// before dismissal, even when validation prevents saving them.
    public var isDirty: Bool {
        draft != initialDraft || hasImageChanges
    }

    /// Fetches the current update record. A supplied detail projection may predate a save's
    /// asynchronous refresh, so it is only an initial presentation, never the edit baseline.
    public func load() async {
        guard case .update(let id) = mode, !isLoading else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            guard let row = try await client.row(descriptor, id: id) else {
                loadError = "No \(descriptor.singular) called \(id)"
                return
            }
            seed(original: row.raw)
        } catch {
            loadError = error.userMessage
        }
    }

    // MARK: - Fields and sections

    /// Draft classifier changes immediately update editor and suggestion eligibility. A drafted
    /// key's saved envelope no longer describes it, so the draft value reads in its place.
    public var applicabilityRecord: JSONValue {
        var values: [String: JSONValue] = [:]
        if case .object(let saved) = original { values = saved }
        values.merge(draft) { _, draftValue in draftValue }
        if var envelopes = values["fields"]?.objectValue {
            for key in draft.keys { envelopes.removeValue(forKey: key) }
            values["fields"] = .object(envelopes)
        }
        return .object(values)
    }

    /// The fields the editor shows: in the mode's payload roster and with a control.
    public var visibleFields: [FieldDescriptor] {
        editableFields(in: applicabilityRecord)
    }

    private func editableFields(in record: JSONValue) -> [FieldDescriptor] {
        let fields = descriptor.fields.filter { field in
            field.controlKind != nil && (isCreate ? field.inCreate : field.inUpdate)
                && field.applicabilityRefusal(in: record) == nil
        }
        let hasCollectionControl = fields.contains { $0.collection?.primary != nil }
        return fields.filter {
            isCreate || !hasCollectionControl || $0.controlRenderer?.rawValue != "upc-lookup"
        }
    }

    /// The compiled editor sections (every controlled field placed once; `main` untitled), each
    /// listing only its fields that are visible in this mode.
    public var sections: [EditSection] {
        let visibleKeys = Set(visibleFields.map(\.key))
        return descriptor.presentation.editSections.compactMap { section in
            let fields = section.fields.filter { visibleKeys.contains($0) }
            return fields.isEmpty
                ? nil
                : EditSection(
                    id: section.id, title: section.title, fields: fields,
                    collapsed: section.collapsed)
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
    /// The saved envelope's controls predate that write, so they are dropped rather than reused
    /// as action authority until the record is read again.
    public func acknowledgeSavedField(
        _ key: String, value: JSONValue, reviewedDraftValue: JSONValue
    ) {
        guard case .update = mode, var saved = original?.objectValue else { return }
        saved[key] = value
        if var envelopes = saved["fields"]?.objectValue {
            envelopes.removeValue(forKey: key)
            if let readKey = descriptor.field(key)?.readKey { envelopes.removeValue(forKey: readKey) }
            saved["fields"] = .object(envelopes)
        }
        original = .object(saved)
        initialDraft[key] = value
        if (draft[key] ?? .null) == reviewedDraftValue { draft[key] = value }
    }

    /// The saved envelope while it still describes the draft. Resolver dependencies are not a
    /// complete editable-key roster, so any changed draft invalidates its result and controls.
    public func resolutionForEditor(_ field: FieldDescriptor) -> FieldEnvelope? {
        guard let original,
            draft.allSatisfy({ key, value in value == (original[key] ?? .null) })
        else { return nil }
        return FieldEnvelope.of(original, field: field)
    }

    /// Stage the declaration's ordinary update patch; Save owns persistence.
    @discardableResult
    public func stageResolutionReset(_ key: String) -> Bool {
        stageResolution(.useInherited, for: key)
    }

    /// Stage one action the saved envelope's current controls offer (Use inherited, Keep this
    /// value, Set to …). An edited draft or a missing envelope offers none.
    @discardableResult
    public func stageResolution(_ kind: FieldAssignmentAction.Kind, for key: String) -> Bool {
        guard let field = descriptor.field(key),
            let action = resolutionForEditor(field)?.actions(field: field).first(where: { $0.kind == kind })
        else { return false }
        return stageResolutionPayload(action.payload)
    }

    @discardableResult
    public func stageResolutionNone(_ key: String) -> Bool {
        guard let payload = descriptor.field(key)?.resolution?.none else { return false }
        return stageResolutionPayload(payload)
    }

    /// A manual reference choice replaces any staged reset with the declaration's explicit intent.
    @discardableResult
    public func stageReferenceSelection(_ key: String, value: JSONValue) -> Bool {
        guard let field = descriptor.field(key), field.reference != nil else { return false }
        var payload = field.resolution?.none ?? [:]
        payload[key] = value
        return stage(payload)
    }

    private func stageResolutionPayload(_ payload: [String: JSONValue]) -> Bool {
        stage(payload)
    }

    /// Stages values a detail action derived (a detected nutrition panel, a resolution reset) as
    /// the person's own edits, for review; Save owns persistence. Refuses a key the editor cannot
    /// write, so a stale plan never stages a value the server would reject.
    @discardableResult
    public func stage(_ values: [String: JSONValue]) -> Bool {
        guard !isSaving, !isLoading, !values.isEmpty,
            values.keys.allSatisfy({ key in
                guard let field = descriptor.field(key) else { return false }
                return (isCreate ? field.inCreate : field.inUpdate)
            })
        else { return false }
        for (key, value) in values {
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

    /// The update patch for the current draft; unchanged values are left out.
    public func patch() throws -> EntityPatch {
        var patch = try EntityPatch.diff(original: original, draft: wireDraft(), nullableKeys: nullableKeys)
        for field in visibleFields where field.collection?.primary != nil {
            guard let collection = field.collection else { continue }
            guard let state = CollectionEdit.decode(draft[field.key]) else {
                // A partial/failed read cannot stand in for an empty saved collection.
                if draft[field.key] != original?[field.key] && draft[field.key] != .null {
                    throw CollectionEdit.EditError.missingBaseline
                }
                patch.values.removeValue(forKey: field.key)
                continue
            }
            let value = try collectionWire(state, field: field, collection: collection)
            patch.values.removeValue(forKey: field.key)
            if value.arrayValue?.isEmpty == false { patch.values[field.key] = value }
        }
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
            if descriptor.field(entry.key)?.applicabilityRefusal(in: applicabilityRecord) != nil { return }
            if let state = CollectionEdit.decode(entry.value), let field = descriptor.field(entry.key),
                let collection = field.collection
            {
                if isCreate {
                    wire[entry.key] = state.initialValue(collection: collection) {
                        try self.collectionRow($0, field: field)
                    }
                } else if let original = original?[entry.key] {
                    wire[entry.key] = original
                }
            } else if let schema = descriptor.field(entry.key)?.valueSchema {
                wire[entry.key] = StructuredValue.wireValue(entry.value, schema: schema)
            } else {
                wire[entry.key] = entry.value
            }
        }
    }

    private func collectionRow(_ row: [String: JSONValue], field: FieldDescriptor) throws -> [String:
        JSONValue]
    {
        guard let schema = field.valueSchema, case .array(let item) = schema.node else { return row }
        let projected =
            StructuredValue.wireValue(StructuredValue.project(.object(row), to: item), schema: item)
            .objectValue ?? row
        return field.controlRenderer?.rawValue == "external-ids"
            ? try IdentifierPresentation.storedRow(projected) : projected
    }

    private func collectionWire(_ state: CollectionEdit, field: FieldDescriptor, collection: FieldCollection)
        throws -> JSONValue
    {
        guard let schema = field.valueSchema, case .array(let item) = schema.node,
            case .object(let fields) = item.node
        else {
            throw CollectionEdit.EditError.missingBaseline
        }
        let attributes = fields.map(\.key).filter { $0 != "id" && !collection.key.contains($0) }
        return try state.wireValue(collection: collection, attributes: attributes) {
            try self.collectionRow($0, field: field)
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

    public var dateRangeErrors: [String: String] {
        var errors: [String: String] = [:]
        // Retained stored bounds may need correction, but an unrelated patch
        // must not be blocked by a value it does not write.
        let supplied = isCreate ? draft : ((try? patch().values) ?? [:])
        for field in visibleFields where field.kind == .dateRange {
            guard let value = supplied[field.key], value != .null else { continue }
            let start = value["start"]?.stringValue
            let end = value["end"]?.stringValue
            if start == nil && end == nil {
                errors[field.key] = "Choose at least one date or clear the range"
            } else if [start, end].compactMap({ $0 }).contains(where: {
                $0.count != 10 || DatePresentation.plainDate($0) == nil
            }) {
                errors[field.key] = "Enter a valid calendar date"
            } else if let start, let end, start > end {
                errors[field.key] = "Start must be on or before end"
            }
        }
        return errors
    }

    public var canSave: Bool {
        guard !isSaving, !isLoading, dateRangeErrors.isEmpty else { return false }
        switch mode {
        case .create:
            return missingRequiredKeys.isEmpty
        case .update:
            guard original != nil, loadError == nil else { return false }
            if hasImageChanges { return true }
            do {
                return try !patch().isEmpty
            } catch {
                return true
            }
        }
    }

    // MARK: - Save

    /// Sends the draft. On success `savedID` is set and `true` returned; on a rejection the
    /// errors are set, the draft is kept, and `false` returned.
    @discardableResult
    public func save() async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        fieldErrors = dateRangeErrors
        guard fieldErrors.isEmpty else {
            isSaving = false
            return false
        }
        nestedErrors = [:]
        bannerError = nil
        defer { isSaving = false }
        do {
            switch mode {
            case .create:
                for field in visibleFields {
                    if let collection = field.collection, let state = CollectionEdit.decode(draft[field.key])
                    {
                        _ = try collectionWire(state, field: field, collection: collection)
                    }
                }
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
            var unplaced: [String] = []
            let visibleKeys = Set(visibleFields.map(\.key))
            for issue in issues {
                // Kernel command validation includes the mutation's `data` envelope; domain
                // validation starts at the field. Do not guess a key from deeper positions.
                let path = issue.path.first == "data" ? Array(issue.path.dropFirst()) : issue.path
                guard let key = path.first, visibleKeys.contains(key) else {
                    let prefix = issue.path.isEmpty ? "" : "\(issue.path.joined(separator: ".")): "
                    unplaced.append("\(prefix)\(issue.message)")
                    continue
                }
                // A structured field's issue lands where the editor draws that position; one it
                // cannot place (a whole-value rule, a hidden key) stays on the field.
                let inner = Array(path.dropFirst())
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
            if apiError.detail?.diagnostics != nil {
                bannerError = error.userMessage
            } else if !unplaced.isEmpty {
                bannerError = unplaced.joined(separator: "\n")
            }
            return
        }
        bannerError = error.userMessage
    }

    // MARK: - Seeding

    private func seed(original: JSONValue) {
        var stored = original.objectValue ?? [:]
        // Seed governed fields from the stored intent S, never the inherited or cached effective
        // value V. Declared companions (`…Mode`) follow the intent unless the row carries them.
        // Retain every stored intent in the diff baseline even when current applicability hides
        // its editor. A staged reset must differ from that intent, not from an absent read slot.
        for field in descriptor.fields {
            if let envelope = FieldEnvelope.of(original, field: field) {
                let seeded = envelope.storedDraft(field: field)
                stored[field.key] = seeded?.value ?? .null
                for (key, value) in seeded?.companions ?? [:] where stored[key] == nil {
                    stored[key] = value
                }
            }
        }
        for field in editableFields(in: original) {
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
        for field in editableFields(in: original) {
            if let value = original[field.key] {
                seeded[field.key] =
                    field.collection?.primary != nil && value.arrayValue != nil
                    ? CollectionEdit(value: value, creating: false).json : value
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
        initialDraft = seeded
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
        for field in visibleFields where field.collection?.primary != nil {
            seeded[field.key] = CollectionEdit(value: seeded[field.key] ?? .array([]), creating: true).json
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
}
