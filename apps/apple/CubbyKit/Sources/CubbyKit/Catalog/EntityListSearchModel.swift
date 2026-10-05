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
    private var coreRows: [EntityRow] = []
    public var rows: [EntityRow] { enrichment?.project(coreRows) ?? coreRows }
    public let enrichment: EntityListEnrichmentModel?
    public private(set) var meta: ListPageMeta?
    public private(set) var page = 1
    public private(set) var phase: Phase = .idle
    public private(set) var refreshError: String?
    public private(set) var nextPageError: String?

    public var hasMore: Bool {
        guard let meta else { return false }
        return page * meta.pageSize < meta.totalCount
    }

    /// Metadata is only presented as current while its last refresh succeeded.
    public var summaryMeta: ListPageMeta? {
        guard phase == .loaded, refreshError == nil else { return nil }
        guard var meta else { return nil }
        if enrichment?.isLoadingSummary == true || enrichment?.summaryError != nil {
            meta.sums = nil
            return meta
        }
        guard let sums = enrichment?.sums else { return meta }
        meta.sums = .init(additionalProperties: sums)
        return meta
    }

    private let debounceNanoseconds: UInt64
    private var loader: PageLoader
    private let sleeper: Sleeper
    private var requestTask: Task<Void, Never>?
    private var requestGeneration = 0

    public init(
        descriptor: EntityDescriptor? = nil,
        debounceNanoseconds: UInt64 = 250_000_000,
        sleeper: @escaping Sleeper = { nanoseconds in
            try await Task.sleep(nanoseconds: nanoseconds)
        },
        loader: @escaping PageLoader
    ) {
        self.enrichment = descriptor.map { EntityListEnrichmentModel(descriptor: $0) }
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
        coreRows = rows
        enrichment?.invalidate()
        query = normalized
        refreshError = nil
        nextPageError = nil

        guard !normalized.isEmpty else {
            coreRows = []
            meta = nil
            page = 1
            phase = .idle
            return
        }

        // The screen identifies the visible list as this query's result. Do not leave an older
        // query's rows visible during debounce/loading, especially for chooser flows where a tap
        // has a side effect.
        coreRows = []
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
        coreRows = rows
        enrichment?.invalidate()
        refreshError = nil
        nextPageError = nil
        startSearch(query: query)
    }

    /// Rebinds the request to a changed relationship/date/status scope. The active query is
    /// replayed against the new scope; an idle search stays idle until the next query. A filtered
    /// Browse list keeps the previous rows visible while replaying; a chooser whose candidate set
    /// changed passes `discardingRows` so no row from the old scope stays tappable.
    public func setLoader(_ loader: @escaping PageLoader, discardingRows: Bool = false) {
        self.loader = loader
        meta = nil
        guard !query.isEmpty else { return }
        requestTask?.cancel()
        requestGeneration += 1
        coreRows = discardingRows ? [] : rows
        enrichment?.invalidate()
        refreshError = nil
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

    /// Reloads page one for the visible query without clearing the rows already on screen. A
    /// failed refresh keeps those rows available and exposes a retryable error beside them.
    public func refresh() async {
        guard !query.isEmpty else { return }
        requestTask?.cancel()
        requestTask = nil
        requestGeneration += 1
        coreRows = rows
        enrichment?.invalidate()
        let generation = requestGeneration
        refreshError = nil
        nextPageError = nil
        phase = .loading
        do {
            let result = try await loader(query, 1)
            guard generation == requestGeneration, !Task.isCancelled else { return }
            coreRows = result.items
            meta = result.meta
            page = 1
            enrichment?.accept(result, replacing: true)
            phase = .loaded
        } catch is CancellationError {
            guard generation == requestGeneration else { return }
            phase = rows.isEmpty ? .idle : .loaded
        } catch {
            guard generation == requestGeneration else { return }
            if rows.isEmpty {
                failInitial(error, generation: generation)
            } else {
                refreshError = error.userMessage
                phase = .loaded
            }
        }
    }

    /// Pages the active query. A failed page leaves the already loaded rows and page untouched.
    public func loadNextPage() async {
        guard !query.isEmpty, phase == .loaded, hasMore else { return }
        let generation = requestGeneration
        let nextPage = page + 1
        refreshError = nil
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
            coreRows.append(contentsOf: result.items.filter { ids.insert($0.id).inserted })
            page = nextPage
            meta = result.meta
            enrichment?.accept(result, replacing: false)
            phase = .loaded
        } catch is CancellationError {
            guard generation == requestGeneration else { return }
            phase = .loaded
        } catch {
            guard generation == requestGeneration else { return }
            nextPageError = error.userMessage
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
            coreRows = result.items
            meta = result.meta
            page = 1
            enrichment?.accept(result, replacing: true)
            phase = .loaded
        } catch is CancellationError {
            // A newer query owns the visible state.
        } catch {
            failInitial(error, generation: generation)
        }
    }

    private func failInitial(_ error: Error, generation: Int) {
        guard generation == requestGeneration else { return }
        phase = .failed(error.userMessage)
    }
}
