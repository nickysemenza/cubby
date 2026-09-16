import CubbyKit
import Foundation
import Observation

/// The garden overview, its picker options and the guides document: what `GardenRootView` and
/// the planting guide slot read. Every planting and entry write is a generic resource operation;
/// the four workflow verbs live in `GardenActionsModel`.
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

    init(service: any GardenService) {
        self.service = service
    }

    /// One `GardenModel` per garden service instance, shared by `GardenRootView` and the planting
    /// guide slot instead of each screen re-fetching the overview, options, and guides.
    /// `SectionView`'s `.navigationDestination(for: Route.self)` sits as a *sibling* of the
    /// section root, not an ancestor of it, so an `.environment(_:)` value set inside
    /// `GardenRootView` cannot reach a pushed `Route` destination — this keyed cache is the
    /// substitute for that one path.
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
    /// first's fetch. A prior failure retries, since `.failed` means the data never landed.
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

    func guide(forKey key: String) -> GardenGuide? {
        guides.guides.first(where: { $0.key == key })
    }

    func guideSource(id: String) -> GardenGuideSource? {
        guides.sources.first(where: { $0.id == id })
    }

    func refresh() async {
        await load()
    }

    private static func message(for error: any Error) -> String {
        (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
    }
}
