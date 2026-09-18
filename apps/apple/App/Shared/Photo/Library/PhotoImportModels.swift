import CubbyKit
import Foundation

struct PhotoImportGroup: Identifiable, Equatable {
    let id: String
    let title: String
    let evidence: String?
    let photoIDs: [String]
    /// `nil` for a `createSelf` draft: there is no source record to reroute from.
    let source: EntityKey?
    let sourceRow: EntityRow?
}

enum PhotoDuplicateDecision: Equatable {
    case reuse(ImageCode)
    case keepBoth
}

enum PhotoImportAnalysisState: Equatable {
    case idle
    case running(String)
    case complete
    case failed(String)

    var isRunning: Bool {
        if case .running = self { return true }
        return false
    }
}

struct PhotoSourceTypeSuggestionGroup: Identifiable, Equatable {
    let source: EntityKey
    let photoIDs: [String]
    var id: EntityKey { source }
}

/// What the review sheet should do after `PhotoImportManifest.chooseSourceRecord` resolves a
/// tapped source record. `.resolved` means the manifest already moved or staged the photo(s); the
/// other cases carry what the sheet needs to present the remaining interactive step.
enum PhotoSourceRecordResolution {
    case routePicker
    case resolved
    case relatedChooser(option: PhotoDestinationOption, page: ListPage<EntityRow>?)
    case createEditor(option: PhotoDestinationOption)
}

struct PhotoDestinationOption: Identifiable, Sendable {
    let route: PhotoIngressRoute
    let descriptor: EntityDescriptor
    var id: String { route.id }
    var title: String { descriptor.plural }
    var menuTitle: String {
        switch route.kind {
        case .createRelated:
            "New \(descriptor.singular) from \(EntityCatalog[route.source].singular)"
        case .existingRelated:
            "Existing \(descriptor.singular) for \(EntityCatalog[route.source].singular)"
        case .`self`:
            title
        case .createSelf:
            "New \(descriptor.singular)"
        }
    }

    func menuTitle(for source: EntityRow) -> String {
        switch route.kind {
        case .createRelated:
            "Create \(descriptor.singular) for \(source.id)"
        case .existingRelated:
            "Choose existing \(descriptor.singular) for \(source.id)"
        case .`self`, .createSelf:
            menuTitle
        }
    }
}

struct PhotoSourceTypeOption: Identifiable, Sendable {
    let source: EntityKey
    let options: [PhotoDestinationOption]
    var id: String { source.rawValue }
    var title: String { EntityCatalog[source].plural }
    var outcomeDescription: String {
        let hasRelatedChoices =
            options.contains { $0.route.kind == .existingRelated }
            && options.contains { $0.route.kind == .createRelated }
        if hasRelatedChoices, let related = options.first(where: { $0.route.kind == .createRelated }) {
            return "Choose an existing or new \(related.descriptor.singular)"
        }
        guard
            let primary = options.first(where: { $0.route.choice == .primary })
                ?? options.sorted(by: { $0.id < $1.id }).first
        else { return "Choose an existing record" }
        switch primary.route.kind {
        case .createRelated:
            return "Creates a new \(primary.descriptor.singular)"
        case .existingRelated:
            return "Uses a related \(primary.descriptor.singular)"
        case .`self`:
            return "Attaches to an existing \(EntityCatalog[source].singular)"
        case .createSelf:
            // Unreachable: `options` is `destinationOptions`-derived, which excludes `createSelf`.
            return "Creates a new \(EntityCatalog[source].singular)"
        }
    }
}

enum PhotoImportNavigationDestination: Hashable {
    case sourceTypes
    case sourceType(EntityKey)
    case routePicker(source: EntityKey, row: EntityRow)

    static func sourceSelection(
        type: PhotoSourceTypeOption, row: EntityRow
    ) -> PhotoImportNavigationDestination? {
        type.options.count > 1 ? .routePicker(source: type.source, row: row) : nil
    }
}

struct PhotoSuggestedSource: Sendable {
    let type: PhotoSourceTypeOption
    let row: EntityRow
}

struct PhotoCreateContext: Identifiable {
    let option: PhotoDestinationOption
    let source: EntityRow
    var id: String { "\(option.id):\(source.id)" }
}

/// What tapping `PhotoEntityChooser`'s leading "New <entity>" row should open: the type's own
/// `createSelf` route, or — when the type is also the target of other sources' `createRelated`
/// routes (Garden entry ← Location/Planting, Meal ← Recipe) — a chooser among those plus the
/// type's own enabled route as a fallback.
enum PhotoNewRecordAffordance {
    case createSelf(PhotoDestinationOption)
    case createTarget(candidates: [PhotoDestinationOption], fallback: PhotoDestinationOption?)
}

struct PhotoCreateSelfContext: Identifiable {
    let option: PhotoDestinationOption
    var id: String { option.id }
}

struct PhotoCreateTargetContext: Identifiable {
    let type: EntityKey
    let candidates: [PhotoDestinationOption]
    let fallback: PhotoDestinationOption?
    var id: String { type.rawValue }
}

struct PhotoRelatedContext: Identifiable {
    let option: PhotoDestinationOption
    let source: EntityRow
    /// A page `chooseSourceRecord`'s auto-resolve already fetched (≥2 same-day matches), so the
    /// chooser can seed its list instead of re-querying. `nil` for the manual "Choose existing"
    /// entry point, which still loads its own first page.
    var preloaded: ListPage<EntityRow>? = nil
    var id: String { "\(option.id):\(source.id)" }
}

struct PhotoCreateDraft: Sendable {
    let id: String
    let route: PhotoIngressRoute
    /// `nil` for a `createSelf` draft — there is no source record.
    let source: EntityRef?
    let body: [String: JSONValue]
    let title: String
    let captureDate: Date?
}

struct PhotoDestinationAssignment: Identifiable {
    let route: PhotoIngressRoute
    /// `nil` for a `createSelf` draft — there is no source record.
    let source: EntityRef?
    /// The full source record, kept alongside the lightweight `source` ref so a "Change
    /// destination…" reroute can rebuild the route-picker screen without re-fetching it. `nil`
    /// alongside `source` for a `createSelf` draft.
    let sourceRow: EntityRow?
    let recordID: String?
    let title: String
    let shortcode: String
    let replaceConfirmed: Bool
    let evidence: String
    let createDraft: PhotoCreateDraft?
    var id: String { "\(route.id):\(createDraft?.id ?? recordID ?? "unassigned")" }

    init(
        route: PhotoIngressRoute,
        source: EntityRef?,
        sourceRow: EntityRow?,
        recordID: String?,
        title: String,
        shortcode: String,
        replaceConfirmed: Bool,
        evidence: String,
        createDraft: PhotoCreateDraft? = nil
    ) {
        self.route = route
        self.source = source
        self.sourceRow = sourceRow
        self.recordID = recordID
        self.title = title
        self.shortcode = shortcode
        self.replaceConfirmed = replaceConfirmed
        self.evidence = evidence
        self.createDraft = createDraft
    }
}

struct PhotoUndoAssignment {
    let photoID: String
    let assignment: PhotoDestinationAssignment?
}
