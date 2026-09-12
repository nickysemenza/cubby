import Observation

/// Drives a generic Browse list screen for one `EntityDescriptor`. There is one of these per
/// entity key rather than per-entity view models, because the catalog already carries everything
/// needed to fetch and project a page.
@MainActor
@Observable
public final class GenericEntityListModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        /// The HTTP document exposes no list route for this entity (cookbook, usda-food, image).
        case unavailable(String)
        case failed(String)
    }

    public let descriptor: EntityDescriptor
    public private(set) var rows: [EntityRow] = []
    public private(set) var meta: PageMeta?
    public private(set) var phase: Phase = .idle
    public private(set) var page: Int = 1

    private let client: CubbyClient
    private let pageSize: Int

    public init(descriptor: EntityDescriptor, client: CubbyClient, pageSize: Int = 50) {
        self.descriptor = descriptor
        self.client = client
        self.pageSize = pageSize
    }

    /// Loads one page of rows. Never issues a request for an entity the document does not list —
    /// the phase goes straight to `.unavailable` instead. `EntityKey.httpActions` is the
    /// authority here, not `descriptor.actions`: the kernel roster can declare an action the
    /// HTTP document has no route for (`image` has `list` there but not here).
    public func load(page: Int = 1) async {
        guard descriptor.key.httpActions.contains(.list) else {
            phase = .unavailable("No list route for \(descriptor.plural)")
            return
        }
        phase = .loading
        do {
            let result = try await client.list(descriptor, page: page, pageSize: pageSize)
            self.page = page
            rows = result.items
            meta = result.meta
            phase = .loaded
        } catch {
            phase = .failed(GenericEntityListModel.describe(error))
        }
    }

    static func describe(_ error: Error) -> String {
        if let apiError = error as? CubbyAPIError {
            let code = apiError.detail?.code ?? "HTTP_\(apiError.status)"
            let message = apiError.detail?.message ?? "Request failed"
            return "\(code): \(message)"
        }
        return String(describing: error)
    }
}
