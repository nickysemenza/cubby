import CubbyAPI
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
typealias MealListRowOut = Components.Schemas.MealListItemOut
typealias UploadInput = Components.Schemas.InitiateUploadWithoutEntity
typealias UploadOut = Components.Schemas.InitiateUploadWithoutEntityResponse
typealias UPCLookupOut = Components.Schemas.UpcLookupOutput
typealias GardenCreateInput = Components.Schemas.GardenCreatePlantingInput
typealias GardenFinishInput = Components.Schemas.GardenFinishPlantingInput
typealias GardenGuidesOut = Components.Schemas.GardenGuidesDocument
typealias GardenMoveInput = Components.Schemas.GardenMovePlantingInput
typealias GardenOptionsOut = Components.Schemas.GardenOptionsOut
typealias GardenOverviewOut = Components.Schemas.GardenOverviewOut
typealias GardenPlantingOut = Components.Schemas.GardenPlantingOut
typealias GardenRecordInput = Components.Schemas.GardenRecordEntryInput
typealias GardenSplitInput = Components.Schemas.GardenSplitPlantingInput
typealias GardenStartInput = Components.Schemas.GardenStartPlantingInput
typealias GardenEntriesOut = Components.Schemas.GardenEntriesOut
typealias GardenEntryOut = Components.Schemas.GardenEntryOut
typealias PlantingOut = Components.Schemas.PlantingOut
typealias GardenJournalOut = Components.Schemas.GardenJournalOut
typealias GardenJournalEntryOut = Components.Schemas.GardenJournalEntryOut
typealias GardenLocationHistoryOut = Components.Schemas.GardenLocationHistoryOut
typealias GardenLocationPeriodOut = Components.Schemas.GardenLocationPeriodOut
typealias GardenCorrectLocationDatesInput = Components.Schemas.GardenCorrectLocationDatesInput

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

// MARK: - Garden

enum GardenPlainDate {
    static func date(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let components = raw.split(separator: "-", omittingEmptySubsequences: false).compactMap { Int($0) }
        guard components.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar.date(
            from: DateComponents(year: components[0], month: components[1], day: components[2]))
    }

    static func string(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

extension GardenPlanting {
    init(_ out: GardenPlantingOut) {
        self.init(
            id: out.id,
            ingredient: .init(
                id: out.ingredientId, name: out.ingredientName, gardenGuideKey: out.gardenGuideKey),
            product: out.sourceProductId.map { .init(id: $0, name: out.sourceProductName ?? $0) },
            location: out.locationId.map { .init(id: $0, name: out.locationName ?? $0) },
            intendedLocation: out.intendedLocationId.map {
                .init(id: $0, name: out.intendedLocationName ?? $0)
            },
            parentPlantingID: out.parentPlantingId,
            status: .init(rawValue: out.status.rawValue)!,
            variety: out.variety,
            quantity: out.quantity,
            notes: out.notes,
            plannedWindow: out.plannedWindow,
            plannedDate: GardenPlainDate.date(out.plannedDate),
            sownAt: GardenPlainDate.date(out.sowedOn),
            transplantedAt: GardenPlainDate.date(out.transplantedOn),
            finishedAt: GardenPlainDate.date(out.finishedOn),
            gardenGuideKey: out.gardenGuideKey
        )
    }
}

extension GardenPlanting {
    init(_ out: PlantingOut, options: GardenOptions) {
        let ingredient =
            options.ingredients.first(where: { $0.id == out.ingredientId })
            ?? GardenOption(id: out.ingredientId, name: out.ingredientId)
        self.init(
            id: out.id, ingredient: ingredient,
            product: out.sourceProductId.map { id in
                options.products.first(where: { $0.id == id }).map { GardenOption(id: $0.id, name: $0.name) }
                    ?? GardenOption(id: id, name: id)
            },
            location: out.locationId.map { id in
                options.locations.first(where: { $0.id == id }) ?? GardenOption(id: id, name: id)
            },
            intendedLocation: out.intendedLocationId.map { id in
                options.locations.first(where: { $0.id == id }) ?? GardenOption(id: id, name: id)
            },
            parentPlantingID: out.parentPlantingId, status: .init(rawValue: out.status.rawValue)!,
            variety: out.variety, quantity: out.quantity, notes: out.notes, plannedWindow: out.plannedWindow,
            plannedDate: GardenPlainDate.date(out.plannedDate), sownAt: GardenPlainDate.date(out.sowedOn),
            transplantedAt: GardenPlainDate.date(out.transplantedOn),
            finishedAt: GardenPlainDate.date(out.finishedOn),
            gardenGuideKey: ingredient.gardenGuideKey)
    }
}

extension GardenOverview {
    init(_ out: GardenOverviewOut) {
        self.init(
            locations: out.locations.map {
                GardenLocation(
                    id: $0.id,
                    name: $0.name,
                    gardenKind: $0.gardenKind?.rawValue,
                    conditions: $0.gardenConditions,
                    plantings: $0.plantings.map(GardenPlanting.init)
                )
            },
            finishedPlantings: out.finished.map(GardenPlanting.init),
            unassignedPlantings: out.unassigned.map(GardenPlanting.init)
        )
    }
}

extension GardenEntry {
    init(_ out: GardenEntryOut) {
        self.init(
            id: out.id, locationID: out.locationId, plantingID: out.plantingId,
            kind: .init(rawValue: out.kind.rawValue)!, observedAt: GardenPlainDate.date(out.observedOn)!,
            note: out.note, harvestAmount: out.harvestAmount,
            images: out.images.compactMap { image in
                URL(string: image.url).map { GardenImage(id: image.id, url: $0, filename: image.filename) }
            }, locationName: out.locationName, plantingName: out.plantingName)
    }
}

extension GardenOptions {
    init(_ out: GardenOptionsOut) {
        self.init(
            ingredients: out.ingredients.map {
                .init(id: $0.id, name: $0.name, gardenGuideKey: $0.gardenGuideKey)
            },
            locations: out.locations.map { .init(id: $0.id, name: $0.name) },
            products: out.products.map {
                .init(id: $0.id, name: $0.name, growsIngredientID: $0.growsIngredientId)
            },
            plantings: out.plantings.map {
                .init(id: $0.id, name: [$0.name, $0.locationName].compactMap { $0 }.joined(separator: " · "))
            }
        )
    }
}

extension GardenGuidesDocument {
    init(_ out: GardenGuidesOut) {
        self.init(
            schemaVersion: Int(out.schemaVersion),
            sources: out.sources.map {
                GardenGuideSource(
                    id: $0.id,
                    name: $0.name,
                    url: URL(string: $0.url)!,
                    publishedOrRevised: $0.publishedOrRevised,
                    reviewedAt: $0.reviewedAt,
                    basedOn: $0.basedOn,
                    notes: $0.notes
                )
            },
            guides: out.guides.map { guide in
                GardenGuide(
                    key: guide.key,
                    name: guide.name,
                    aliases: guide.aliases,
                    windows: guide.windows.enumerated().map { index, window in
                        GardenGuideWindow(
                            id: "\(guide.key)-\(index)",
                            sourceID: window.sourceId,
                            microclimate: window.microclimate.rawValue,
                            method: window.method.rawValue,
                            months: window.months,
                            monthPart: window.monthPart?.rawValue,
                            note: window.notes
                        )
                    },
                    notes: guide.notes
                )
            }
        )
    }
}

extension GardenCreateInput {
    init(_ input: CreateGardenPlanting) {
        self.init(
            ingredientId: input.ingredientID,
            locationId: input.locationID,
            intendedLocationId: input.intendedLocationID,
            status: .init(rawValue: input.status.rawValue),
            inLocationSince: input.inLocationSince.map(GardenPlainDate.string),
            inLocationSinceKind: .init(rawValue: input.inLocationSinceKind.rawValue)!,
            sourceProductId: input.productID,
            variety: input.variety,
            quantity: input.quantity,
            notes: input.notes,
            plannedWindow: input.plannedWindow,
            plannedDate: input.plannedDate.map(GardenPlainDate.string),
            sowedOn: input.sownAt.map(GardenPlainDate.string),
            transplantedOn: input.transplantedAt.map(GardenPlainDate.string)
        )
    }
}

extension GardenJournalEntry {
    init(_ out: GardenJournalEntryOut) {
        let entry = GardenEntry(
            id: out.id, locationID: out.locationId, plantingID: out.plantingId,
            kind: .init(rawValue: out.kind.rawValue)!, observedAt: GardenPlainDate.date(out.observedOn)!,
            note: out.note, harvestAmount: out.harvestAmount,
            images: out.images.compactMap { image in
                URL(string: image.url).map { GardenImage(id: image.id, url: $0, filename: image.filename) }
            }, locationName: out.locationName, plantingName: out.plantingName)
        self.init(
            entry: entry, context: .init(rawValue: out.context.rawValue) ?? .direct,
            locationName: out.locationName, plantingName: out.plantingName)
    }
}

extension GardenLocationPeriod {
    init(_ out: GardenLocationPeriodOut) {
        self.init(
            sequence: out.sequence, location: .init(id: out.locationId, name: out.locationName),
            inLocationSince: GardenPlainDate.date(out.inLocationSince)!,
            endedOn: GardenPlainDate.date(out.endedOn),
            startKind: .init(rawValue: out.startKind.rawValue) ?? .actual)
    }
}

extension GardenCorrectLocationDatesInput {
    init(plantingID: String, periods: [GardenLocationPeriod]) {
        self.init(
            plantingId: plantingID,
            periods: periods.map {
                .init(
                    sequence: $0.sequence, inLocationSince: GardenPlainDate.string($0.inLocationSince),
                    endedOn: $0.endedOn.map(GardenPlainDate.string))
            })
    }
}

extension GardenRecordInput {
    init(_ input: RecordGardenEntry) {
        self.init(
            locationId: input.locationID,
            plantingId: input.plantingID,
            kind: .init(rawValue: input.kind.rawValue),
            observedOn: GardenPlainDate.string(input.observedAt),
            note: input.note,
            harvestAmount: input.harvestAmount,
            pendingImageIds: input.pendingImageIDs.map(\.rawValue)
        )
    }
}

extension GardenMoveInput {
    init(_ input: MoveGardenPlanting) {
        self.init(
            plantingId: input.plantingID,
            locationId: input.destinationLocationID,
            movedOn: GardenPlainDate.string(input.observedAt),
            note: input.note
        )
    }
}

extension GardenSplitInput {
    init(_ input: SplitGardenPlanting) {
        self.init(
            plantingId: input.plantingID,
            locationId: input.destinationLocationID,
            movedOn: GardenPlainDate.string(input.observedAt),
            quantity: input.quantity,
            note: input.note
        )
    }
}

extension GardenStartInput {
    init(id: String, locationID: String, startedAt: Date, method: GardenStartMethod) {
        self.init(
            plantingId: id,
            locationId: locationID,
            startedOn: GardenPlainDate.string(startedAt),
            startMethod: .init(rawValue: method.rawValue)!
        )
    }
}

extension GardenFinishInput {
    init(id: String, finishedAt: Date) {
        self.init(plantingId: id, finishedOn: GardenPlainDate.string(finishedAt))
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
            type: out._type?.rawValue,
            directItemCount: out.directItemCount ?? 0,
            totalItemCount: out.totalItemCount ?? 0,
            children: (out.children ?? []).map(LocationTreeNode.init),
            // The generated payload decodes `lastBulkInventory` to a `Date`, so the verbatim wire
            // string is gone by the time it reaches here; re-spelling it with the same transcoder
            // the client decodes with is lossless (kept verbatim for display only, see the field).
            lastBulkInventoryRaw: out.lastBulkInventory.flatMap {
                try? LenientISO8601DateTranscoder().encode($0)
            }
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
        // InventoryDetailProductOut (the recount row's product shape) carries neither
        // `displayImages` nor `coverImageUrl` — only this status-tagged `images` array. Switch to
        // `out.product.displayImages.first?.url` once that field lands here, matching the
        // list-row image ladder in EntityRow.imageURL(from:).
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
            snapshotUpdatedAt: body.snapshotUpdatedAt.flatMap {
                try? LenientISO8601DateTranscoder().decode($0)
            },
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
                    return .relocate(
                        .init(kind: .relocate, inventoryEntryId: id, targetLocationId: target.rawValue))
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

    /// `resources.meal.list` returns `MealListItemOut` (adds `displayImages`), a distinct
    /// generated type from `MealOut` even though it's a superset — same duplication as
    /// `LocationListRowOut` alongside `LocationNodeOut` above.
    init(_ out: MealListRowOut) {
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
        // Iterate the generated catalog's `countable` flag instead of hand-listing keys: the
        // 2026-09 regression silently dropped `planting`/`gardenEntry` because this initializer
        // hand-listed 17 keys and nobody updated it when those entities' routes shipped. The
        // `count(for:in:)` switch below is exhaustive over every `EntityKey`, so a newly
        // countable entity fails to compile here until it is mapped.
        var byEntityKey: [String: Int] = [:]
        for entity in EntityKey.allCases where EntityCatalog[entity].countable {
            byEntityKey[entity.rawValue] = DashboardCounts.count(for: entity, in: out)
        }
        // The response spells the USDA food count `usdaFoods` (plural), and USDA foods are not
        // `countable` in the entity manifest (they come from the separate USDA database, not the
        // generic per-entity count query) — so this key is fixed up by hand instead of by the
        // loop above.
        byEntityKey[EntityKey.usdaFood.rawValue] = out.usdaFoods
        self.init(byEntityKey: byEntityKey)
    }

    /// One arm per `EntityKey`, deliberately with no `default:`: adding a new case to the
    /// generated `EntityKey` enum without adding it here fails the build instead of silently
    /// omitting the entity from the dashboard, which is exactly how `planting`/`gardenEntry` were
    /// dropped previously. `ledgerParty`/`ledgerTransfer`/`usdaFood` are never reached — the
    /// caller only visits `countable` keys, and `usdaFood` is mapped separately above — so they
    /// trap rather than return a fabricated count.
    private static func count(for entity: EntityKey, in out: DashboardCountsOut) -> Int {
        switch entity {
        case .product: return out.product
        case .recipe: return out.recipe
        case .ingredient: return out.ingredient
        case .cookbook: return out.cookbook
        case .location: return out.location
        case .inventory: return out.inventory
        case .meal: return out.meal
        case .project: return out.project
        case .task: return out.task
        case .vendor: return out.vendor
        case .purchase: return out.purchase
        case .expense: return out.expense
        case .financialAccount: return out.financialAccount
        case .financialTransaction: return out.financialTransaction
        case .image: return out.image
        case .wish: return out.wish
        case .planting: return out.planting
        case .gardenEntry: return out.gardenEntry
        case .ledgerParty, .ledgerTransfer, .usdaFood:
            preconditionFailure(
                "EntityKey.\(entity.rawValue) is not countable-iterated; usdaFood is mapped separately."
            )
        }
    }
}

// MARK: - Images

extension UploadInput {
    /// `image.uploadImage`'s `entityType` names the owning table for storage placement; an entity
    /// outside its enum uploads untyped.
    ///
    /// `Components.Schemas.EntityImage`'s raw values are `EntityKey.rawValue`, upper-cased
    /// (`"gardenEntry"` -> `"GARDENENTRY"`), so deriving the payload from `entity.rawValue`
    /// instead of hand-listing cases keeps this in sync with the OpenAPI enum automatically —
    /// a hand-listed switch previously dropped `gardenEntry` when it was added upstream. An
    /// entity outside the enum (e.g. `vendor`) makes the `rawValue:` init return `nil`, which is
    /// the same "uploads untyped" behavior the old `default: break` produced.
    init(filename: String, size: Int, format: ImageEncoding.Format, entity: EntityKey) {
        var input = UploadInput(filename: filename, size: size, contentType: .imageJpeg)
        switch format {
        case .jpeg: break
        case .png: input.contentType = .imagePng
        }
        input.entityType = Components.Schemas.EntityImage(rawValue: entity.rawValue.uppercased())
        self = input
    }
}

extension ImageUpload {
    init?(_ out: UploadOut) {
        guard let uploadURL = URL(string: out.uploadUrl), let url = URL(string: out.url) else { return nil }
        self.init(uploadUrl: uploadURL, imageId: ImageCode(out.imageId), key: out.key, url: url)
    }
}
