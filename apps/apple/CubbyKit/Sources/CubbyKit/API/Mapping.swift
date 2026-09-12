import Foundation

/// The boundary between generated OpenAPI types and the domain types in `Models.swift`.
///
/// This and `CubbyClient.swift` are the only files allowed to spell a `Components.Schemas.*`
/// name, and only the *stable* ones — the schemas the emitter names after the operation or the
/// Zod schema. Positional names (`InputSchemaNN`, `OutputSchemaNN`) are not stable across a
/// regeneration, so nested values are reached by property and let inference carry the type.

typealias ScanInput = Components.Schemas.ScanAtLocationInput
typealias ScanOut = Components.Schemas.ScanAtLocationOut
typealias ResolveStraysInput = Components.Schemas.ResolveScanStraysInput
typealias ResolveStraysOut = Components.Schemas.ResolveScanStraysOut
typealias FindByUPCOut = Components.Schemas.ProductFindOrCreateByUPCOut
typealias ProductDetailOut = Components.Schemas.ProductWithFoodOut
typealias ProductRowOut = Components.Schemas.ProductTopLevelOut
typealias ProductListItemOut = Components.Schemas.ProductListItemOut
typealias AmountInput = Components.Schemas.PositiveAmountInput
typealias AgentResultOut = Components.Schemas.AgentResult
typealias LocationNodeOut = Components.Schemas.InfLocation
typealias LocationListRowOut = Components.Schemas.LocationListItemOut
typealias InventoryRowOut = Components.Schemas.InventoryWithLocationAndProductOut
typealias DuplicateProductOut = Components.Schemas.DuplicateUniqueProduct
typealias ReconcileInput = Components.Schemas.ReconcileSessionPayload
typealias SearchHitOut = Components.Schemas.SearchHit
typealias TodayBriefingOut = Components.Schemas.TaskTodayBriefingOut
typealias ProblemCountsOut = Components.Schemas.ProblemsCount
typealias DashboardCountsOut = Components.Schemas.DashboardCountsOut
typealias MealRowOut = Components.Schemas.MealOut
typealias UploadInput = Components.Schemas.InitiateUploadWithoutEntity
typealias UploadOut = Components.Schemas.InitiateUploadWithoutEntityResponse
typealias UPCLookupOut = Components.Schemas.UpcLookupOutput

// MARK: - Scanning

extension ScanInput {
    init(location: LocationCode, code: ScanCode) {
        let payload: CodePayload
        switch code {
        case .barcode(let value):
            payload = CodePayload(value1: .barcode(.init(kind: .barcode, value: value)))
        case .isbn(let value):
            payload = CodePayload(value1: .isbn(.init(kind: .isbn, value: value)))
        case .product(let product):
            payload = CodePayload(value2: .init(kind: .product, value: product.rawValue))
        }
        self.init(locationId: location.rawValue, code: payload)
    }
}

extension ScanResult {
    init(_ out: ScanOut) {
        outcome = ScanOutcome(rawValue: out.outcome.rawValue) ?? .queued
        product = ScannedProduct(
            id: ProductCode(out.product.id),
            name: out.product.name,
            created: out.product.created,
            manufacturer: out.product.manufacturer,
            hasPrice: out.product.hasPrice
        )
        strays = out.strays.map { stray in
            Stray(
                entryId: InventoryEntryCode(stray.entryId),
                locationId: LocationCode(stray.location.id),
                locationName: stray.location.name,
                ambiguousQuantity: stray.ambiguousQuantity
            )
        }
    }
}

extension ResolveStraysInput {
    init(target: LocationCode, moves: [StrayMove]) {
        self.init(
            targetLocationId: target.rawValue,
            moves: moves.map { move in
                MovesPayloadPayload(
                    entryId: move.entryId.rawValue,
                    quantity: move.quantity.map { AmountInput($0) }
                )
            }
        )
    }
}

extension StrayResolution {
    init(_ out: ResolveStraysOut) {
        moved = out.moved
        skipped = out.skipped.map {
            Skipped(entryId: InventoryEntryCode($0.entryId), reason: $0.reason.rawValue, message: $0.message)
        }
    }
}

/// An inventory amount on the wire is `{value, unit, upperValue?}`; "each" is the unit every
/// scanned or counted row uses, so the count-based helpers hard-code it.
extension AmountInput {
    init(_ value: Double, unit: String = "each") {
        self.init(value: value, unit: unit, upperValue: nil)
    }

    init(_ amount: Amount) {
        self.init(value: amount.value, unit: amount.unit, upperValue: amount.upperValue)
    }
}

// MARK: - Products

extension ProductSummary {
    init(_ out: ProductDetailOut) {
        self.init(
            id: ProductCode(out.id),
            name: out.name,
            manufacturer: out.manufacturer.isEmpty ? nil : out.manufacturer,
            coverImageURL: out.coverImageUrl.flatMap(URL.init(string:))
        )
    }

    init(_ out: ProductRowOut) {
        self.init(
            id: ProductCode(out.id),
            name: out.name,
            manufacturer: out.manufacturer.isEmpty ? nil : out.manufacturer,
            coverImageURL: out.coverImageUrl.flatMap(URL.init(string:))
        )
    }
}

extension FoundProduct {
    init(_ out: FindByUPCOut) {
        product = ProductSummary(out.product)
        created = out.created
    }
}

extension UPCLookup {
    init(_ out: UPCLookupOut) {
        self.init(
            upc: out.upc,
            name: out.name,
            manufacturer: out.manufacturer ?? out.brand,
            category: out.category,
            priceDollars: out.priceDollars,
            imageURL: out.imageUrl.flatMap(URL.init(string:)),
            source: out.source.rawValue,
            cached: out.cached
        )
    }
}

// MARK: - Assistant

extension AgentAnswer {
    init(_ out: AgentResultOut) {
        answer = out.answer
        sources = out.sources.map {
            Source(entityType: $0.entityType.rawValue, id: $0.id, name: $0.name, detail: $0.detail)
        }
    }
}

// MARK: - Search

extension SearchHit {
    init(_ out: SearchHitOut) {
        self.init(
            id: out.id,
            entityType: out.entityType.rawValue,
            title: out.title,
            subtitle: out.subtitle,
            typeHint: out.typeHint,
            imageURL: out.imageUrl.flatMap(URL.init(string:)),
            matchKind: out.matchKind.rawValue,
            matchReason: out.matchReason
        )
    }
}

// MARK: - Locations

extension LocationTreeNode {
    init(_ out: LocationNodeOut) {
        self.init(
            id: LocationCode(out.id),
            name: out.name,
            type: out._type,
            directItemCount: out.directItemCount ?? 0,
            totalItemCount: out.totalItemCount ?? 0,
            children: (out.children ?? []).map(LocationTreeNode.init),
            lastBulkInventoryRaw: out.lastBulkInventory
        )
    }
}

extension LocationOption {
    init(_ out: LocationListRowOut) {
        self.init(id: LocationCode(out.id), name: out.name, path: out.parent?.name)
    }
}

// MARK: - Recount

extension RecountRow {
    init(_ out: InventoryRowOut) {
        var barcodes: Set<String> = []
        for external in out.product.externalIds where external.kind == .gtin14 {
            barcodes.insert(external.externalId)
        }
        let cover = out.product.images
            .first { $0.status == .uploaded }
            .flatMap { URL(string: $0.url) }
        self.init(
            id: InventoryEntryCode(out.id),
            amount: Amount(value: out.amount.value, unit: out.amount.unit, upperValue: out.amount.upperValue),
            // The generated payload decodes `updatedAt` to a `Date`, so the verbatim wire string
            // is gone by the time it reaches here. Re-spelling it with the same transcoder the
            // client decodes with is lossless at the millisecond the reconcile guard compares.
            updatedAtRaw: (try? LenientISO8601DateTranscoder().encode(out.updatedAt)) ?? "",
            placement: out.placement.rawValue,
            product: Product(
                id: ProductCode(out.product.id),
                name: out.product.name,
                manufacturer: out.product.manufacturer.isEmpty ? nil : out.product.manufacturer,
                primaryGtin: out.product.primaryGtin,
                barcodes: barcodes,
                coverImageURL: cover
            ),
            locationID: LocationCode(out.location.id),
            locationName: out.location.name
        )
    }
}

extension ReconcileInput {
    init(_ body: ReconcileBody) {
        self.init(
            locationId: body.locationId.rawValue,
            expectedInventoryEntryIds: body.expectedInventoryEntryIds.map(\.rawValue),
            snapshotUpdatedAt: body.snapshotUpdatedAt.flatMap { try? LenientISO8601DateTranscoder().decode($0) },
            resolutions: body.resolutions.map { entry in
                let id = entry.inventoryEntryId.rawValue
                // Each arm carries only its own keys; an unexpected key fails validation.
                switch entry.resolution {
                case .verify:
                    return .verify(.init(kind: .verify, inventoryEntryId: id))
                case .adjust(let amount):
                    return .adjust(.init(kind: .adjust, inventoryEntryId: id, amount: AmountInput(amount)))
                case .remove:
                    return .remove(.init(kind: .remove, inventoryEntryId: id))
                case .relocate(let target, _):
                    return .relocate(.init(kind: .relocate, inventoryEntryId: id, targetLocationId: target.rawValue))
                }
            }
        )
    }
}

extension ProductCode {
    init(_ out: DuplicateProductOut) {
        self.init(out.id)
    }
}

// MARK: - Today

extension TodayTask {
    init(_ out: Components.Schemas.TaskTodayBriefingItemOut) {
        self.init(
            id: out.id,
            name: out.name,
            status: out.status.rawValue,
            dueDate: out.dueDate,
            dueEndDate: out.dueEndDate,
            projectId: out.projectId,
            projectName: out.projectName
        )
    }
}

extension TodayMeal {
    init(_ out: MealRowOut) {
        self.init(
            id: out.id,
            name: out.name ?? out.mealType?.rawValue.capitalized ?? out.date,
            mealType: out.mealType?.rawValue,
            mealKind: out.mealKind.rawValue,
            recipeNames: out.recipes.map(\.recipe.name)
        )
    }
}

extension TodayProblemCounts {
    init(_ out: ProblemCountsOut) {
        self.init(total: Int(out.total), coverageTotal: Int(out.coverageTotal))
    }
}

extension DashboardCounts {
    init(_ out: DashboardCountsOut) {
        // The response spells the USDA food count `usdaFoods` (plural); every other key matches
        // `EntityKey.rawValue`, so the dictionary is keyed that way and the odd one out is fixed
        // up by `count(for:)`.
        self.init(byEntityKey: [
            EntityKey.product.rawValue: out.product,
            EntityKey.recipe.rawValue: out.recipe,
            EntityKey.ingredient.rawValue: out.ingredient,
            EntityKey.cookbook.rawValue: out.cookbook,
            EntityKey.location.rawValue: out.location,
            EntityKey.inventory.rawValue: out.inventory,
            EntityKey.meal.rawValue: out.meal,
            EntityKey.project.rawValue: out.project,
            EntityKey.task.rawValue: out.task,
            EntityKey.vendor.rawValue: out.vendor,
            EntityKey.purchase.rawValue: out.purchase,
            EntityKey.expense.rawValue: out.expense,
            EntityKey.financialAccount.rawValue: out.financialAccount,
            EntityKey.financialTransaction.rawValue: out.financialTransaction,
            EntityKey.image.rawValue: out.image,
            EntityKey.wish.rawValue: out.wish,
            EntityKey.usdaFood.rawValue: out.usdaFoods,
        ])
    }
}

// MARK: - Images

extension UploadInput {
    /// `image.uploadImage`'s `entityType` names the owning table for storage placement; an entity
    /// outside its enum uploads untyped.
    init(filename: String, size: Int, format: ImageEncoding.Format, entity: EntityKey) {
        var input = UploadInput(filename: filename, size: size, contentType: .imageJpeg)
        switch format {
        case .jpeg: break
        case .png: input.contentType = .imagePng
        }
        switch entity {
        case .product: input.entityType = .product
        case .recipe: input.entityType = .recipe
        case .cookbook: input.entityType = .cookbook
        case .location: input.entityType = .location
        case .project: input.entityType = .project
        case .purchase: input.entityType = .purchase
        default: break
        }
        self = input
    }
}

extension ImageUpload {
    init?(_ out: UploadOut) {
        guard let uploadURL = URL(string: out.uploadUrl), let url = URL(string: out.url) else { return nil }
        self.init(uploadUrl: uploadURL, imageId: ImageCode(out.imageId), key: out.key, url: url)
    }
}
