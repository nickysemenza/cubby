import CubbyAPI
import CubbyAPISupport
import Foundation

/// The hand-written surface on the generated types: identities SwiftUI lists need, the few
/// derived values screens read, and the converters between sibling wire shapes. Everything else
/// about a generated type is its own; a divergence that needs more than a few lines belongs in the
/// generator (see `scripts/generator/http-api/`), not here.

// The branded codes and `PlainDate` live in `CubbyAPISupport` so the generated client can use
// them; these aliases let the App name them through CubbyKit alone.
public typealias ProductCode = CubbyAPISupport.ProductCode
public typealias LocationCode = CubbyAPISupport.LocationCode
public typealias InventoryEntryCode = CubbyAPISupport.InventoryEntryCode
public typealias ImageCode = CubbyAPISupport.ImageCode
public typealias EntityKey = CubbyAPISupport.EntityKey

// MARK: - Amounts

/// An inventory amount on the wire is `{value, unit, upperValue?}`; "each" is the unit every
/// scanned or counted row uses, so the count-based helper hard-codes it.
extension PositiveAmountInput {
    public init(_ value: Double, unit: String = "each") {
        self.init(value: value, unit: unit, upperValue: nil)
    }

    public init(_ amount: Amount) {
        self.init(value: amount.value, unit: amount.unit, upperValue: amount.upperValue)
    }
}

extension Amount {
    public init(_ input: PositiveAmountInput) {
        self.init(value: input.value, unit: input.unit, upperValue: input.upperValue)
    }
}

// MARK: - Entity references and the relationship graph

extension EntityRef: Identifiable {
    public init(entity: EntityKey, id: String) {
        self.init(entityType: entity, entityId: id)
    }

    public init(_ root: EntityGraphRoot) {
        self.init(entityType: root.entityType, entityId: root.entityId)
    }

    public var entity: EntityKey { entityType }
    public var id: String { entityId }
    public var stableKey: String { "\(entityType.rawValue):\(entityId)" }

    var graphRootInput: EntityGraphRootInput {
        .init(entityType: entityType, entityId: entityId)
    }
}

extension EntityGraphRoot {
    public init(_ reference: EntityRef) {
        self.init(entityType: reference.entityType, entityId: reference.entityId)
    }
}

extension EntityGraphNode: Identifiable {
    /// Fixtures and previews build nodes from a reference; the wire carries the parts.
    public init(reference: EntityRef, label: String, metadata: [String: String] = [:], imageURL: URL? = nil) {
        self.init(
            entityType: reference.entityType, entityId: reference.entityId, label: label,
            metadata: .init(additionalProperties: metadata),
            image: imageURL.map { .init(url: $0.absoluteString) })
    }

    public var reference: EntityRef { EntityRef(entityType: entityType, entityId: entityId) }
    public var id: String { reference.stableKey }
    public var imageURL: URL? { image.flatMap { URL(string: $0.url) } }
}

extension EntityGraphBranch: Identifiable {
    public var id: String { "\(root.stableKey)|\(relationshipKey)" }
}

extension EntityGraphPath: Identifiable {
    public var id: String {
        "\(nodeRefs.map(\.stableKey).joined(separator: ">"))|\(edgeIds.joined(separator: ">"))"
    }
    public var destination: EntityRef? { nodeRefs.last }
}

extension ExpenseProjectProposal: Identifiable {
    public var id: String { "expense-project:\(expenseId):\(target.id)" }
}

extension InventoryPlacementProposal: Identifiable {
    public var id: String { "inventory-placement:\(inventoryId.rawValue):\(target.id.rawValue)" }
}

extension ProductRelatedProposal: Identifiable {
    public var id: String { "product-related:\(target.id.rawValue)" }
}

extension EntityRecommendationGroup: Identifiable {
    public var id: String {
        switch self {
        case .expenseProject: "expense-project"
        case .inventoryPlacement: "inventory-placement"
        case .productRelated: "product-related"
        }
    }

    public var status: EmbeddingReadiness {
        switch self {
        case .expenseProject(let group): group.status
        case .inventoryPlacement(let group): group.status
        case .productRelated(let group): group.status
        }
    }
}

// MARK: - Scanning

extension ScanStrayOut: Identifiable {
    public var id: InventoryEntryCode { entryId }
}

// MARK: - Search

extension SearchHit {
    /// `entityType` is the raw searchable-entity name; `nil` for a kind the catalog does not
    /// declare, which `SearchModel` drops rather than renders.
    public var key: EntityKey? { EntityKey(rawValue: entityType) }
    public var imageURL: URL? { imageUrl.flatMap(URL.init(string:)) }

    /// The server's caps on a `search.find` query.
    public static let maxQueryLength = 100
    public static let maxLimit = 50
}

// MARK: - Products

extension ProductDetail {
    public var coverImageURL: URL? { coverImageUrl.flatMap(URL.init(string:)) }
}

extension UpcLookupOutput {
    /// `manufacturer` when the catalog knows one, else the brand it printed on the label.
    public var manufacturerOrBrand: String? { manufacturer ?? brand }
    public var imageURL: URL? { imageUrl.flatMap(URL.init(string:)) }
}

// MARK: - Meals and nutrition

extension NutritionMeal {
    public var displayName: String {
        if let name, !name.isEmpty { return name }
        if let mealType { return mealType.rawValue.capitalized }
        return "Meal"
    }
}

extension MealNutritionPerson: Identifiable {
    public var id: String { eater.id }
    public var name: String { eater.name }
}

extension MealNutritionFood: Identifiable {
    /// The fields every food kind carries, whichever arm the discriminator chose.
    private var common:
        (
            meal: NutritionMeal, name: String, amount: MealFoodAmount?, grams: Double?,
            weight: MeasureEstimate,
            totals: MealTotals
        )
    {
        switch self {
        case .ingredient(let f): (f.meal, f.name, f.amount, f.grams, f.weight, f.totals)
        case .manual(let f): (f.meal, f.name, f.amount, f.grams, f.weight, f.totals)
        case .product(let f): (f.meal, f.name, f.amount, f.grams, f.weight, f.totals)
        case .recipe(let f): (f.meal, f.name, f.amount, f.grams, f.weight, f.totals)
        }
    }

    public var meal: NutritionMeal { common.meal }
    public var name: String { common.name }
    public var amount: MealFoodAmount? { common.amount }
    public var grams: Double? { common.grams }
    public var weight: MeasureEstimate { common.weight }
    public var totals: MealTotals { common.totals }

    public var id: String {
        switch self {
        case .recipe(let food): "recipe:\(food.meal.id):\(food.mealRecipeId)"
        case .product(let food): "product:\(food.id)"
        case .ingredient(let food): "ingredient:\(food.id)"
        case .manual(let food): "manual:\(food.id)"
        }
    }

    public var sourceKind: String {
        switch self {
        case .recipe: "Recipe"
        case .product: "Product"
        case .ingredient: "Ingredient"
        case .manual: "Manual"
        }
    }

    public var amountDescription: String {
        if let amount {
            return "\(amount.value.formatted(.number.precision(.fractionLength(0...6)))) \(amount.unit)"
        }
        return grams.map { "\($0.formatted(.number.precision(.fractionLength(0...1)))) g" }
            ?? "Entered macros"
    }
}

extension MacroSummary {
    /// The server's `partial`: at least one of the four macros is a partial estimate.
    public var containsPartialEstimate: Bool { partial }
}

// MARK: - Dashboard and Today

extension DashboardCountsOut {
    /// Row counts keyed by `EntityKey.rawValue`, read off the JSON projection so a newly counted
    /// entity needs no hand-listed arm here. The response spells the USDA food count `usdaFoods`
    /// (plural), so that key is mapped by hand.
    public func count(for key: EntityKey) -> Int? {
        guard let counts = try? JSONValue(encoding: self), case .object(let fields) = counts else {
            return nil
        }
        let field = key == .usdaFood ? "usdaFoods" : key.rawValue
        if case .number(let value) = fields[field] ?? .null { return Int(value) }
        return nil
    }
}

// MARK: - Images

extension InitiateUploadWithoutEntity {
    /// `image.uploadImage`'s `entityType` names the owning table for storage placement; an entity
    /// outside its enum uploads untyped. `EntityImage`'s raw values are `EntityKey.rawValue`
    /// upper-cased, so the case is derived rather than hand-listed (a hand-listed switch once
    /// dropped `gardenEntry`).
    public init(filename: String, size: Int, format: ImageEncoding.Format, entity: EntityKey) {
        self.init(filename: filename, size: size, contentType: format == .png ? .imagePng : .imageJpeg)
        entityType = EntityImage(rawValue: entity.rawValue.uppercased())
    }
}

extension ImageOut {
    public var imageURL: URL? { URL(string: url) }
}

extension ImageWithEntity {
    /// The server owns original-versus-derived selection; every native image surface follows it.
    public var imageURL: URL? { URL(string: representations?.preferred ?? url) }
    public var originalImageURL: URL? { URL(string: representations?.original ?? url) }
    public var transparentImageURL: URL? { representations?.transparent.flatMap(URL.init(string:)) }
}

extension ImageAssociation: Identifiable {
    public var id: String { "\(entityType.rawValue):\(entityId):\(role.rawValue)" }
    /// The catalog key, when the association's entity is one the catalog knows.
    public var key: EntityKey? { EntityKey(rawValue: entityType.rawValue) }
}

extension PhotoLocalAnalysis {
    /// Reconstructs the analysis from the wire payload the server persisted at import time
    /// (`image.analysis`), so the R2 image detail's "server (at import)" Diagnostics column can be
    /// built by the same `PhotoDiagnostics.report` the device's own fresh run uses — one report
    /// shape either side of the wire, not a bespoke comparison renderer.
    public init(payload: ImageAnalysisOutput) {
        self.init(
            id: payload.sha256,
            analysisVersion: payload.analysisVersion,
            analyzedAt: payload.analyzedAt,
            sha256: payload.sha256,
            capturedAt: payload.capturedAt,
            contentType: payload.contentType,
            width: payload.width,
            height: payload.height,
            classifications: payload.classifications.map {
                PhotoClassification(identifier: $0.identifier, confidence: $0.confidence)
            },
            recognizedText: payload.recognizedText.map {
                PhotoRecognizedText(text: $0.text, confidence: $0.confidence)
            },
            featurePrint: PhotoFeaturePrint(
                revision: payload.featurePrint.revision,
                data: Data(base64Encoded: payload.featurePrint.data) ?? Data()),
            provenance: PhotoAnalysisProvenance(
                source: PhotoAnalysisProvenance.Source(rawValue: payload.provenance.source.rawValue)
                    ?? .files,
                localIdentifier: payload.provenance.localIdentifier,
                filename: payload.provenance.filename))
    }
}

extension ImageAnalysisOutput {
    /// The wire payload for `recordImageAnalysis`, built from a device-run `PhotoLocalAnalysis` —
    /// the inverse of `PhotoLocalAnalysis.init(payload:)` above. Shared by
    /// `PhotoImportRunUploader`'s post-finalize analysis phase and (via that same shape) the
    /// Diagnostics backfill path, so the two never drift into slightly different field mappings.
    public init(_ analysis: PhotoLocalAnalysis) {
        self.init(
            analysisVersion: analysis.analysisVersion, analyzedAt: analysis.analyzedAt,
            sha256: analysis.sha256, capturedAt: analysis.capturedAt,
            contentType: analysis.contentType, width: analysis.width, height: analysis.height,
            classifications: analysis.classifications.map {
                .init(identifier: $0.identifier, confidence: $0.confidence)
            },
            recognizedText: analysis.recognizedText.map {
                .init(text: $0.text, confidence: $0.confidence)
            },
            featurePrint: .init(
                revision: analysis.featurePrint.revision,
                data: analysis.featurePrint.data.base64EncodedString()),
            provenance: .init(
                source: .init(rawValue: analysis.provenance.source.rawValue) ?? .files,
                localIdentifier: analysis.provenance.localIdentifier,
                filename: analysis.provenance.filename))
    }
}
