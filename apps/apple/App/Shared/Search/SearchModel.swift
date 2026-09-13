import CubbyKit
import Foundation
import Observation

/// Screen state for Search: debounced text search grouped by entity kind, recents for the empty
/// state, and the code panel a submitted shortcode/barcode/link resolves into. Created per host,
/// mirroring `CaptureModel`/`IdentifyModel`.
@MainActor
@Observable
final class SearchModel {
    /// One kind's hits, in the order `EntityCatalog.intentExposed` declares — not arrival order.
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

    /// A recent entity plus the kind it opens as — `EntityRow` alone doesn't carry that, and a
    /// recent can be any intent-exposed kind, not just a product.
    struct RecentRow: Identifiable, Equatable {
        let key: EntityKey
        let row: EntityRow
        var id: String { row.id }
    }

    var query = "" {
        didSet {
            guard query != oldValue else { return }
            // A resolved code panel only describes the query that produced it; typing again
            // (even to narrow a multi-product match) goes back to plain search.
            lookupOutcome = nil
            debouncer.send(query)
        }
    }
    var scope: EntityKey? {
        didSet {
            // A scope change is a new search over the same text; it rides the same debounce.
            guard scope != oldValue else { return }
            debouncer.send(query)
        }
    }
    private(set) var phase: Phase = .idle
    private(set) var recents: [RecentRow] = []
    /// Set by `submit()` when the field held a shortcode, label URL, `cubby://` link, or barcode
    /// that needs more than a plain navigation: several products, or none at all. `SearchView`
    /// renders this as an inline panel in place of the ordinary result list.
    var lookupOutcome: LookupOutcome?

    private let client: CubbyClient
    private let debouncer = SearchDebouncer()
    private var watchTask: Task<Void, Never>?
    /// Guards against a slow earlier request overwriting a faster later one.
    private var generation = 0

    init(client: CubbyClient) {
        self.client = client
    }

    /// Starts the debounced watch loop and loads recents. Idempotent — safe to call from
    /// `.task(id:)`, which re-runs whenever the host changes.
    func start() async {
        if watchTask == nil {
            watchTask = Task { [weak self] in
                guard let self else { return }
                for await text in self.debouncer.values() {
                    await self.runSearch(text)
                }
            }
        }
        await loadRecents()
    }

    func stop() {
        watchTask?.cancel()
        watchTask = nil
    }

    /// Reloads recents; wired to `.refreshControl` since there is nothing else on this screen to
    /// pull-to-refresh.
    func refreshRecents() async {
        await loadRecents()
    }

    /// Runs `CodeLookup` against the current field text: a pasted shortcode, label URL,
    /// `cubby://` link, or barcode resolves directly instead of falling through to text search.
    /// `.text` is not distinguished from a lookup failure here — either way the caller's ordinary
    /// search (already running from `query`'s debounced watch) is what answers it.
    func submit() async -> LookupOutcome {
        let raw = query
        do {
            let outcome = try await CodeLookup(service: client).resolve(raw)
            switch outcome {
            case .products(let rows, _) where rows.count > 1:
                lookupOutcome = outcome
            case .unknownCode:
                lookupOutcome = outcome
            default:
                lookupOutcome = nil
            }
            return outcome
        } catch {
            Diagnostics.report(error, context: "search.submit")
            lookupOutcome = nil
            return .text(raw)
        }
    }

    private func runSearch(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            phase = .idle
            return
        }
        phase = .searching
        generation += 1
        let thisGeneration = generation
        do {
            let hits = try await client.search(trimmed, kinds: scope.map { [$0] }, limit: 30)
            guard thisGeneration == generation else { return }
            phase = hits.isEmpty ? .empty : .results(Self.group(hits))
        } catch {
            guard thisGeneration == generation else { return }
            Diagnostics.report(error, context: "search.query")
            phase = .failed((error as? CubbyAPIError)?.detail?.message ?? String(describing: error))
        }
    }

    private static func group(_ hits: [SearchHit]) -> [ResultGroup] {
        let byKey = Dictionary(grouping: hits, by: \.key)
        return EntityCatalog.intentExposed.compactMap { descriptor in
            byKey[descriptor.key].map { ResultGroup(key: descriptor.key, hits: $0) }
        }
    }

    /// Best-effort: an id `RecentEntities` still remembers but the server no longer has (deleted,
    /// or from a different host) is silently skipped rather than shown as an error.
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
