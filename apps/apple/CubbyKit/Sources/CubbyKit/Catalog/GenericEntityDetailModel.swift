import Observation

/// Drives a generic Browse detail screen for one `EntityDescriptor` and one row id.
@MainActor
@Observable
public final class GenericEntityDetailModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        /// The descriptor has no `.get` action.
        case unavailable(String)
        case failed(String)
    }

    public let descriptor: EntityDescriptor
    public private(set) var row: EntityRow?
    public private(set) var phase: Phase = .idle

    private let client: CubbyRawClient

    public init(descriptor: EntityDescriptor, client: CubbyRawClient) {
        self.descriptor = descriptor
        self.client = client
    }

    /// Loads one row by id. Never issues a request for a descriptor without `.get` — the phase
    /// goes straight to `.unavailable` instead.
    public func load(id: String) async {
        guard descriptor.actions.contains(.get) else {
            phase = .unavailable("No detail route for \(descriptor.singular)")
            return
        }
        phase = .loading
        do {
            let object = try await client.get(basePath: descriptor.basePath, id: id)
            row = descriptor.row(from: object)
            phase = .loaded
        } catch {
            phase = .failed(GenericEntityListModel.describe(error))
        }
    }
}
