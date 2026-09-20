import Foundation

/// A bounded, value-only explanation of a photo match decision. Callers snapshot their grid
/// state before analysis; this type never reads a photo library, store, or server.
public struct PhotoMatchDiagnosticReport: Codable, Sendable {
    /// Immutable caller-owned state captured before any diagnostic reads begin.
    public struct InitialSnapshot: Codable, Sendable {
        public let state: String
        public let registeredQuery: HashQuery?
        public let capturedAt: Date
        public let localIdentifier: String?
        public let assetModificationDate: Date?
        public let assetWidth: Int?
        public let assetHeight: Int?
        public let coverage: String?
        public let serverError: String?
        public let totalCount: Int?
        public let remainingCount: Int?

        public init(
            state: String, registeredQuery: HashQuery? = nil, capturedAt: Date = .now,
            localIdentifier: String? = nil,
            assetModificationDate: Date? = nil, assetWidth: Int? = nil, assetHeight: Int? = nil,
            coverage: String? = nil, serverError: String? = nil, totalCount: Int? = nil,
            remainingCount: Int? = nil
        ) {
            self.state = state
            self.registeredQuery = registeredQuery
            self.capturedAt = capturedAt
            self.localIdentifier = localIdentifier
            self.assetModificationDate = assetModificationDate
            self.assetWidth = assetWidth
            self.assetHeight = assetHeight
            self.coverage = coverage
            self.serverError = serverError
            self.totalCount = totalCount
            self.remainingCount = remainingCount
        }
    }

    /// Both original and actual values are retained because thumbnail generation and file
    /// materialization can transform dimensions or bytes before their hashes are computed.
    public struct HashInput: Codable, Sendable {
        public let actualHash: PerceptualHash64?
        public let originalHash: PerceptualHash64?
        public let width: Int?
        public let height: Int?
        public let originalWidth: Int?
        public let originalHeight: Int?
        public let sha256: String?
        public let aspectRatio: Double?
        public let originalAspectRatio: Double?
        /// The ratio production matching uses: original dimensions when available, otherwise the
        /// actual raster dimensions. `aspectRatio` remains the actual-raster diagnostic value.
        public let productionAspectRatio: Double?

        public init(
            actualHash: PerceptualHash64?, originalHash: PerceptualHash64? = nil,
            width: Int?, height: Int?, originalWidth: Int? = nil, originalHeight: Int? = nil,
            sha256: String? = nil
        ) {
            self.actualHash = actualHash
            self.originalHash = originalHash
            self.width = width
            self.height = height
            self.originalWidth = originalWidth
            self.originalHeight = originalHeight
            self.sha256 = sha256
            let actualRatio = HashIndex.ratio(width: width, height: height)
            let originalRatio = HashIndex.ratio(width: originalWidth, height: originalHeight)
            aspectRatio = actualRatio
            originalAspectRatio = originalRatio
            productionAspectRatio = originalRatio ?? actualRatio
        }
    }

    public struct Inputs: Codable, Sendable {
        public let file: HashInput
        public let thumbnail: HashInput
        public let materialized: HashInput

        public init(file: HashInput, thumbnail: HashInput, materialized: HashInput) {
            self.file = file
            self.thumbnail = thumbnail
            self.materialized = materialized
        }
    }

    public enum ReadStatus: String, Codable, Sendable { case notAttempted, success, partial, failure }

    public struct CacheRead: Codable, Sendable {
        public let status: ReadStatus
        public let perceptualHash: PerceptualHash64?
        public let revision: Int?
        public let message: String?
        public let modificationDate: Date?

        public init(
            status: ReadStatus, perceptualHash: PerceptualHash64? = nil, revision: Int? = nil,
            message: String? = nil, modificationDate: Date? = nil
        ) {
            self.status = status
            self.perceptualHash = perceptualHash
            self.revision = revision
            self.message = message
            self.modificationDate = modificationDate
        }
    }

    /// This is deliberately separate from `loadedServerEntries`: it records the result of a
    /// diagnostic GET, whereas the latter is the index snapshot the grid was already using.
    public struct ServerIndexRead: Codable, Sendable {
        public let status: ReadStatus
        public let algorithmRevision: Int?
        public let entries: [ImageHashEntry]
        public let message: String?

        public init(
            status: ReadStatus, algorithmRevision: Int? = nil, entries: [ImageHashEntry] = [],
            message: String? = nil
        ) {
            self.status = status
            self.algorithmRevision = algorithmRevision
            self.entries = entries
            self.message = message
        }
    }

    public struct Issue: Codable, Sendable {
        public enum Stage: String, Codable, Sendable {
            case cacheRead, loadedIndex, freshIndex, hashInput, evaluation
            case permission, thumbnail, materialization, cancelled, export
        }
        public let stage: Stage
        public let message: String

        public init(stage: Stage, message: String) {
            self.stage = stage
            self.message = message
        }
    }

    public struct PairEvaluation: Codable, Sendable {
        public let distance: Int
        public let verdict: PhotoMatchVerdict
    }

    public struct EntryEvaluation: Codable, Sendable {
        public enum IndexSource: String, Codable, Sendable { case loaded, fresh }
        public let indexSource: IndexSource
        public let entry: ImageHashEntry
        public let selectedBecauseCandidate: Bool
        public let selectedBecauseExpectedOwner: Bool
        public let registeredQueryToContent: PairEvaluation?
        public let registeredSourceToContent: PairEvaluation?
        public let registeredSourceToSource: PairEvaluation?
        public let registeredQueryToSource: PairEvaluation?
        public let thumbnailToContent: PairEvaluation?
        public let materializedToContent: PairEvaluation?
        public let materializedToSource: PairEvaluation?
        public let thumbnailToSource: PairEvaluation?
    }

    public let initial: InitialSnapshot
    public var inputs: Inputs
    public var cacheRead: CacheRead
    public var candidates: [DedupCandidate]
    public var loadedServerEntries: [ImageHashEntry]
    public var freshServerIndex: ServerIndexRead
    public var expectedOwnerShortcode: String?
    public var entries: [EntryEvaluation]
    public var issues: [Issue]
    public var thumbnailToMaterializedDistance: Int?
    public var cachedToThumbnailDistance: Int?
    public var cachedToMaterializedDistance: Int?

    public init(
        initial: InitialSnapshot,
        inputs: Inputs,
        cacheRead: CacheRead = .init(status: .notAttempted),
        candidates: [DedupCandidate] = [],
        loadedServerEntries: [ImageHashEntry] = [],
        freshServerIndex: ServerIndexRead = .init(status: .notAttempted),
        expectedOwnerShortcode: String? = nil,
        entries: [EntryEvaluation] = [],
        issues: [Issue] = []
    ) {
        self.initial = initial
        self.inputs = inputs
        self.cacheRead = cacheRead
        self.candidates = candidates
        self.loadedServerEntries = loadedServerEntries
        self.freshServerIndex = freshServerIndex
        self.expectedOwnerShortcode = expectedOwnerShortcode
        self.entries = entries
        self.issues = issues
    }
}

public enum PhotoMatchDiagnostics {
    /// Includes candidate entries plus direct entries owned by `expectedOwnerShortcode`, even when
    /// all four comparisons reject them. This exposes owner-filtering mistakes without widening
    /// production matching.
    public static func report(
        initial: PhotoMatchDiagnosticReport.InitialSnapshot,
        inputs: PhotoMatchDiagnosticReport.Inputs,
        cacheRead: PhotoMatchDiagnosticReport.CacheRead = .init(status: .notAttempted),
        candidates: [DedupCandidate] = [],
        loadedServerEntries: [ImageHashEntry] = [],
        freshServerIndex: PhotoMatchDiagnosticReport.ServerIndexRead = .init(status: .notAttempted),
        expectedOwnerShortcode: String? = nil,
        issues: [PhotoMatchDiagnosticReport.Issue] = []
    ) -> PhotoMatchDiagnosticReport {
        evaluate(
            .init(
                initial: initial, inputs: inputs, cacheRead: cacheRead, candidates: candidates,
                loadedServerEntries: loadedServerEntries, freshServerIndex: freshServerIndex,
                expectedOwnerShortcode: expectedOwnerShortcode, issues: issues))
    }

    /// Recomputes only derived matching evidence. All caller-captured metadata and partial
    /// failures are copied unchanged, making it safe to invoke after any diagnostic stage.
    public static func evaluate(
        _ report: PhotoMatchDiagnosticReport
    ) -> PhotoMatchDiagnosticReport {
        let candidateIDs = Set(report.candidates.map(\.id))
        let allEntries = report.loadedServerEntries + report.freshServerIndex.entries
        let freshCandidateIDs = freshCandidates(
            entries: allEntries, thumbnail: report.inputs.thumbnail, materialized: report.inputs.materialized)
        let owner = report.expectedOwnerShortcode?.trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        let ownerIDs = Set(
            allEntries.filter { entry in
                owner.map { !$0.isEmpty && entry.directOwnerShortcodes.contains($0) } == true
            }.map(\.id))
        let selectedIDs = candidateIDs.union(freshCandidateIDs).union(ownerIDs)
        // Keep both versions of the same image: a fresh GET must not erase the grid's evidence.
        let indexed: [(PhotoMatchDiagnosticReport.EntryEvaluation.IndexSource, ImageHashEntry)] =
            report.loadedServerEntries.map { (.loaded, $0) }
            + report.freshServerIndex.entries.map { (.fresh, $0) }
        let selected = indexed.filter { selectedIDs.contains($0.1.id) }.sorted {
            if $0.0 != $1.0 { return $0.0 == .loaded }
            return $0.1.id.rawValue < $1.1.id.rawValue
        }
        let evaluations: [PhotoMatchDiagnosticReport.EntryEvaluation] = selected.map { indexSource, entry in
            let entryRatio = HashIndex.ratio(width: entry.width, height: entry.height)
            func evaluate(
                _ input: PhotoMatchDiagnosticReport.HashInput, against target: PerceptualHash64?,
                rightRatio: Double?, leftRatio: Double? = nil
            )
                -> PhotoMatchDiagnosticReport.PairEvaluation?
            {
                guard let hash = input.actualHash, let target else { return nil }
                let distance = hash.distance(to: target)
                return .init(
                    distance: distance,
                    verdict: PhotoMatchVerdict.evaluate(
                        distance: distance, leftAspectRatio: leftRatio ?? input.productionAspectRatio,
                        rightAspectRatio: rightRatio))
            }
            return .init(
                indexSource: indexSource,
                entry: entry,
                selectedBecauseCandidate: candidateIDs.contains(entry.id),
                selectedBecauseExpectedOwner: ownerIDs.contains(entry.id),
                registeredQueryToContent: report.initial.registeredQuery.flatMap {
                    let input = PhotoMatchDiagnosticReport.HashInput(
                        actualHash: $0.perceptualHash, width: nil, height: nil)
                    return evaluate(
                        input, against: entry.perceptualHash, rightRatio: entryRatio,
                        leftRatio: $0.aspectRatio)
                },
                registeredSourceToContent: report.initial.registeredQuery?.sourceFingerprint.flatMap {
                    let input = PhotoMatchDiagnosticReport.HashInput(
                        actualHash: $0.hash, width: nil, height: nil,
                        originalWidth: nil, originalHeight: nil)
                    return evaluate(
                        input, against: entry.perceptualHash, rightRatio: entryRatio,
                        leftRatio: $0.aspectRatio)
                },
                registeredSourceToSource: report.initial.registeredQuery?.sourceFingerprint.flatMap {
                    let input = PhotoMatchDiagnosticReport.HashInput(
                        actualHash: $0.hash, width: nil, height: nil)
                    return evaluate(
                        input, against: entry.sourceFingerprint?.hash,
                        rightRatio: entry.sourceFingerprint?.aspectRatio, leftRatio: $0.aspectRatio)
                },
                registeredQueryToSource: report.initial.registeredQuery.flatMap {
                    let input = PhotoMatchDiagnosticReport.HashInput(
                        actualHash: $0.perceptualHash, width: nil, height: nil)
                    return evaluate(
                        input, against: entry.sourceFingerprint?.hash,
                        rightRatio: entry.sourceFingerprint?.aspectRatio, leftRatio: $0.aspectRatio)
                },
                thumbnailToContent: evaluate(
                    report.inputs.thumbnail,
                    against: entry.perceptualHash, rightRatio: entryRatio),
                materializedToContent: evaluate(
                    report.inputs.materialized,
                    against: entry.perceptualHash, rightRatio: entryRatio),
                materializedToSource: entry.sourceFingerprint.flatMap { source in
                    evaluate(report.inputs.materialized, against: source.hash, rightRatio: source.aspectRatio)
                },
                thumbnailToSource: entry.sourceFingerprint.flatMap { source in
                    evaluate(report.inputs.thumbnail, against: source.hash, rightRatio: source.aspectRatio)
                })
        }
        var evaluated = report
        evaluated.entries = evaluations
        if let thumbnail = report.inputs.thumbnail.actualHash,
            let materialized = report.inputs.materialized.actualHash
        {
            evaluated.thumbnailToMaterializedDistance = thumbnail.distance(to: materialized)
        }
        evaluated.cachedToThumbnailDistance = report.inputs.thumbnail.actualHash.flatMap { hash in
            report.cacheRead.perceptualHash.map { $0.distance(to: hash) }
        }
        evaluated.cachedToMaterializedDistance = report.inputs.materialized.actualHash.flatMap { hash in
            report.cacheRead.perceptualHash.map { $0.distance(to: hash) }
        }
        return evaluated
    }

    private static func freshCandidates(
        entries: [ImageHashEntry], thumbnail: PhotoMatchDiagnosticReport.HashInput,
        materialized: PhotoMatchDiagnosticReport.HashInput
    ) -> Set<ImageCode> {
        guard let index = try? HashIndex(entries: entries) else { return [] }
        return Set(
            [thumbnail, materialized].flatMap { input -> [ImageCode] in
                guard let hash = input.actualHash else { return [] }
                let query = HashQuery(perceptualHash: hash, aspectRatio: input.productionAspectRatio ?? 0)
                return index.candidates(for: query).map(\.id)
            })
    }
}
