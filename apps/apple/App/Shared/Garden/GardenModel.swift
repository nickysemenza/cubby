import CubbyKit
import Foundation
import Observation

@MainActor
@Observable
final class GardenModel {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    let service: any GardenService
    private(set) var phase: Phase = .idle
    private(set) var overview = GardenOverviewOut(locations: [], finished: [], unassigned: [])
    private(set) var options = GardenOptions(ingredients: [], locations: [], products: [])
    private(set) var guides = GardenGuidesDocument(schemaVersion: ._1, sources: [], guides: [])
    private(set) var guideError: String?
    private(set) var entries: [GardenEntryOut] = []
    private(set) var entriesError: String?
    private(set) var entriesHasMore = false
    private(set) var entriesLoading = false
    private(set) var isSaving = false
    private(set) var saveError: String?
    private(set) var journalRevision = 0

    init(service: any GardenService) {
        self.service = service
    }

    /// One `GardenModel` per garden service instance, shared by `GardenRootView` and the routes it
    /// can push to (`GardenPlantingRouteView`, `GardenEntryRouteView`, `GardenBedJournalView` in
    /// `GardenRouteViews.swift`) instead of each screen constructing its own and re-fetching the
    /// overview, options, and guides. `SectionView`'s `.navigationDestination(for: Route.self)`
    /// sits as a *sibling* of the section root, not an ancestor of it (see that file's doc
    /// comment), so an `.environment(_:)` value set inside `GardenRootView` cannot reach a pushed
    /// `Route` destination — this keyed cache is the substitute for that one path.
    @MainActor
    enum SharedStore {
        private static var models: [ObjectIdentifier: GardenModel] = [:]

        static func model(for service: any GardenService & AnyObject) -> GardenModel {
            let key = ObjectIdentifier(service)
            if let existing = models[key] { return existing }
            let created = GardenModel(service: service)
            models[key] = created
            return created
        }
    }

    /// Loads only when nothing has been loaded yet (`.idle`); callers sharing an instance via
    /// `SharedStore` call this instead of `load()` so the second and later screens reuse the
    /// first's fetch. A prior failure retries, since `.failed` means the data never actually
    /// landed.
    func loadIfNeeded() async {
        guard phase == .idle else { return }
        await load()
    }

    func load() async {
        phase = .loading
        do {
            async let overview = service.gardenOverview()
            async let options = service.gardenOptions(search: nil)
            self.overview = try await overview
            self.options = try await options
            phase = .loaded
        } catch {
            phase = .failed(Self.message(for: error))
            Diagnostics.report(error, context: "garden.load")
            return
        }
        do {
            guides = try await service.gardenGuides()
            guideError = nil
        } catch {
            // Guides enhance a planting decision; a stale or unavailable reference file must not
            // prevent the user from recording what is actually growing.
            guides = GardenGuidesDocument(schemaVersion: ._1, sources: [], guides: [])
            guideError = Self.message(for: error)
            Diagnostics.report(error, context: "garden.guides")
        }
    }

    var allPlantings: [GardenPlantingOut] {
        overview.locations.flatMap(\.plantings) + overview.unassigned + overview.finished
    }

    var allPlantingOptions: [GardenOption] { options.plantings }

    func guide(for ingredientID: String) -> GardenGuide? {
        guard let key = options.ingredients.first(where: { $0.id == ingredientID })?.gardenGuideKey else {
            return nil
        }
        return guides.guides.first(where: { $0.key == key })
    }

    func guideSource(id: String) -> GardenGuideSource? {
        guides.sources.first(where: { $0.id == id })
    }

    func refresh() async {
        await load()
    }

    /// Widens the garden-scoped `options` with prefix matches for an "Add…" picker (`term` must
    /// be at least two characters). Falls back to the already-loaded scoped set on failure or a
    /// too-short term, so a flaky search never blanks the picker.
    func searchOptions(_ term: String) async -> GardenOptions {
        guard term.count >= 2 else { return options }
        return (try? await service.gardenOptions(search: term)) ?? options
    }

    /// `rememberSource` writes the source product's `growsIngredientID` back only when the caller
    /// opted in *and* the product's current association actually differs from this planting's
    /// crop — an unchanged association is not worth an extra write.
    func create(_ input: GardenCreatePlantingInput, rememberSource: Bool = false) async -> Bool {
        let saved = await save {
            _ = try await self.service.createGardenPlanting(input)
        }
        guard saved, rememberSource, let productID = input.sourceProductId?.rawValue else { return saved }
        let currentAssociation = options.products.first(where: { $0.id == productID })?.growsIngredientID
        guard currentAssociation != input.ingredientId else { return saved }
        _ = await save {
            try await self.service.setGardenProduct(id: productID, growsIngredientID: input.ingredientId)
        }
        return saved
    }

    func record(_ input: GardenRecordEntryInput) async -> Bool {
        await save { try await self.service.recordGardenEntry(input) }
    }

    func start(id: String, at locationID: String, on date: Date, method: GardenStartMethod) async -> Bool {
        await save {
            try await self.service.startGardenPlanting(
                id: id,
                locationID: locationID,
                startedAt: date,
                method: method
            )
        }
    }

    func move(_ input: GardenMovePlantingInput) async -> Bool {
        await save { try await self.service.moveGardenPlanting(input) }
    }

    func split(_ input: GardenSplitPlantingInput) async -> Bool {
        await save { _ = try await self.service.splitGardenPlanting(input) }
    }

    func finish(id: String, on date: Date, note: String? = nil) async -> Bool {
        await save { try await self.service.finishGardenPlanting(id: id, finishedAt: date, note: note) }
    }

    func createLocation(name: String, kind: GardenLocationKind, conditions: String?) async -> Bool {
        await save {
            try await self.service.createGardenLocation(name: name, kind: kind, conditions: conditions)
        }
    }

    func updateLocation(
        id: String, name: String?, kind: GardenLocationKind?, conditions: String?
    ) async -> Bool {
        await save {
            try await self.service.updateGardenLocation(
                id: id, name: name, kind: kind, conditions: conditions)
        }
    }

    func setProduct(id: String, growsIngredientID: String?) async -> Bool {
        await save { try await self.service.setGardenProduct(id: id, growsIngredientID: growsIngredientID) }
    }

    func setIngredient(id: String, guideKey: String?) async -> Bool {
        await save { try await self.service.setGardenIngredient(id: id, guideKey: guideKey) }
    }

    func updatePlanting(id: String, _ data: PlantingUpdateData) async -> Bool {
        await save { try await self.service.updateGardenPlanting(id: id, data) }
    }

    func loadEntries(reset: Bool = true) async {
        guard !entriesLoading else { return }
        entriesLoading = true
        entriesError = nil
        defer { entriesLoading = false }
        do {
            let page = try await service.gardenEntries(
                locationID: nil, plantingID: nil, page: reset ? 1 : (entries.count / 50) + 1)
            entries = reset ? page.items : entries + page.items
            entriesHasMore = page.hasMore
        } catch {
            entriesError = Self.message(for: error)
            Diagnostics.report(error, context: "garden.entries")
        }
    }

    func updateEntry(id: String, _ data: GardenEntryUpdateData) async -> Bool {
        await save { try await self.service.updateGardenEntry(id: id, data) }
    }

    private func save(_ operation: () async throws -> Void) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            try await operation()
            await load()
            journalRevision += 1
            return true
        } catch {
            saveError = Self.message(for: error)
            Diagnostics.report(error, context: "garden.save")
            return false
        }
    }

    private static func message(for error: any Error) -> String {
        (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
    }
}
