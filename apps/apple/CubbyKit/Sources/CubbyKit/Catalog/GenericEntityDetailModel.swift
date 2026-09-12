import Observation

/// Drives a generic Browse detail screen for one `EntityDescriptor` and one row id.
@MainActor
@Observable
public final class GenericEntityDetailModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        /// The HTTP document exposes no detail route for this entity.
        case unavailable(String)
        case failed(String)
    }

    public let descriptor: EntityDescriptor
    public private(set) var row: EntityRow?
    public private(set) var phase: Phase = .idle

    private let client: CubbyClient

    public init(descriptor: EntityDescriptor, client: CubbyClient) {
        self.descriptor = descriptor
        self.client = client
    }

    /// Loads one row by id. Never issues a request for an entity the document has no `get` route
    /// for — see `GenericEntityListModel.load` on why `httpActions` is the authority.
    public func load(id: String) async {
        guard descriptor.key.httpActions.contains(.get) else {
            phase = .unavailable("No detail route for \(descriptor.singular)")
            return
        }
        phase = .loading
        do {
            row = try await client.row(descriptor, id: id)
            phase = row == nil ? .failed("No \(descriptor.singular) called \(id)") : .loaded
        } catch {
            phase = .failed(GenericEntityListModel.describe(error))
        }
    }
}
