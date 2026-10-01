import Observation

/// Presentation tasks adapted from generated wire values. These are model inputs, not a second
/// wire schema; only the generated client decodes HTTP response bodies.
public struct EntityListDeferred: Sendable {
    public struct Group: Sendable, Hashable {
        public let id: String
        public let fields: [String]
        public init(id: String, fields: [String]) { self.id = id; self.fields = fields }
    }
    public typealias Enricher =
        @Sendable (_ ids: [String], _ groups: [String]) async throws -> [EntityListGroupResult]
    public typealias SummaryLoader = @Sendable () async throws -> [String: Double]?

    public let groups: [Group]
    let enrich: Enricher
    let summary: SummaryLoader

    public init(groups: [Group], enrich: @escaping Enricher, summary: @escaping SummaryLoader) {
        self.groups = groups
        self.enrich = enrich
        self.summary = summary
    }
}

public enum EntityListGroupResult: Sendable {
    case ready(id: String, rows: [JSONValue])
    case failed(id: String, message: String)
}

/// Shares group replacement, retries, summary isolation, and stale completion guards across
/// Browse and list-backed search. Core ownership/pagination remain in their existing models.
@MainActor
@Observable
public final class EntityListEnrichmentModel {
    public private(set) var sums: [String: Double]?
    public private(set) var summaryError: String?
    public private(set) var isLoadingSummary = false

    public var errors: [String] {
        Array(
            Set(
                states.values.flatMap { groups in
                    groups.values.compactMap { state in
                        if case .failed(let message) = state { return message }
                        return nil
                    }
                })
        ).sorted()
    }

    private enum State { case pending, ready, failed(String) }
    private struct Request {
        let ids: [String]
        let deferred: EntityListDeferred
    }
    private let descriptor: EntityDescriptor
    private var generation = 0
    private var requests: [Int: Request] = [:]
    private var states: [String: [String: State]] = [:]
    private var fields: [String: [String]] = [:]
    private var patches: [String: [String: JSONValue]] = [:]
    private var tasks: [Task<Void, Never>] = []
    private var enrichmentTail: Task<Void, Never>?
    private var summaryTask: Task<Void, Never>?
    private var summaryLoader: EntityListDeferred.SummaryLoader?

    public init(descriptor: EntityDescriptor) { self.descriptor = descriptor }

    public func invalidate() {
        generation += 1
        for task in tasks { task.cancel() }
        summaryTask?.cancel()
        tasks = []
        enrichmentTail = nil
        summaryTask = nil
        requests = [:]
        states = [:]
        fields = [:]
        patches = [:]
        sums = nil
        summaryError = nil
        summaryLoader = nil
        isLoadingSummary = false
    }

    public func accept(_ page: ListPage<EntityRow>, replacing: Bool) {
        if replacing { invalidate() }
        guard let deferred = page.deferred else { return }
        let request = Request(ids: page.items.map(\.id), deferred: deferred)
        requests[page.meta.pageIndex] = request
        for group in deferred.groups { fields[group.id] = group.fields }
        startEnrichment(request, groups: deferred.groups.map(\.id))
        if replacing {
            summaryLoader = deferred.summary
            startSummary()
        }
    }

    /// Each ready group replaces all its owned keys. This preserves explicit null semantics even
    /// when generated Codable optionals omit null while re-encoding a typed patch.
    public func project(_ rows: [EntityRow]) -> [EntityRow] {
        rows.map { row in
            var raw = row.raw.objectValue ?? [:]
            var pending = Set<String>()
            var failed = Set<String>()
            for (group, state) in states[row.id] ?? [:] {
                let owned = fields[group] ?? []
                switch state {
                case .pending: pending.formUnion(owned)
                case .failed: failed.formUnion(owned)
                case .ready:
                    for key in owned { raw.removeValue(forKey: key) }
                    for (key, value) in patches[row.id]?[group]?.objectValue ?? [:]
                    where key != "id" && owned.contains(key) { raw[key] = value }
                }
            }
            let projected = descriptor.row(from: .object(raw)) ?? row
            return EntityRow(
                id: projected.id, title: projected.title, subtitle: projected.subtitle,
                imageURL: projected.imageURL, raw: projected.raw,
                pendingFields: pending, failedFields: failed)
        }
    }

    public func retry() {
        for request in requests.values {
            let failed = request.deferred.groups.compactMap { group -> String? in
                request.ids.contains { id in
                    if case .failed = states[id]?[group.id] { return true }
                    return false
                } ? group.id : nil
            }
            if !failed.isEmpty { startEnrichment(request, groups: failed) }
        }
        if summaryError != nil { startSummary() }
    }

    /// Deterministic completion boundary for focused native concurrency tests.
    func waitForBackground() async {
        for task in tasks { await task.value }
        await summaryTask?.value
    }

    private func startEnrichment(_ request: Request, groups: [String]) {
        guard !groups.isEmpty, !request.ids.isEmpty else { return }
        let current = generation
        for id in request.ids {
            for group in groups { states[id, default: [:]][group] = .pending }
        }
        // A model performs at most one enrichment batch and one summary call concurrently.
        let previous = enrichmentTail
        let task = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled else { return }
            do {
                let results = try await request.deferred.enrich(request.ids, groups)
                guard let self, self.generation == current, !Task.isCancelled else { return }
                var byID: [String: EntityListGroupResult] = [:]
                for result in results {
                    switch result {
                    case .ready(let id, _), .failed(let id, _): byID[id] = result
                    }
                }
                for group in groups {
                    for id in request.ids {
                        switch byID[group] {
                        case .ready(_, let rows):
                            guard let patch = rows.first(where: { $0["id"]?.stringValue == id }) else {
                                self.states[id, default: [:]][group] = .failed(
                                    "Record is no longer available")
                                continue
                            }
                            self.patches[id, default: [:]][group] = patch
                            self.states[id, default: [:]][group] = .ready
                        case .failed(_, let message):
                            self.states[id, default: [:]][group] = .failed(message)
                        case nil:
                            self.states[id, default: [:]][group] = .failed(
                                "Missing enrichment group: \(group)")
                        }
                    }
                }
            } catch {
                guard let self, self.generation == current, !Task.isCancelled else { return }
                for id in request.ids {
                    for group in groups {
                        self.states[id, default: [:]][group] = .failed(error.userMessage)
                    }
                }
            }
        }
        enrichmentTail = task
        tasks.append(task)
    }

    private func startSummary() {
        guard let loader = summaryLoader else { return }
        summaryTask?.cancel()
        let current = generation
        summaryError = nil
        isLoadingSummary = true
        summaryTask = Task { [weak self] in
            do {
                let result = try await loader()
                guard let self, self.generation == current, !Task.isCancelled else { return }
                self.sums = result
                self.isLoadingSummary = false
            } catch {
                guard let self, self.generation == current, !Task.isCancelled else { return }
                self.summaryError = error.userMessage
                self.isLoadingSummary = false
            }
        }
    }
}
