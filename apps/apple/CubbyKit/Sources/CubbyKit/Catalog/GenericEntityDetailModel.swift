import Foundation
import Observation

/// Drives a generic Browse detail screen for one `EntityDescriptor` and one row id.
@MainActor
@Observable
public final class GenericEntityDetailModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case unavailable(String)
        case failed(String)
    }

    public enum Activity: Equatable {
        case idle
        case loadingInitial
        case refreshing
    }

    public let descriptor: EntityDescriptor
    public private(set) var row: EntityRow?
    public private(set) var phase: Phase = .idle
    public private(set) var activity: Activity = .idle
    public private(set) var initialError: String?
    public private(set) var refreshError: String?
    /// When `row` was last fetched (developer overlays layer 4: "fetched-at + age"). Set on every
    /// successful initial load or refresh; left as-is on a failed refresh so the overlay still
    /// reports the age of the content actually on screen.
    public private(set) var fetchedAt: Date?

    private let client: CubbyClient
    private var loadedID: String?
    private var activeID: String?
    private var requestGeneration = 0
    private var requestTask: Task<EntityRow?, Error>?

    public init(descriptor: EntityDescriptor, client: CubbyClient) {
        self.descriptor = descriptor
        self.client = client
    }

    public func loadInitial(id: String) async {
        guard loadedID != id else { return }
        guard activity != .loadingInitial || activeID != id else { return }
        await request(id: id, retainingContent: false)
    }

    /// Refreshes the same record without blanking it. Passing another id starts a new detail load
    /// and immediately invalidates the old row.
    public func refresh(id: String) async {
        await request(id: id, retainingContent: loadedID == id && row != nil)
    }

    /// Compatibility for existing callers. Repeated loads of the same record are refreshes.
    public func load(id: String) async {
        if loadedID == id {
            await refresh(id: id)
        } else {
            await loadInitial(id: id)
        }
    }

    private func request(id: String, retainingContent: Bool) async {
        guard descriptor.key.nativeActions.contains(.get) else {
            cancelRequest()
            let message = "No detail route for \(descriptor.singular)"
            initialError = message
            phase = .unavailable(message)
            return
        }

        if !retainingContent {
            row = nil
            loadedID = nil
        }
        initialError = nil
        refreshError = nil
        activity = retainingContent ? .refreshing : .loadingInitial
        activeID = id
        if !retainingContent { phase = .loading }

        requestTask?.cancel()
        requestGeneration += 1
        let generation = requestGeneration
        let client = client
        let descriptor = descriptor
        requestTask = Task {
            try Task.checkCancellation()
            return try await client.row(descriptor, id: id)
        }

        do {
            let result = try await requestTask!.value
            guard generation == requestGeneration else { return }
            if let result {
                row = result
                loadedID = result.id
                phase = .loaded
                fetchedAt = Date()
            } else {
                let message = "No \(descriptor.singular) called \(id)"
                if retainingContent {
                    refreshError = message
                    phase = .loaded
                } else {
                    initialError = message
                    phase = .failed(message)
                }
            }
        } catch is CancellationError {
            // A newer id or refresh owns the state now.
        } catch {
            guard generation == requestGeneration else { return }
            let message = GenericEntityListModel.describe(error)
            if retainingContent {
                refreshError = message
                phase = .loaded
            } else {
                initialError = message
                phase = .failed(message)
            }
        }

        guard generation == requestGeneration else { return }
        requestTask = nil
        activeID = nil
        activity = .idle
    }

    private func cancelRequest() {
        requestTask?.cancel()
        requestTask = nil
        activeID = nil
        requestGeneration += 1
        activity = .idle
    }
}
