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

    private let service: any GardenService
    private(set) var phase: Phase = .idle
    private(set) var overview = GardenOverview(locations: [], finishedPlantings: [])
    private(set) var options = GardenOptions(ingredients: [], locations: [], products: [])
    private(set) var guides = GardenGuidesDocument(schemaVersion: 1, sources: [], guides: [])
    private(set) var guideError: String?
    private(set) var entries: [GardenEntry] = []
    private(set) var isSaving = false
    private(set) var saveError: String?

    init(service: any GardenService) {
        self.service = service
    }

    func load() async {
        phase = .loading
        do {
            async let overview = service.gardenOverview()
            async let options = service.gardenOptions()
            self.overview = try await overview
            self.options = try await options
            phase = .loaded
        } catch {
            phase = .failed(Self.message(for: error))
            return
        }
        do {
            guides = try await service.gardenGuides()
            guideError = nil
        } catch {
            // Guides enhance a planting decision; a stale or unavailable reference file must not
            // prevent the user from recording what is actually growing.
            guides = GardenGuidesDocument(schemaVersion: 1, sources: [], guides: [])
            guideError = Self.message(for: error)
        }
    }

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

    func create(_ input: CreateGardenPlanting) async -> Bool {
        await save {
            _ = try await self.service.createGardenPlanting(input)
        }
    }

    func record(_ input: RecordGardenEntry) async -> Bool {
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

    func move(_ input: MoveGardenPlanting) async -> Bool {
        await save { try await self.service.moveGardenPlanting(input) }
    }

    func split(_ input: SplitGardenPlanting) async -> Bool {
        await save { _ = try await self.service.splitGardenPlanting(input) }
    }

    func finish(id: String, on date: Date) async -> Bool {
        await save { try await self.service.finishGardenPlanting(id: id, finishedAt: date) }
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

    func updatePlanting(_ input: EditGardenPlanting) async -> Bool {
        await save { try await self.service.updateGardenPlanting(input) }
    }

    func loadEntries() async { entries = (try? await service.gardenEntries()) ?? [] }

    func updateEntry(_ input: EditGardenEntry) async -> Bool {
        await save { try await self.service.updateGardenEntry(input) }
    }

    private func save(_ operation: () async throws -> Void) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            try await operation()
            await load()
            return true
        } catch {
            saveError = Self.message(for: error)
            return false
        }
    }

    private static func message(for error: any Error) -> String {
        (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
    }
}
