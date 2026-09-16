import CubbyKit
import Foundation
import Observation

/// A planting's location periods and their date corrections (`garden.locationHistory` /
/// `garden.correctLocationDates`), independent of the planting's own detail load.
@MainActor @Observable
final class GardenLocationHistoryModel {
    private let service: any GardenService
    let plantingID: String
    private(set) var periods: [GardenLocationPeriodOut] = []
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var error: String?

    init(service: any GardenService, plantingID: String) {
        self.service = service
        self.plantingID = plantingID
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        defer { isLoading = false }
        do { periods = try await service.gardenLocationHistory(plantingID: plantingID) } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "garden.locationHistory.load")
        }
    }

    func save(_ revised: [GardenLocationPeriodOut]) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            periods = try await service.correctGardenLocationDates(plantingID: plantingID, periods: revised)
            return true
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "garden.locationHistory.save")
            return false
        }
    }
}
