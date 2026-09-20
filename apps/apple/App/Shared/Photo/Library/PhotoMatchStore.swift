import CoreGraphics
import CubbyKit
import Foundation
import Observation

/// Read-only data for the photo inspector. The root reads analysis-cache state separately; this
/// transient server-match store does not reach into `PhotoAnalysisStore`.
struct PhotoMatchInspectorSnapshot: Sendable {
    let capturedAt: Date
    let gridState: PhotoGridCellState
    let registeredQuery: HashQuery?
    let candidates: [DedupCandidate]
    let entries: [ImageHashEntry]
    let entriesLoaded: Int
    let totalEntries: Int
    let remainingEntries: Int
    let hasIndex: Bool
    let isLoading: Bool
    let checked: Bool
    let coverage: String
    let serverError: String?
    /// A photo-local hash/download failure, distinct from a failed server index refresh.
    let matchError: String?
}

@Observable
final class PhotoMatchStore {
    private(set) var hasIndex = false
    private(set) var isLoading = false
    private(set) var isRepairing = false
    private(set) var totalCount = 0
    private(set) var remainingCount = 0
    private(set) var error: String?
    private(set) var repairFailures = 0
    private(set) var candidates: [String: [DedupCandidate]] = [:]
    /// Compact direct-owner data from the hash index, keyed by Cubby image
    /// shortcode. A grid photo resolves through its already-loaded match list,
    /// so rendering never issues one request per cell.
    private(set) var directOwnersByImageID: [String: [String]] = [:]
    private(set) var revision = 0
    /// Bumped by `markAnalysis`, coalesced (at most once per second or per 50 photos, whichever
    /// first) rather than once per photo like `revision` used to be. `.task(id:)` category-filter
    /// reloads and the "N of M analysed" caption key off this instead, so a background sweep
    /// classifying thousands of photos does not force those to refetch/re-render per photo.
    private(set) var classifiedRevision = 0

    @ObservationIgnored private var entries: [ImageCode: ImageHashEntry] = [:]
    @ObservationIgnored private var queries: [String: HashQuery] = [:]
    @ObservationIgnored private var serverCandidates: [String: [DedupCandidate]] = [:]
    @ObservationIgnored private var batchCandidates: [String: [DedupCandidate]] = [:]
    @ObservationIgnored private var entriesRevision = 0
    @ObservationIgnored private var repairTask: Task<Void, Never>?
    @ObservationIgnored private var loadingTask: Task<Void, Never>?
    @ObservationIgnored private var registrationTask: Task<Void, Never>?
    @ObservationIgnored private var pendingQueries: [String: HashQuery] = [:]
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var accountGeneration = UUID()
    @ObservationIgnored private var observers: Set<UUID> = []
    /// Mirrors `PhotoLibraryStore.checked` for the ids this store has been asked about, so
    /// `PhotoGridCellState.derive` can tell "no match, confirmed" from "not looked at yet" without
    /// this store reading the library's set directly (which would reintroduce a whole-collection
    /// dependency for every cell).
    @ObservationIgnored private var checkedIDs: Set<String> = []
    @ObservationIgnored private var checkingIDs: Set<String> = []
    @ObservationIgnored private var cancelledCheckIDs: Set<String> = []
    @ObservationIgnored private var matchErrorsByID: [String: String] = [:]
    @ObservationIgnored private var cellStateBoxes: [String: PhotoGridCellStateBox] = [:]
    /// Populated by `PhotoLibraryStore`'s batch read on refresh and by the classification sweep as
    /// it finishes each photo (B4's grid dot; developer overlays layer 1's timing/label). Absent
    /// means "not looked at yet by either path".
    @ObservationIgnored private var analysisByID: [String: PhotoAssetSnapshot] = [:]
    @ObservationIgnored private var uncoalescedClassifiedCount = 0
    @ObservationIgnored private var lastClassifiedRevisionBump = Date.distantPast

    var coverage: String {
        if error != nil {
            return hasIndex
                ? "Cubby could not be refreshed. Showing previously known matches."
                : "Cubby could not be checked. Photos remain unchecked."
        }
        if !hasIndex { return isLoading ? "Checking Cubby…" : "Cubby has not been checked" }
        if remainingCount == 0 { return "Checked \(totalCount) Cubby images" }
        return
            "Checked \(totalCount - remainingCount) of \(totalCount) Cubby images. More matches may appear."
    }

    func storedCandidates(for id: String) -> [DedupCandidate] {
        (candidates[id] ?? []).filter { !$0.id.rawValue.hasPrefix("draft:") }
    }

    func hasKnownResult(for id: String) -> Bool {
        hasIndex && candidates[id] != nil
    }

    func ownerBadge(for id: String) -> String? {
        PhotoGridBadge.text(for: strongDirectOwnerShortcodes(for: id))
    }

    func ownerAccessibilityDescription(for id: String) -> String? {
        PhotoGridBadge.accessibilityDescription(for: strongDirectOwnerShortcodes(for: id))
    }

    /// Direct owners backed by a strong local fingerprint match. Borrowed display
    /// images never enter the server summaries, and possible matches remain review-only.
    func strongDirectOwnerShortcodes(for id: String) -> [String] {
        storedCandidates(for: id)
            .filter { $0.confidence == .strong }
            .flatMap { directOwnersByImageID[$0.id.rawValue] ?? [] }
    }

    func possibleDirectOwnerShortcodes(for id: String) -> [String] {
        storedCandidates(for: id)
            .filter { $0.confidence == .possible }
            .flatMap { directOwnersByImageID[$0.id.rawValue] ?? [] }
    }

    func directOwnerShortcodes(for imageID: ImageCode) -> [String] {
        directOwnersByImageID[imageID.rawValue] ?? []
    }

    /// Replaces one index snapshot's ownership summaries atomically. The API
    /// adapter passes only direct associations; no cell should fetch detail.
    func setDirectOwnerShortcodes(_ summaries: [String: [String]]) {
        directOwnersByImageID = summaries
        revision += 1
        publishCellStates(for: cellStateBoxes.keys)
    }

    /// The per-id, `@Observable` box a grid cell reads instead of this store's dictionaries
    /// directly. Marks `id` checked-so-far as "unknown" the first time it is asked about, then
    /// `markChecked`/`registerBatch`/`refresh` refine it in place as real results arrive.
    func cellStateBox(for id: String) -> PhotoGridCellStateBox {
        if let box = cellStateBoxes[id] { return box }
        let box = PhotoGridCellStateBox(state: computeCellState(for: id))
        cellStateBoxes[id] = box
        return box
    }

    /// Takes a value snapshot for inspector rendering. It deliberately does not register a query,
    /// refresh the server index, or touch the analysis cache.
    func inspectorSnapshot(for localIdentifier: String) -> PhotoMatchInspectorSnapshot {
        PhotoMatchInspectorSnapshot(
            capturedAt: .now,
            gridState: computeCellState(for: localIdentifier),
            registeredQuery: queries[localIdentifier],
            candidates: storedCandidates(for: localIdentifier),
            entries: entries.values.sorted { $0.id.rawValue < $1.id.rawValue },
            entriesLoaded: entries.count,
            totalEntries: totalCount,
            remainingEntries: remainingCount,
            hasIndex: hasIndex,
            isLoading: isLoading,
            checked: checkedIDs.contains(localIdentifier),
            coverage: coverage,
            serverError: error,
            matchError: matchErrorsByID[localIdentifier] ?? error)
    }

    /// Starts local/cloud fingerprint preparation for one photo before a `HashQuery` exists.
    func markChecking(for id: String) {
        checkingIDs.insert(id)
        cancelledCheckIDs.remove(id)
        matchErrorsByID[id] = nil
        publishCellState(for: id)
    }

    /// Publishes a photo-local preparation failure without discarding a prior positive match.
    func markUnavailable(for id: String, message: String) {
        checkingIDs.remove(id)
        cancelledCheckIDs.remove(id)
        matchErrorsByID[id] = message
        publishCellState(for: id)
    }

    /// Ends preparation neutrally: cancellation is neither a failure nor a known no-match.
    func markCheckCancelled(for id: String) {
        checkingIDs.remove(id)
        cancelledCheckIDs.insert(id)
        matchErrorsByID[id] = nil
        publishCellState(for: id)
    }

    /// Called by `PhotoLibraryStore` right before it hands a batch to `register`/`registerBatch`,
    /// so the resulting cell state reads "known: no match" rather than "not checked" as soon as
    /// that batch's match results publish, instead of lagging behind the library's own `checked`
    /// set (which updates only after the async match round trip returns).
    func markChecked(_ ids: some Sequence<String>) {
        for id in ids where !checkedIDs.contains(id) {
            checkedIDs.insert(id)
            checkingIDs.insert(id)
            cancelledCheckIDs.remove(id)
            matchErrorsByID[id] = nil
            publishCellState(for: id)
        }
    }

    /// Publishes a batch of analysis snapshots into the per-id cell state (B4's grid dot; developer
    /// overlays layer 1's timing/label). Each cell's own box (`publishCellStates` below) updates
    /// immediately regardless of batch size — this call site is the only observer that needs a
    /// per-photo signal. `revision` itself is left untouched (a sweep classifying thousands of
    /// photos one at a time must not force every observer keyed on it — the ownership filter cache,
    /// the grid's `FilteredMonthAssetsCache` — to invalidate and re-render per photo); the coalesced
    /// `classifiedRevision` below is what the category chip filter and "N of M analysed" caption
    /// key off instead.
    func markAnalysis(_ snapshots: [String: PhotoAssetSnapshot]) {
        guard !snapshots.isEmpty else { return }
        for (id, snapshot) in snapshots { analysisByID[id] = snapshot }
        publishCellStates(for: snapshots.keys)
        uncoalescedClassifiedCount += snapshots.count
        let now = Date()
        guard uncoalescedClassifiedCount >= 50 || now.timeIntervalSince(lastClassifiedRevisionBump) >= 1
        else { return }
        classifiedRevision += 1
        uncoalescedClassifiedCount = 0
        lastClassifiedRevisionBump = now
    }

    private func computeCellState(for id: String) -> PhotoGridCellState {
        let snapshot = analysisByID[id]
        let stored = storedCandidates(for: id)
        let hasPositiveMatch = !stored.isEmpty
        let matchError = matchErrorsByID[id] ?? error
        return PhotoGridCellState.derive(
            storedCandidates: stored,
            strongDirectOwnerShortcodes: strongDirectOwnerShortcodes(for: id),
            possibleDirectOwnerShortcodes: possibleDirectOwnerShortcodes(for: id),
            hasKnownResult: hasKnownResult(for: id) && (matchError == nil || hasPositiveMatch),
            isPending: !cancelledCheckIDs.contains(id)
                && (checkingIDs.contains(id) || queries[id] != nil || isLoading),
            indexIsComplete: hasIndex && remainingCount == 0 && !isRepairing,
            serverError: matchError,
            analysis: snapshot?.status ?? .pending,
            classifyMs: snapshot?.classifyMs,
            topLabel: snapshot?.topLabels.max(by: { $0.confidence < $1.confidence })?.identifier)
    }

    private func publishCellState(for id: String) {
        guard let box = cellStateBoxes[id] else { return }
        box.state = computeCellState(for: id)
    }

    private func publishCellStates(for ids: some Sequence<String>) {
        for id in ids { publishCellState(for: id) }
    }

    func acquire(_ id: UUID) {
        observers.insert(id)
        schedulePendingRegistrations()
    }

    func release(_ id: UUID) {
        observers.remove(id)
        if observers.isEmpty {
            repairTask?.cancel()
            registrationTask?.cancel()
            registrationTask = nil
        }
    }

    func reset() {
        accountGeneration = UUID()
        generation = UUID()
        repairTask?.cancel(); loadingTask?.cancel(); registrationTask?.cancel()
        repairTask = nil; loadingTask = nil; registrationTask = nil
        entries = [:]; queries = [:]
        pendingQueries = [:]
        serverCandidates = [:]; batchCandidates = [:]; candidates = [:]
        directOwnersByImageID = [:]
        checkedIDs = []; checkingIDs = []; cancelledCheckIDs = []; matchErrorsByID = [:]
        cellStateBoxes = [:]
        analysisByID = [:]
        uncoalescedClassifiedCount = 0; lastClassifiedRevisionBump = .distantPast
        entriesRevision += 1
        hasIndex = false; isLoading = false; isRepairing = false
        totalCount = 0; remainingCount = 0; repairFailures = 0; error = nil
        observers = []
        revision += 1
        classifiedRevision += 1
    }

    func refresh(client: CubbyClient, priorityIDs: Set<String>? = nil) async {
        if let loadingTask { await loadingTask.value; return }
        repairTask?.cancel(); registrationTask?.cancel()
        isRepairing = false
        registrationTask = nil
        let token = UUID()
        generation = token
        let task = Task { [weak self] in
            guard let self, generation == token, !Task.isCancelled else { return }
            isLoading = true; error = nil
            publishCellStates(for: cellStateBoxes.keys)
            do {
                let document = try await client.imageHashIndex()
                guard generation == token, !Task.isCancelled else { return }
                _ = try HashIndex(entries: [], algorithmRevision: document.algorithmRevision.rawValue)
                let items = try document.items.map(ImageHashEntry.init)
                entries = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
                directOwnersByImageID = Dictionary(
                    uniqueKeysWithValues: items.map { ($0.id.rawValue, $0.directOwnerShortcodes) })
                entriesRevision += 1
                totalCount = items.count
                remainingCount = document.repair.count
                hasIndex = true
                publishCellStates(for: cellStateBoxes.keys)
                let querySnapshot = queries.filter { priorityIDs?.contains($0.key) ?? true }
                let matched = try await Self.match(entries: items, queries: querySnapshot)
                guard generation == token, !Task.isCancelled else { return }
                publishServerMatches(matched, for: querySnapshot, replacing: true)
                pendingQueries = pendingQueries.filter { queries[$0.key] != $0.value }
                if let priorityIDs {
                    for (id, query) in queries where !priorityIDs.contains(id) {
                        pendingQueries[id] = query
                    }
                }
                revision += 1
                if !observers.isEmpty {
                    let repairs = document.repair.compactMap { row in
                        URL(string: row.url).map { (row.id, $0) }
                    }
                    repairTask = Task {
                        await self.repair(repairs, client: client, token: token)
                    }
                }
            } catch is CancellationError {} catch {
                guard generation == token else { return }
                self.error = error.localizedDescription
                Diagnostics.report(error, context: "photos.index")
                publishCellStates(for: cellStateBoxes.keys)
            }
        }
        loadingTask = task
        await task.value
        if generation == token {
            isLoading = false
            loadingTask = nil
            publishCellStates(for: cellStateBoxes.keys)
            schedulePendingRegistrations()
        }
    }

    func register(id: String, query: HashQuery) async {
        if queries[id] == query, hasKnownResult(for: id) {
            checkingIDs.remove(id)
            cancelledCheckIDs.remove(id)
            matchErrorsByID[id] = nil
            publishCellState(for: id)
            return
        }
        if queries[id] != query {
            serverCandidates[id] = nil
            batchCandidates[id] = nil
            candidates[id] = nil
        }
        queries[id] = query
        pendingQueries[id] = query
        checkingIDs.insert(id)
        cancelledCheckIDs.remove(id)
        matchErrorsByID[id] = nil
        publishCellState(for: id)
        schedulePendingRegistrations()
    }

    func registerBatch(_ additions: [String: HashQuery]) async {
        guard !additions.isEmpty else { return }
        for (id, query) in additions {
            if queries[id] != query {
                serverCandidates[id] = nil
                candidates[id] = nil
            }
            queries[id] = query
            checkingIDs.insert(id)
            cancelledCheckIDs.remove(id)
            matchErrorsByID[id] = nil
        }
        publishCellStates(for: additions.keys)
        guard hasIndex else { return }
        while !Task.isCancelled {
            let token = generation
            let entryVersion = entriesRevision
            let entrySnapshot = Array(entries.values)
            let querySnapshot = additions.filter { queries[$0.key] == $0.value }
            do {
                let matched = try await Self.match(entries: entrySnapshot, queries: querySnapshot)
                guard generation == token, !Task.isCancelled else { return }
                if entriesRevision != entryVersion { continue }
                publishServerMatches(matched, for: querySnapshot, replacing: true)
                revision += 1
                return
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    private func schedulePendingRegistrations() {
        guard registrationTask == nil, !pendingQueries.isEmpty else { return }
        let token = generation
        registrationTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(20))
            } catch {
                return
            }
            guard let self, generation == token, !Task.isCancelled else { return }
            let additions = Dictionary(
                uniqueKeysWithValues: pendingQueries.prefix(32).map { ($0.key, $0.value) })
            for id in additions.keys { pendingQueries[id] = nil }
            await registerBatch(additions)
            if generation == token {
                registrationTask = nil
                schedulePendingRegistrations()
            }
        }
    }

    func check(
        _ items: [PhotoSelectionItem], client: CubbyClient,
        preparedQueries: [String: HashQuery] = [:],
        refreshIndex: Bool = true,
        status: (String) -> Void = { _ in }
    ) async throws {
        let account = accountGeneration
        if refreshIndex || !hasIndex {
            status("Refreshing Cubby photos…")
            await refresh(client: client, priorityIDs: Set(items.map(\.id)))
        }
        guard accountGeneration == account, !Task.isCancelled else { throw CancellationError() }
        guard hasIndex, !refreshIndex || error == nil else {
            throw PhotoCheckFailure.indexUnavailable(error)
        }
        var batch: [ImageHashEntry] = []
        var additions: [String: HashQuery] = [:]
        for (offset, item) in items.enumerated() {
            status("Checking selected photo \(offset + 1) of \(items.count)…")
            let query: HashQuery
            if let prepared = preparedQueries[item.id] {
                query = prepared
            } else {
                query = try await item.query()
            }
            guard accountGeneration == account, !Task.isCancelled else { throw CancellationError() }
            additions[item.id] = query
            let previous = try await Self.match(entries: batch, queries: [item.id: query])[item.id] ?? []
            guard accountGeneration == account, !Task.isCancelled else { throw CancellationError() }
            batchCandidates[item.id] = previous
            // Draft codes only live in the review; they resolve to a prior item after its upload.
            batch.append(
                ImageHashEntry(
                    id: item.existingImageID ?? ImageCode("draft:\(item.id)"),
                    perceptualHash: query.perceptualHash, sourceFingerprint: query.sourceFingerprint,
                    width: item.preview.width, height: item.preview.height))
        }
        status("Comparing selected photos with Cubby…")
        await registerBatch(additions)
        guard accountGeneration == account, !Task.isCancelled else { throw CancellationError() }
    }

    /// `rows` are the images the server could not hash itself, with their source URLs.
    private func repair(_ rows: [(id: ImageCode, url: URL)], client: CubbyClient, token: UUID) async {
        guard generation == token, !Task.isCancelled, !rows.isEmpty else { return }
        isRepairing = true; repairFailures = 0
        defer {
            if generation == token {
                isRepairing = false
                publishCellStates(for: cellStateBoxes.keys)
            }
        }
        for offset in stride(from: 0, to: rows.count, by: 50) {
            guard !Task.isCancelled, generation == token else { return }
            let batch = Array(rows[offset..<min(offset + 50, rows.count)])
            let results = await Self.fetchHashes(batch)
            guard !Task.isCancelled, generation == token else { return }
            let updates = results.compactMap { $0.update }
            repairFailures += results.filter { $0.update == nil }.count
            guard !updates.isEmpty else { continue }
            do {
                let written = try await client.setPerceptualHashes(updates)
                guard !Task.isCancelled, generation == token else { return }
                var added: [ImageHashEntry] = []
                for update in written.items {
                    guard let old = entries[update.id] else { continue }
                    let entry = ImageHashEntry(
                        id: old.id, perceptualHash: try PerceptualHash64(hex: update.perceptualHash),
                        sourceFingerprint: old.sourceFingerprint, width: old.width, height: old.height,
                        directOwnerShortcodes: old.directOwnerShortcodes)
                    entries[old.id] = entry
                    added.append(entry)
                }
                entriesRevision += 1
                let querySnapshot = queries
                let matches = try await Self.match(entries: added, queries: querySnapshot)
                guard generation == token, !Task.isCancelled else { return }
                publishServerMatches(matches, for: querySnapshot, replacing: false)
                remainingCount = entries.values.filter { $0.perceptualHash == nil }.count
                publishCellStates(for: cellStateBoxes.keys)
                repairFailures += written.unavailable.count
                revision += 1
            } catch is CancellationError { return } catch {
                guard generation == token, !Task.isCancelled else { return }
                repairFailures += updates.count
                Diagnostics.report(error, context: "photos.repair")
            }
        }
    }

    nonisolated private static func merged(_ left: [DedupCandidate], _ right: [DedupCandidate])
        -> [DedupCandidate]
    {
        Array(Set(left + right)).sorted {
            if $0.confidence != $1.confidence { return $0.confidence == .strong }
            if $0.distance != $1.distance { return $0.distance < $1.distance }
            if $0.id != $1.id { return $0.id.rawValue < $1.id.rawValue }
            return $0.basis == .content && $1.basis == .source
        }
    }

    private func publishServerMatches(
        _ matches: [String: [DedupCandidate]],
        for querySnapshot: [String: HashQuery],
        replacing: Bool
    ) {
        var nextServerCandidates = serverCandidates
        var nextCandidates = candidates
        for (id, query) in querySnapshot where queries[id] == query {
            let found = matches[id] ?? []
            nextServerCandidates[id] =
                replacing
                ? found
                : Self.merged(nextServerCandidates[id] ?? [], found)
            nextCandidates[id] = Self.merged(
                nextServerCandidates[id] ?? [], batchCandidates[id] ?? [])
            checkedIDs.insert(id)
            checkingIDs.remove(id)
            cancelledCheckIDs.remove(id)
            matchErrorsByID[id] = nil
        }
        serverCandidates = nextServerCandidates
        candidates = nextCandidates
        publishCellStates(for: querySnapshot.keys)
    }

    nonisolated private static func match(
        entries: [ImageHashEntry], queries: [String: HashQuery]
    ) async throws -> [String: [DedupCandidate]] {
        let task = Task.detached(priority: .utility) {
            try Task.checkCancellation()
            let index = try HashIndex(entries: entries)
            var result: [String: [DedupCandidate]] = [:]
            result.reserveCapacity(queries.count)
            for (id, query) in queries {
                try Task.checkCancellation()
                result[id] = index.candidates(for: query)
            }
            return result
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    nonisolated private struct RepairResult: Sendable {
        let update: ImageHashUpdate?
    }

    nonisolated private static func fetchHashes(_ rows: [(id: ImageCode, url: URL)]) async -> [RepairResult] {
        await withTaskGroup(of: RepairResult.self) { group in
            var iterator = rows.makeIterator()
            func enqueue(_ row: (id: ImageCode, url: URL)) {
                group.addTask {
                    do {
                        try Task.checkCancellation()
                        let (file, response) = try await URLSession.cubbyShared.download(
                            from: ImageTransform.hashSource(row.url))
                        defer { try? FileManager.default.removeItem(at: file) }
                        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
                        else {
                            return RepairResult(update: nil)
                        }
                        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                        guard size > 0, size <= PhotoFile.maximumByteCount else {
                            return RepairResult(update: nil)
                        }
                        let hash = try PerceptualHash64.compute(fileURL: file)
                        return RepairResult(update: ImageHashUpdate(id: row.id, perceptualHash: hash))
                    } catch { return RepairResult(update: nil) }
                }
            }
            for _ in 0..<4 { if let row = iterator.next() { enqueue(row) } }
            var results: [RepairResult] = []
            for await result in group {
                results.append(result)
                if !Task.isCancelled, let row = iterator.next() { enqueue(row) }
            }
            return results
        }
    }
}

nonisolated enum PhotoCheckFailure: LocalizedError {
    case indexUnavailable(String?)
    var errorDescription: String? {
        switch self {
        case .indexUnavailable(let detail): detail ?? "Could not check Cubby. Please retry."
        }
    }
}
