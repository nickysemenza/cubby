import Foundation
import Observation

/// The state machine shared by every native entity-list search surface.
///
/// This model deliberately knows nothing about an entity, its filters, or its row projection.
/// Callers provide one loader that composes those concerns on the server. Keeping the loader at
/// this boundary also makes debounce, cancellation, and stale-result behavior testable without a
/// network client or a clock that actually waits.
@MainActor
@Observable
public final class EntityListSearchModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case debouncing
        case loading
        case loaded
        case failed(String)
    }

    public typealias PageLoader =
        @Sendable (_ query: String, _ page: Int) async throws
        -> ListPage<EntityRow>
    public typealias Sleeper = @Sendable (_ nanoseconds: UInt64) async throws -> Void

    public private(set) var query = ""
    public private(set) var rows: [EntityRow] = []
    public private(set) var meta: ListPageMeta?
    public private(set) var page = 1
    public private(set) var phase: Phase = .idle
    public private(set) var nextPageError: String?

    public var hasMore: Bool {
        guard let meta else { return false }
        return page * meta.pageSize < meta.totalCount
    }

    private let debounceNanoseconds: UInt64
    private var loader: PageLoader
    private let sleeper: Sleeper
    private var requestTask: Task<Void, Never>?
    private var requestGeneration = 0

    public init(
        debounceNanoseconds: UInt64 = 250_000_000,
        sleeper: @escaping Sleeper = { nanoseconds in
            try await Task.sleep(nanoseconds: nanoseconds)
        },
        loader: @escaping PageLoader
    ) {
        self.debounceNanoseconds = debounceNanoseconds
        self.sleeper = sleeper
        self.loader = loader
    }

    /// Starts a debounced search. A newer value cancels the old debounce/request; the generation
    /// guard still protects against loaders that do not promptly observe cancellation.
    public func setQuery(_ rawQuery: String) {
        let normalized = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized != query else { return }

        requestTask?.cancel()
        requestTask = nil
        requestGeneration += 1
        query = normalized
        nextPageError = nil

        guard !normalized.isEmpty else {
            rows = []
            meta = nil
            page = 1
            phase = .idle
            return
        }

        // The screen identifies the visible list as this query's result. Do not leave an older
        // query's rows visible during debounce/loading, especially for chooser flows where a tap
        // has a side effect.
        rows = []
        meta = nil
        page = 1
        startSearch(query: normalized)
    }

    /// Retries the current query after an initial request error. This is intentionally separate
    /// from `setQuery` so a retry button can recover without requiring a meaningless text edit.
    public func retry() {
        guard !query.isEmpty else { return }
        requestTask?.cancel()
        requestGeneration += 1
        nextPageError = nil
        startSearch(query: query)
    }

    /// Rebinds the request to a changed relationship/date/status scope. The active query is
    /// replayed against the new scope; an idle search stays idle until the next query.
    public func setLoader(_ loader: @escaping PageLoader) {
        self.loader = loader
        guard !query.isEmpty else { return }
        requestTask?.cancel()
        requestGeneration += 1
        nextPageError = nil
        startSearch(query: query)
    }

    private func startSearch(query: String) {
        let generation = requestGeneration
        phase = .debouncing
        let sleeper = sleeper
        let delay = debounceNanoseconds
        requestTask = Task { [weak self] in
            do {
                try await sleeper(delay)
                try Task.checkCancellation()
                guard let self else { return }
                await self.loadFirstPage(query: query, generation: generation)
            } catch is CancellationError {
                // A newer query owns the visible state.
            } catch {
                guard let self else { return }
                self.failInitial(error, generation: generation)
            }
        }
    }

    /// Clears the query and all search results. The owning list keeps its unsearched projection,
    /// so clearing can restore the prior shelf/timeline state without another request.
    public func clear() {
        setQuery("")
    }

    /// Pages the active query. A failed page leaves the already loaded rows and page untouched.
    public func loadNextPage() async {
        guard !query.isEmpty, phase == .loaded, hasMore else { return }
        let generation = requestGeneration
        let nextPage = page + 1
        nextPageError = nil
        phase = .loading
        do {
            let result = try await loader(query, nextPage)
            guard generation == requestGeneration else { return }
            if Task.isCancelled {
                phase = .loaded
                return
            }
            var ids = Set(rows.map(\.id))
            rows.append(contentsOf: result.items.filter { ids.insert($0.id).inserted })
            page = nextPage
            meta = result.meta
            phase = .loaded
        } catch is CancellationError {
            guard generation == requestGeneration else { return }
            phase = .loaded
        } catch {
            guard generation == requestGeneration else { return }
            nextPageError = Self.describe(error)
            phase = .loaded
        }
    }

    private func loadFirstPage(query: String, generation: Int) async {
        guard generation == requestGeneration, self.query == query else { return }
        phase = .loading
        do {
            let result = try await loader(query, 1)
            guard generation == requestGeneration, self.query == query, !Task.isCancelled else {
                return
            }
            rows = result.items
            meta = result.meta
            page = 1
            phase = .loaded
        } catch is CancellationError {
            // A newer query owns the visible state.
        } catch {
            failInitial(error, generation: generation)
        }
    }

    private func failInitial(_ error: Error, generation: Int) {
        guard generation == requestGeneration else { return }
        phase = .failed(Self.describe(error))
    }

    private static func describe(_ error: Error) -> String {
        if let apiError = error as? CubbyAPIError {
            let code = apiError.detail?.code ?? "HTTP_\(apiError.status)"
            let message = apiError.detail?.message ?? "Request failed"
            return "\(code): \(message)"
        }
        return String(describing: error)
    }
}
