// The entity catalog's vocabulary and descriptor types. The descriptors themselves are data:
// `pnpm generate` writes them from the entity declarations to `Generated/entity-manifest.json`
// (a CubbyKit resource), and `EntityCatalog` decodes that file once. Every `String` enum below is
// checked case by case against the TS vocabulary it mirrors at generate time
// (`scripts/generator/entities/render/swift-catalog.ts`), so a new renderer, slot, kind or
// action fails `pnpm generate` until its case is added here, and the manifest can only carry
// values these enums decode.

import CubbyAPISupport
import Foundation

public enum EntityAction: String, CaseIterable, Codable, Sendable {
    case get = "get"
    case list = "list"
    case timeline = "timeline"
    case search = "search"
    case create = "create"
    case update = "update"
    case bulkUpdate = "bulkUpdate"
    case delete = "delete"
    case merge = "merge"
}

public enum EntityFieldKind: String, CaseIterable, Codable, Sendable {
    case text = "text"
    case textArray = "text-array"
    case number = "number"
    case boolean = "boolean"
    case date = "date"
    case timestamp = "timestamp"
    case `enum` = "enum"
    case json = "json"
    case identifier = "identifier"
}

public enum EntityControlKind: String, CaseIterable, Codable, Sendable {
    case text = "text"
    case textarea = "textarea"
    case checkbox = "checkbox"
    case select = "select"
    case date = "date"
    case number = "number"
    case specialized = "specialized"
}

public enum EntityFilterKind: String, CaseIterable, Codable, Sendable {
    case text = "text"
    case select = "select"
    case multiselect = "multiselect"
    case presence = "presence"
    case boolean = "boolean"
    case id = "id"
    case idMulti = "idMulti"
    case range = "range"
}

public enum ControlRendererID: String, CaseIterable, Codable, Sendable {
    case amount = "amount"
    case entityMultiSelect = "entity-multi-select"
    case entitySelect = "entity-select"
    case externalIds = "external-ids"
    case imageOrder = "image-order"
    case labelNutrition = "label-nutrition"
    case ledgerAttributions = "ledger-attributions"
    case money = "money"
    case productTags = "product-tags"
    case sourceAliases = "source-aliases"
    case sourceRefs = "source-refs"
    case structuredField = "structured-field"
    case tagList = "tag-list"
    case unitMappings = "unit-mappings"
    case upcLookup = "upc-lookup"
    case url = "url"
    case usdaFood = "usda-food"
    case vendorName = "vendor-name"
}

public enum ListRendererID: String, CaseIterable, Codable, Sendable {
    case dataQuality = "data-quality"
    case recipeSource = "recipe-source"
}

public enum DetailRendererID: String, CaseIterable, Codable, Sendable {
    case effectiveOwnership = "effectiveOwnership"
    case expenseProject = "expense-project"
    case financialAccountCardNumbers = "financial-account-card-numbers"
    case financialAccountIdentity = "financial-account-identity"
    case financialAccountSourceAliases = "financial-account-source-aliases"
    case financialTransactionAllocations = "financial-transaction-allocations"
    case financialTransactionSourceRefs = "financial-transaction-source-refs"
    case financialTransactionVendorInference = "financial-transaction-vendor-inference"
    case imageCaptureLocation = "image-capture-location"
    case imageProvenanceEvidence = "image-provenance-evidence"
    case imageSightingCamera = "image-sighting-camera"
    case imageSightingLocation = "image-sighting-location"
    case ledgerTransferClassification = "ledger-transfer-classification"
    case ownerLedgerPartyId = "ownerLedgerPartyId"
    case ownershipMode = "ownershipMode"
    case productCategory = "product-category"
    case productCategoryPath = "product-category-path"
    case productExternalIds = "product-external-ids"
    case productFdcId = "product-fdc-id"
    case productId = "product-id"
    case productIngredient = "product-ingredient"
    case productPrimaryGtin = "product-primary-gtin"
    case productTags = "product-tags"
    case recipeMeta = "recipe-meta"
    case recipeSections = "recipe-sections"
    case recipeSource = "recipe-source"
    case recipeTotals = "recipe-totals"
    case recipeYield = "recipe-yield"
    case vendorAgentHints = "vendor-agent-hints"
    case wishCandidates = "wish-candidates"
}

public enum EntityHeroActionID: String, CaseIterable, Codable, Sendable {
    case addToInventory = "addToInventory"
    case bulkEdit = "bulkEdit"
    case delete = "delete"
    case discard = "discard"
    case edit = "edit"
    case markPurchased = "markPurchased"
    case recordSale = "recordSale"
    case setStatus = "setStatus"
}

public enum EntityDetailSlotID: String, CaseIterable, Codable, Sendable {
    case cookbookImportProgress = "cookbook.import-progress"
    case cookbookToc = "cookbook.toc"
    case expenseSettlement = "expense.settlement"
    case imageAssociations = "image.associations"
    case importRunAiUsage = "importRun.ai-usage"
    case importRunChanges = "importRun.changes"
    case importRunImportWorkflow = "importRun.import-workflow"
    case importRunPhotoBatch = "importRun.photo-batch"
    case ingredientNutritionProduct = "ingredient.nutrition-product"
    case ledgerPartyWardrobe = "ledgerParty.wardrobe"
    case locationAiDescription = "location.ai-description"
    case locationContentsValuation = "location.contents-valuation"
    case mealComposition = "meal.composition"
    case mealNutrition = "meal.nutrition"
    case productCookbooks = "product.cookbooks"
    case productFitsWith = "product.fits-with"
    case productImportRuns = "product.import-runs"
    case productLabels = "product.labels"
    case productNutrition = "product.nutrition"
    case productRecipeAppearances = "product.recipe-appearances"
    case productUnitMappings = "product.unit-mappings"
    case projectAnalytics = "project.analytics"
    case projectBudget = "project.budget"
    case projectContribution = "project.contribution"
    case projectSchedule = "project.schedule"
    case purchaseFinancialSettlement = "purchase.financial-settlement"
    case purchaseImportRuns = "purchase.import-runs"
    case purchaseProjectAllocation = "purchase.project-allocation"
    case purchaseReconciliation = "purchase.reconciliation"
    case recipeWorkflow = "recipe.workflow"
}

public enum EntityListSlotID: String, CaseIterable, Codable, Sendable {
    case expenseAnalytics = "expense.analytics"
    case locationGallery = "location.gallery"
    case locationVisualizations = "location.visualizations"
    case mealCalendar = "meal.calendar"
    case mealNutrition = "meal.nutrition"
    case plantingSchedule = "planting.schedule"
    case productCategoryHierarchy = "productCategory.hierarchy"
    case projectAnalytics = "project.analytics"
    case projectOverview = "project.overview"
    case projectSchedule = "project.schedule"
    case taskAgenda = "task.agenda"
    case taskBoard = "task.board"
}

/// A `{value, label}` choice: a filter's options or a select control's options.
public struct LabeledOption: Codable, Sendable, Hashable {
    public let value: String
    public let label: String
}

/// The entity a reference field points at; `multiple` for an id-array field.
public struct FieldReference: Codable, Sendable, Hashable {
    public let entity: EntityKey
    public let multiple: Bool
    public let scope: [FieldReferenceScope]
    public let filters: [FieldReferenceFilter]
}

public struct FieldReferenceScope: Codable, Sendable, Hashable {
    public let sourceField: String
    public let targetField: String
}

public struct FieldReferenceFilter: Codable, Sendable, Hashable {
    public let field: String
    public let values: [String]
}

public struct FieldExplanationDependency: Codable, Sendable, Hashable {
    public let path: String
    public let label: String
}

public struct FieldExplanation: Codable, Sendable {
    public let ruleId: String
    public let version: Int
    public let description: String
    public let readPath: String?
    public let resolver: String
    public let projections: [String: String]
    public let sourceDependencies: [FieldExplanationDependency]
    public let actions: [String]
}

public struct FieldDescriptor: Codable, Sendable {
    public let key: String
    /// The list/relation column id this source field supplies, when renamed.
    public let columnId: String?
    public let label: String
    public let kind: EntityFieldKind
    /// Whether the server accepts `null` for this field; only a nullable key may be cleared.
    public let nullable: Bool
    public let reference: FieldReference?
    public let explanation: FieldExplanation?
    public let controlKind: EntityControlKind?
    /// Semantic specialized-control id; the platform registry owns its implementation.
    public let controlRenderer: ControlRendererID?
    /// The editor section the field groups under when `presentation.editSections` is nil.
    public let controlSection: String?
    /// `"half"` pairs with the next consecutive half-width field on one row.
    public let controlWidth: String?
    /// A select control's choices; nil for every other control.
    public let controlOptions: [LabeledOption]?
    public let placeholder: String?
    /// `today` seeds a date control on create.
    public let initial: String?
    /// Membership in the create / update payloads (the editor's visible field rosters).
    public let inCreate: Bool
    /// The create payload rejects this key absent: the editor must fill it before saving.
    public let requiredOnCreate: Bool
    public let inUpdate: Bool
    public let showInList: Bool
    public let showInDetail: Bool
    public let detailOrder: Int?
    public let listOrder: Int?
    public let listHidden: Bool
    public let width: String?
    /// Cell formatter (`currency`, `signedCurrency`, `plainDate`, `timestamp`, `external-link`, `amount`).
    public let format: String?
    public let listRenderer: ListRendererID?
    public let detailRenderer: DetailRendererID?
    /// Mobile card placement of the list column, when declared.
    public let mobileSlot: String?
    public let mobilePriority: Int?
    public let mobileInteractive: Bool
}

/// The list-route query parameter(s) a filter binds to; the request is keyed by these names.
public enum FilterWire: Codable, Sendable, Hashable {
    case param(name: String)
    case range(from: String, to: String, presence: String?)

    public var names: [String] {
        switch self {
        case .param(let name): [name]
        case .range(let from, let to, let presence): [from, to] + (presence.map { [$0] } ?? [])
        }
    }
}

public struct FilterDescriptor: Codable, Sendable {
    public let columnId: String
    public let urlKey: String
    public let kind: EntityFilterKind
    public let placeholder: String
    public let label: String?
    /// Declared choices; nil when the server supplies them (`EntityDescriptor.filterValues(for:)`).
    public let options: [LabeledOption]?
    public let wire: FilterWire
    /// For an `id`/`idMulti` filter, the entity the ids name.
    public let targetEntity: EntityKey?
}

/// The five wayfinding lines, from `WAYFINDING_DOMAINS` in the entity definitions.
public enum WayfindingDomain: String, Codable, Sendable, CaseIterable {
    case cook = "cook"
    case pantry = "pantry"
    case plan = "plan"
    case house = "house"
    case finance = "finance"
}

public enum SectionPlacement: String, Codable, Sendable, Hashable {
    case primary = "primary"
    case supporting = "supporting"
    case full = "full"
}

public struct SectionSort: Codable, Sendable, Hashable {
    public enum Direction: String, Codable, Sendable, Hashable {
        case asc = "asc"
        case desc = "desc"
    }

    public let field: String
    public let direction: Direction
}

/// A relation section renders the target entity's list filtered by `filterDescriptor`
/// (a descriptor on the target whose wire name receives this record's id).
public struct RelationSectionSpec: Codable, Sendable, Hashable {
    public let relation: String
    public let filterDescriptor: String
    public let prefill: RelationSectionPrefill?
    public let columns: [String]?
    public let sort: SectionSort?
    public let limit: Int?
    /// Skip the whole section, on both platforms, when its first page is empty.
    public let hideWhenEmpty: Bool
    /// Keep the header and create action but fold the rows away when the first page is empty.
    public let collapseWhenEmpty: Bool
}

public struct RelationSectionPrefill: Codable, Sendable, Hashable {
    public let field: String
}

public enum TimelineSectionMode: String, Codable, Sendable, Hashable {
    case events = "events"
    case lifecycles = "lifecycles"
}

/// One declared detail section. `history`, `relationships` and `images` are never declared;
/// the renderer derives them from capabilities.
public struct DetailSection: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: Codable, Sendable, Hashable {
        case fields([String])
        case relation(RelationSectionSpec)
        case timeline(mode: TimelineSectionMode)
        /// Hand-written per platform; rendered only where a registry provides it.
        case slot
    }

    public let id: String
    public let title: String?
    public let placement: SectionPlacement
    public let collapsed: Bool
    public let explanationField: String?
    public let kind: Kind
}

public enum DetailVariant: String, Codable, Sendable, Hashable {
    case standard = "standard"
    /// The first (relation) section renders before the supporting fields with a create button
    /// prefilled from its filter.
    case journal = "journal"
}

/// The shared List / Cards / Compact control. Compact keeps the Cards URL view.
public enum ListPresentationChoice: String, Codable, Sendable, Hashable, CaseIterable {
    case list = "list"
    case cards = "cards"
    case compact = "compact"

    public var label: String {
        switch self {
        case .list: "List"
        case .cards: "Cards"
        case .compact: "Compact"
        }
    }
}

/// A manifest view; the first declared one is the default.
public enum ListView: Codable, Sendable, Hashable, Identifiable {
    case table
    case shelf
    case timeline
    case slot(id: String, label: String, searchKeys: [String])

    public var id: String {
        switch self {
        case .table: "table"
        case .shelf: "shelf"
        case .timeline: "timeline"
        case .slot(let id, _, _): id
        }
    }

    public var label: String {
        switch self {
        case .table: "List"
        case .shelf: "Cards"
        case .timeline: "Timeline"
        case .slot(_, let label, _): label
        }
    }
}

/// The date keys the lifecycle timeline reads: one interval per record from `start` to `end`,
/// with `milestones` as markers. `start` is an ordered fallback — the first key with a
/// non-null value on a record starts its interval.
public struct TimelineLifecycle: Codable, Sendable, Hashable {
    public let start: [String]
    public let milestones: [String]
    public let end: String?
}

public struct EditSection: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let title: String
    public let fields: [String]
    /// Render the section's body behind a disclosure that starts closed.
    public let collapsed: Bool
}

public enum ReadOnlyMatch: Codable, Sendable, Hashable {
    case string(String)
    case bool(Bool)
}

/// `fields` are read-only on update while the record's `field` equals `equals`.
public struct ReadOnlyRule: Codable, Sendable, Hashable {
    public let field: String
    public let equals: ReadOnlyMatch
    public let fields: [String]
}

/// One curated indirect table on a generic detail screen.
public struct ConnectedViewSpec: Codable, Sendable, Hashable, Identifiable {
    public var id: String { key }
    public let key: String
    public let title: String
    public let target: EntityKey
}

/// The declaration's `presentation` block with its defaults resolved: what the generic
/// list, detail and editor screens render. Field keys are `FieldDescriptor.key`s; action keys
/// are the web verb vocabulary and render natively only where a slot registry provides them.
public struct EntityPresentation: Codable, Sendable, Hashable {
    public let detailVariant: DetailVariant
    public let heroChip: String?
    public let heroStats: [String]
    public let heroBreadcrumb: String?
    public let heroImages: Bool
    public let heroActions: [EntityHeroActionID]
    public let detailSections: [DetailSection]
    public let connectedViews: [ConnectedViewSpec]
    public let listViews: [ListView]
    /// Shelf card subtitle fields, in order; empty when there is no shelf view.
    public let shelfSubtitle: [String]
    public let listActions: [String]
    /// Date fields the default timeline emits events for.
    public let timelineFields: [String]
    public let lifecycle: TimelineLifecycle?
    /// Editor sections; nil derives them from `FieldDescriptor.controlSection`.
    public let editSections: [EditSection]?
    public let readOnlyOnUpdate: [String]
    public let readOnlyWhen: [ReadOnlyRule]
}

public enum RelationCardinality: String, Codable, Sendable, Hashable {
    case one = "one"
    case many = "many"
}

public struct RelationDescriptor: Codable, Sendable, Hashable {
    public let key: String
    public let label: String
    public let target: EntityKey
    public let cardinality: RelationCardinality
}

/// How `resources.<entity>.timeline` is served: the audit log plus declared date fields, or
/// the entity's own implementation.
public enum EntityTimelineMode: String, Codable, Sendable, Hashable {
    case `default` = "default"
    case custom = "custom"
}

/// The one broad lexical search control a server-backed list exposes.
public struct PrimarySearchDescriptor: Codable, Sendable, Hashable {
    public let key: String
    public let placeholder: String
}

public struct EntityDescriptor: Codable, Sendable {
    public let key: EntityKey
    public let singular: String
    public let plural: String
    public let basePath: String
    public let shortcodePrefix: String?
    public let titleField: String
    /// The wayfinding line this entity's records live on; nil for one on no line (image).
    public let domain: WayfindingDomain?
    /// SF Symbol name from the declaration's `presentation.icons.sfSymbol`.
    public let sfSymbol: String
    /// Text fallback from `presentation.icons.emoji` where an SF Symbol can't render: CLI output,
    /// notifications, share text.
    public let emoji: String
    /// Indexed by `search.find`; the intent surface is `searchable` ∧ `nativeActions.contains(.get)`.
    public let searchable: Bool
    /// Search transport metadata; nil for lists without a text-search parameter.
    public let primarySearch: PrimarySearchDescriptor?
    /// Non-nil exactly when the HTTP document exposes `resources.<key>.timeline`.
    public let timeline: EntityTimelineMode?
    public let fields: [FieldDescriptor]
    public let filters: [FilterDescriptor]
    public let relations: [RelationDescriptor]
    public let presentation: EntityPresentation

    public func field(_ key: String) -> FieldDescriptor? {
        fields.first { $0.key == key }
    }

    public func filter(_ columnId: String) -> FilterDescriptor? {
        filters.first { $0.columnId == columnId }
    }

    public func relation(_ key: String) -> RelationDescriptor? {
        relations.first { $0.key == key }
    }
}

public enum EntityCatalog {
    /// Every declared entity, in declaration order. Decoded from the bundled manifest on first
    /// use; a manifest that does not decode is a build defect (`EntityManifestTests` fails CI).
    public static let all: [EntityDescriptor] = {
        guard let url = Bundle.module.url(forResource: "entity-manifest", withExtension: "json") else {
            fatalError("entity-manifest.json is missing from the CubbyKit bundle; run `pnpm generate`.")
        }
        do {
            return try JSONDecoder().decode([EntityDescriptor].self, from: Data(contentsOf: url))
        } catch {
            fatalError("entity-manifest.json does not decode: \(error)")
        }
    }()

    private static let byKey: [EntityKey: EntityDescriptor] = Dictionary(
        uniqueKeysWithValues: all.map { ($0.key, $0) }
    )

    // Total by construction: the manifest has one entry per `EntityKey` case because both are
    // generated from the same declared entity roster.
    public static subscript(key: EntityKey) -> EntityDescriptor {
        byKey[key]!
    }

    /// The descriptor whose canonical shortcode prefix a code carries (`PRD-…` → product).
    /// Prefix match only: the server resolves legacy `P-`/`L-` labels and validates the body.
    public static func descriptor(forShortcode code: String) -> EntityDescriptor? {
        let normalized = code.trimmingCharacters(in: .whitespaces).uppercased()
        return all.first { descriptor in
            descriptor.shortcodePrefix.map { normalized.hasPrefix($0) } ?? false
        }
    }
}
