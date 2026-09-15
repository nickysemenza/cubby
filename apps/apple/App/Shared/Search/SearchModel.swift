import CubbyKit
import Foundation
import Observation

/// Screen state for Search: debounced text search grouped by entity kind, recents for the empty
/// state, and the code panel a submitted shortcode/barcode/link resolves into.
@MainActor
@Observable
final class SearchModel {
    struct ResultGroup: Identifiable, Equatable {
        let key: EntityKey
        let hits: [SearchHit]
        var id: EntityKey { key }
    }

    enum Phase: Equatable {
        case idle
        case searching
        case results([ResultGroup])
        case empty
        case failed(String)
    }

    struct RecentRow: Identifiable, Equatable {
        let key: EntityKey
        let row: EntityRow
        var id: String { row.id }
    }

    var query = "" {
        didSet {
            guard query != oldValue else { return }
            invalidateCurrentWork()
            debouncer.send(query)
        }
    }
    var scope: EntityKey? {
        didSet {
            guard scope != oldValue else { return }
            invalidateCurrentWork()
            debouncer.send(query)
        }
    }
    private(set) var phase: Phase = .idle
    private(set) var recents: [RecentRow] = []
    var lookupOutcome: LookupOutcome?

    private let client: CubbyClient
    private let debouncer = SearchDebouncer()
    private var watchTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    private var lookupTask: Task<LookupOutcome, Never>?
    private var searchGeneration = 0
    private var lookupGeneration = 0
    private var hasStarted = false

    init(client: CubbyClient) {
        self.client = client
    }

    isolated deinit {
        watchTask?.cancel()
        searchTask?.cancel()
        lookupTask?.cancel()
    }

    #if DEBUG
        init(client: CubbyClient, previewPhase: Phase, previewRecents: [RecentRow] = []) {
            self.client = client
            self.phase = previewPhase
            self.recents = previewRecents
        }
    #endif

    /// Starts one watcher and loads recents once. Returning from detail therefore preserves the
    /// current query, scope, results, and scroll-driving row identity.
    func start() async {
        if watchTask == nil {
            let values = debouncer.values()
            watchTask = Task { [weak self] in
                for await text in values {
                    guard let self else { return }
                    self.scheduleSearch(text)
                }
            }
        }
        guard !hasStarted else { return }
        hasStarted = true
        await loadRecents()
    }

    func stop() {
        watchTask?.cancel()
        watchTask = nil
        searchTask?.cancel()
        searchTask = nil
        lookupTask?.cancel()
        lookupTask = nil
    }

    /// Retries the current query immediately instead of waiting for another edit/debounce cycle.
    func retry() {
        invalidateSearch()
        scheduleSearch(query)
    }

    func refreshRecents() async {
        await loadRecents()
    }

    /// Resolves the current field as a Cubby link or barcode. Editing either query dimension
    /// cancels the lookup and prevents its late result from navigating or replacing the panel.
    func submit() async -> LookupOutcome {
        let raw = query
        lookupTask?.cancel()
        lookupGeneration += 1
        let generation = lookupGeneration
        let client = client
        lookupTask = Task {
            do {
                return try await CodeLookup(service: client).resolve(raw)
            } catch is CancellationError {
                return .text(raw)
            } catch {
                Diagnostics.report(error, context: "search.submit")
                return .text(raw)
            }
        }

        let outcome = await lookupTask!.value
        guard generation == lookupGeneration, raw == query else { return .text(query) }
        lookupTask = nil
        switch outcome {
        case .products(let rows, _) where rows.count > 1:
            lookupOutcome = outcome
        case .unknownCode:
            lookupOutcome = outcome
        default:
            lookupOutcome = nil
        }
        return outcome
    }

    private func scheduleSearch(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, text == query else { return }
        let requestedScope = scope
        let generation = searchGeneration
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            await self?.runSearch(trimmed, scope: requestedScope, generation: generation)
        }
    }

    private func runSearch(_ text: String, scope: EntityKey?, generation: Int) async {
        do {
            let hits = try await client.search(text, kinds: scope.map { [$0] }, limit: 30)
            try Task.checkCancellation()
            guard generation == searchGeneration else { return }
            phase = hits.isEmpty ? .empty : .results(Self.group(hits))
            searchTask = nil
        } catch is CancellationError {
            // A later query or scope owns the visible result.
        } catch {
            guard generation == searchGeneration else { return }
            Diagnostics.report(error, context: "search.query")
            phase = .failed((error as? CubbyAPIError)?.detail?.message ?? String(describing: error))
            searchTask = nil
        }
    }

    private func invalidateCurrentWork() {
        lookupOutcome = nil
        lookupTask?.cancel()
        lookupTask = nil
        lookupGeneration += 1
        invalidateSearch()
    }

    private func invalidateSearch() {
        searchTask?.cancel()
        searchTask = nil
        searchGeneration += 1
        phase = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .idle : .searching
    }

    private static func group(_ hits: [SearchHit]) -> [ResultGroup] {
        let byKey = Dictionary(grouping: hits, by: \.key)
        return EntityCatalog.intentExposed.compactMap { descriptor in
            byKey[descriptor.key].map { ResultGroup(key: descriptor.key, hits: $0) }
        }
    }

    private func loadRecents() async {
        var rows: [RecentRow] = []
        for id in RecentEntities.ids().prefix(10) {
            guard let descriptor = EntityCatalog.descriptor(forShortcode: id) else { continue }
            if let row = try? await client.row(descriptor, id: id) {
                rows.append(RecentRow(key: descriptor.key, row: row))
            }
        }
        recents = rows
    }
}
