import CubbyKit
import Foundation
import Observation

/// A planting-specific, paged activity stream. Failed guide or overview work never prevents this
/// independent journal from retrying.
@MainActor @Observable
final class GardenJournalModel {
    private let service: any GardenService
    let planting: GardenPlanting
    private(set) var entries: [GardenJournalEntry] = []
    private(set) var hasMore = false
    private(set) var isLoading = false
    private(set) var error: String?
    private var nextPage = 1
    private var pendingRefresh = false
    private var failedPage = 1
    private var failedReplacing = true
    var includeBedContext = true { didSet { Task { await refresh() } } }

    init(service: any GardenService, planting: GardenPlanting) {
        self.service = service; self.planting = planting
    }

    func loadMore() async {
        guard !isLoading, hasMore || entries.isEmpty else { return }
        await request(page: nextPage, replacing: false)
    }

    func refresh() async {
        guard !isLoading else { pendingRefresh = true; return }
        await request(page: 1, replacing: true)
    }

    func retry() async { await request(page: failedPage, replacing: failedReplacing) }

    private func request(page: Int, replacing: Bool) async {
        guard !isLoading else { return }
        isLoading = true; error = nil
        defer {
            isLoading = false
            if pendingRefresh { pendingRefresh = false; Task { await refresh() } }
        }
        do {
            let result = try await service.gardenJournal(
                plantingID: planting.id, includeBedContext: includeBedContext, page: page)
            let existingIDs = replacing ? Set<String>() : Set(entries.map { $0.entry.id })
            entries = (replacing ? [] : entries) + result.items.filter { !existingIDs.contains($0.entry.id) }
            hasMore = result.hasMore
            nextPage = page + 1
        } catch {
            failedPage = page
            failedReplacing = replacing
            self.error = error.localizedDescription
        }
    }
}

@MainActor @Observable
final class GardenLocationHistoryModel {
    private let service: any GardenService
    let planting: GardenPlanting
    private(set) var periods: [GardenLocationPeriod] = []
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var error: String?

    init(service: any GardenService, planting: GardenPlanting) {
        self.service = service
        self.planting = planting
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        defer { isLoading = false }
        do { periods = try await service.gardenLocationHistory(plantingID: planting.id) } catch {
            self.error = error.localizedDescription
        }
    }

    func save(_ revised: [GardenLocationPeriod]) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            periods = try await service.correctGardenLocationDates(plantingID: planting.id, periods: revised)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}
