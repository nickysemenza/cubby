import CubbyKit
import Foundation
import Observation

/// Screen state for Capture: which location is being swept, the locations to pick from, and the
/// `ScanSession` doing the work. Created per client, so a base URL change gets a fresh one.
@Observable
final class CaptureModel {
    struct LocationOption: Identifiable, Hashable {
        let id: LocationCode
        let name: String
        let path: String?
    }

    let session: ScanSession
    private(set) var locations: [LocationOption] = []
    private(set) var loadingLocations = false
    var manualEntry = ""
    var locationError: String?

    private let client: CubbyClient

    init(client: CubbyClient) {
        self.client = client
        self.session = ScanSession(service: client)
    }

    var location: LocationOption? {
        guard let code = session.location else { return nil }
        return locations.first { $0.id == code } ?? LocationOption(id: code, name: code.rawValue, path: nil)
    }

    func select(_ location: LocationOption?) {
        session.location = location?.id
    }

    /// Selects by shortcode (deep links, intents). Unknown ids leave the selection alone.
    func select(id: LocationCode) {
        if let option = locations.first(where: { $0.id == id }) { select(option) }
    }

    func loadLocations() async {
        guard !loadingLocations else { return }
        loadingLocations = true
        defer { loadingLocations = false }
        do {
            let page = try await client.locationOptions(page: 1, pageSize: 200)
            locations = page.items.map { LocationOption(id: $0.id, name: $0.name, path: $0.path) }
            locationError = nil
        } catch {
            locationError = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
            Diagnostics.report(error, context: "capture.locations")
        }
    }

    /// Manual entry and the camera both land here. A location label switches the sweep target
    /// instead of being scanned as stock, which is what the web sweep's bin path does too.
    func submit(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        if let label = Shortcode.extract(from: value), label.key == .location {
            select(LocationOption(id: LocationCode(label.code), name: label.code, path: nil))
            return
        }
        session.submit(value)
    }

    func submitManualEntry() {
        submit(manualEntry)
        manualEntry = ""
    }
}
