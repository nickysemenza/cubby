import CubbyKit
import Foundation
import Observation

/// Reads one just-added Location photo for items and lets each be approved into inventory.
/// Detection persists nothing; only an approved row writes.
@MainActor @Observable
final class LocationDetectionModel {
    enum Phase: Equatable {
        case detecting
        case ready
        case failed(String)
    }

    enum RowState: Equatable {
        case pending
        case approving
        case approved(created: Bool)
        case failed(String)
    }

    struct Row: Identifiable {
        let id: Int
        let item: DetectedItem
        var state: RowState = .pending
    }

    private(set) var phase: Phase = .detecting
    private(set) var rows: [Row] = []
    private(set) var summary = ""

    let locationID: LocationCode
    let locationTitle: String
    private let imageID: ImageCode
    private let client: CubbyClient

    init(client: CubbyClient, locationID: LocationCode, locationTitle: String, imageID: ImageCode) {
        self.client = client
        self.locationID = locationID
        self.locationTitle = locationTitle
        self.imageID = imageID
    }

    func detect() async {
        phase = .detecting
        do {
            let result = try await client.detectInventoryItems(
                .init(locationId: locationID, imageIds: [imageID]))
            rows = result.items.enumerated().map { Row(id: $0.offset, item: $0.element) }
            summary = result.summary
            phase = .ready
        } catch is CancellationError {
        } catch {
            phase = .failed(error.userMessage)
            Diagnostics.report(error, context: "photo.detect")
        }
    }

    func approve(_ id: Int) async {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        switch rows[index].state {
        case .pending, .failed: break
        case .approving, .approved: return
        }
        let detected = rows[index].item
        rows[index].state = .approving
        do {
            let out = try await client.approveDetectedInventoryItem(
                .init(
                    locationId: locationID,
                    item: .init(
                        name: detected.name, manufacturer: detected.manufacturer,
                        estimatedQuantity: detected.estimatedQuantity, unit: detected.unit,
                        confidence: detected.confidence, evidence: detected.evidence,
                        isMisc: detected.isMisc),
                    productId: detected.matchedProduct?.id))
            update(id, .approved(created: out.createdProduct))
        } catch {
            update(id, .failed(error.userMessage))
            Diagnostics.report(error, context: "photo.detect.approve")
        }
    }

    private func update(_ id: Int, _ state: RowState) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[index].state = state
    }
}
