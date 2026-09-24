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
    private(set) var missingBins: [LocationTreeNode]?
    private(set) var checkingMissing = false
    private(set) var seenBins: Set<LocationCode> = []
    private(set) var missingError: String?
    private var tree: LocationTree?

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
        seenBins.removeAll()
        missingBins = nil
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
            locations = page.items.map { LocationOption(id: $0.id, name: $0.name, path: $0.parent?.name) }
            tree = try await client.locationTree()
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
        if let label = CubbyLabel(value), label.key == .location {
            let code = LocationCode(label.code)
            if let anchor = session.location, tree?.parent(of: code)?.id == anchor {
                seenBins.insert(code)
                missingBins = nil
                return
            }
            select(LocationOption(id: LocationCode(label.code), name: label.code, path: nil))
            return
        }
        session.submit(value)
    }

    func submitManualEntry() {
        submit(manualEntry)
        manualEntry = ""
    }

    /// Absence is reviewed only after the person closes the sweep explicitly.
    func checkMissing() async {
        guard let anchor = session.location else { return }
        checkingMissing = true
        defer { checkingMissing = false }
        do {
            let fresh = try await client.locationTree()
            tree = fresh
            missingBins = (fresh[anchor]?.childNodes ?? []).filter { child in
                !seenBins.contains(child.id)
                    && (child._type == nil || child._type == .box || child._type == .bag
                        || child._type == .planter)
            }
            missingError = nil
        } catch {
            missingError = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
        }
    }

    func moveMissing(_ id: LocationCode, to parent: LocationCode) async {
        guard let anchor = session.location, parent != anchor, id != parent else { return }
        do {
            _ = try await client.bulkUpdateParent([id], to: parent)
            missingBins?.removeAll { $0.id == id }
            tree = try await client.locationTree()
            missingError = nil
        } catch {
            missingError = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
        }
    }

    func sendMissingToUnknown(_ id: LocationCode) async {
        do {
            let unknown = try await client.ensureGlobalUnknownLocation()
            await moveMissing(id, to: unknown)
        } catch {
            missingError = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
        }
    }
}
