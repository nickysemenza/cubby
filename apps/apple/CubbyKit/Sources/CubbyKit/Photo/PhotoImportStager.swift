import Foundation

public enum PhotoImportDuplicateChoice: Sendable, Equatable {
    case automatic
    case reuse(ImageCode)
    case keepBoth
}

public struct PhotoImportBatchItem: Sendable {
    public let clientID: String
    public let file: PhotoFile
    public let analysis: PhotoLocalAnalysis
    public let routeID: String
    /// `nil` for a `createSelf` draft: there is no source record, and the created record's id is
    /// not known client-side, so the commit payload omits `source` entirely (server: `images[].source`
    /// is present iff the route is not `createSelf`).
    public let sourceEntity: EntityKey?
    public let sourceID: String?
    public let candidateID: String?
    public let createDraftID: String?
    public let createRouteID: String?
    public let createBody: [String: JSONValue]?
    public let createCapturedAt: Date?
    public let replaceConfirmed: Bool
    public let duplicateChoice: PhotoImportDuplicateChoice

    public init(
        clientID: String,
        file: PhotoFile,
        analysis: PhotoLocalAnalysis,
        routeID: String,
        sourceEntity: EntityKey,
        sourceID: String,
        candidateID: String,
        replaceConfirmed: Bool = false,
        duplicateChoice: PhotoImportDuplicateChoice = .automatic
    ) {
        self.clientID = clientID
        self.file = file
        self.analysis = analysis
        self.routeID = routeID
        self.sourceEntity = sourceEntity
        self.sourceID = sourceID
        self.candidateID = candidateID
        self.createDraftID = nil
        self.createRouteID = nil
        self.createBody = nil
        self.createCapturedAt = nil
        self.replaceConfirmed = replaceConfirmed
        self.duplicateChoice = duplicateChoice
    }

    /// A create draft's source is optional: `createRelated` drafts carry the referenced record,
    /// a `createSelf` draft (no source) passes `nil` for both.
    public init(
        clientID: String,
        file: PhotoFile,
        analysis: PhotoLocalAnalysis,
        routeID: String,
        sourceEntity: EntityKey?,
        sourceID: String?,
        draftID: String,
        draftRouteID: String,
        draftBody: [String: JSONValue],
        draftCapturedAt: Date?,
        replaceConfirmed: Bool = false,
        duplicateChoice: PhotoImportDuplicateChoice = .automatic
    ) {
        self.clientID = clientID
        self.file = file
        self.analysis = analysis
        self.routeID = routeID
        self.sourceEntity = sourceEntity
        self.sourceID = sourceID
        self.candidateID = nil
        self.createDraftID = draftID
        self.createRouteID = draftRouteID
        self.createBody = draftBody
        self.createCapturedAt = draftCapturedAt
        self.replaceConfirmed = replaceConfirmed
        self.duplicateChoice = duplicateChoice
    }
}

public enum PhotoImportTransactionProgress: Sendable, Equatable {
    case staging
    case uploading(completed: Int, total: Int)
    case committing
}

/// Runs the import's presign/upload phase and its single atomic commit. Successful staging is
/// retained so an explicit retry after a recoverable staging failure can continue without
/// uploading those bytes again. A commit response is not replayed automatically: if transport
/// fails after the request is sent, the caller must reconcile the staged IDs before deciding
/// whether to retry, especially when reused active images are involved.
public actor PhotoImportTransaction {
    public enum Failure: Error, LocalizedError, Sendable, Equatable {
        case unsupportedContentType(String)
        case stagingFailed([String])
        case invalidStageResponse(String)
        case commitNotApplied([ImageCode])
        case commitOutcomeUncertain([ImageCode])
        case commitInvariant([ImageCode])
        case stagedImagesExpired([ImageCode])

        public var errorDescription: String? {
            switch self {
            case .unsupportedContentType:
                "One or more photos use an unsupported file type."
            case .stagingFailed:
                "Some photos could not be staged. Your successful staged uploads were preserved."
            case .invalidStageResponse:
                "Cubby returned an invalid photo staging response."
            case .commitNotApplied:
                "Nothing was added. The staged photos are intact, so you can explicitly try again."
            case .commitOutcomeUncertain:
                "Cubby could not confirm whether every photo was added. Review the batch before trying again."
            case .commitInvariant:
                "Cubby found a mixed photo-import state and stopped to avoid creating duplicates."
            case .stagedImagesExpired:
                "The staged photos expired before they were added. Try again to stage fresh copies."
            }
        }
    }

    private struct Staged: Sendable {
        let imageID: ImageCode
        let reusedExisting: Bool
    }

    /// `CubbyAPIError.reason` values that mean "the staged image row no longer exists" rather
    /// than a definite rejection of this request's content (the wire `code` for both is the
    /// generic `BAD_REQUEST`/`PRECONDITION_FAILED`, so only `reason` distinguishes them).
    private static let staleStagedImageReasons: Set<String> = [
        "REFERENCED_RECORD_MISSING", "IMAGE_PRECONDITION_FAILED",
    ]

    private let client: CubbyClient
    private let put: PresignedUpload.FilePut
    private let maximumConcurrentUploads: Int
    private let idempotencyKey: String
    private var stagedByClientID: [String: Staged] = [:]
    private var committedClientIDs: [String]?

    public init(
        client: CubbyClient,
        idempotencyKey: String = UUID().uuidString,
        maximumConcurrentUploads: Int = 4,
        put: @escaping PresignedUpload.FilePut = {
            try await PresignedUpload.putFile($0, to: $1, contentType: $2)
        }
    ) {
        self.client = client
        self.idempotencyKey = idempotencyKey
        self.maximumConcurrentUploads = max(1, maximumConcurrentUploads)
        self.put = put
    }

    public func commit(
        _ items: [PhotoImportBatchItem],
        progress: (@Sendable (PhotoImportTransactionProgress) -> Void)? = nil
    ) async throws -> [String] {
        if let committedClientIDs { return committedClientIDs }
        try Task.checkCancellation()
        // A `.reuse` staged entry names an already-UPLOADED image; if the user then switches that
        // item to "keep both", resending the same id with `duplicateDecision: keepBoth` is a
        // guaranteed 412 forever. Drop it so `unstaged` below re-stages a fresh upload instead.
        // One direction only: `.keepBoth → .reuse(id)` is handled by the seed loop overwriting the
        // entry, and a `reusedExisting == false` (freshly uploaded) entry is never dropped here —
        // that would orphan a good staged upload.
        for item in items where item.duplicateChoice == .keepBoth {
            if stagedByClientID[item.clientID]?.reusedExisting == true {
                stagedByClientID.removeValue(forKey: item.clientID)
            }
        }
        for item in items {
            if case .reuse(let imageID) = item.duplicateChoice {
                stagedByClientID[item.clientID] = Staged(
                    imageID: imageID, reusedExisting: true)
            }
        }
        let unstaged = items.filter { stagedByClientID[$0.clientID] == nil }
        if !unstaged.isEmpty {
            progress?(.staging)
            try await stage(unstaged, progress: progress)
        }
        try Task.checkCancellation()
        progress?(.committing)
        let images = try items.map { item -> PhotoImportCommitImage in
            guard let staged = stagedByClientID[item.clientID] else {
                throw Failure.invalidStageResponse(item.clientID)
            }
            let source: PhotoImportSourcePayload?
            if let sourceEntity = item.sourceEntity, let sourceID = item.sourceID {
                guard
                    let payloadEntity = PhotoImportSourcePayload.EntityPayload(
                        rawValue: sourceEntity.rawValue)
                else {
                    throw Failure.invalidStageResponse("unsupported source:\(sourceEntity.rawValue)")
                }
                source = PhotoImportSourcePayload(entity: payloadEntity, id: sourceID)
            } else {
                // `createSelf`: no source record exists to name.
                source = nil
            }
            let destination: PhotoImportCommitDestination
            if let candidateID = item.candidateID {
                destination = PhotoImportCommitDestination(
                    value1: PhotoImportExistingDestination(
                        kind: .existing, candidateId: candidateID))
            } else if let draftID = item.createDraftID {
                destination = PhotoImportCommitDestination(
                    value2: PhotoImportCreateDestination(kind: .create, draftId: draftID))
            } else {
                throw Failure.invalidStageResponse("missing destination:\(item.clientID)")
            }
            let duplicateDecision: PhotoImportDuplicateDecisionPayload =
                switch item.duplicateChoice {
                case .reuse: .reuse
                case .keepBoth: .keepBoth
                case .automatic: staged.reusedExisting ? .reuse : .keepBoth
                }
            return PhotoImportCommitImage(
                clientId: item.clientID,
                imageId: staged.imageID,
                routeId: item.routeID,
                source: source,
                destination: destination,
                duplicateDecision: duplicateDecision,
                replaceConfirmed: item.replaceConfirmed,
                analysis: payload(item.analysis))
        }
        var drafts: [PhotoImportCreatePayload] = []
        var seenDrafts = Set<String>()
        for item in items {
            guard let draftID = item.createDraftID, seenDrafts.insert(draftID).inserted else { continue }
            guard let routeID = item.createRouteID, let body = item.createBody else {
                throw Failure.invalidStageResponse("missing draft:\(draftID)")
            }
            drafts.append(
                PhotoImportCreatePayload(
                    draftId: draftID,
                    routeId: routeID,
                    capturedAt: item.createCapturedAt,
                    body: PhotoImportCreateBody(additionalProperties: try body.mapValues(apiJSON))))
        }
        // The legacy idempotency key remains in the wire input for client compatibility. The
        // result is deliberately derived from the submitted batch rather than from a persisted
        // receipt; the server commit is a one-shot operation and callers must not auto-retry an
        // ambiguous transport response.
        do {
            _ = try await client.commitPhotoImport(
                PhotoImportCommitInput(
                    idempotencyKey: idempotencyKey, images: images, creates: drafts))
        } catch let apiError as CubbyAPIError {
            // A rejected 4xx request has a definite outcome: never route it through the full
            // ambiguous-commit reconciliation below, and never return committed ids for it — for
            // an all-reused batch, or a reused image already attached to the same record,
            // `reconcileAfterAmbiguousCommit` would read that as "committed" for a request the
            // server rejected outright.
            if (400..<500).contains(apiError.status) {
                // `REFERENCED_RECORD_MISSING` (400) / `IMAGE_PRECONDITION_FAILED` (412) fire when
                // the staged image row was deleted server-side (culled, or the sheet sat open
                // >24h) — the client would otherwise resend that dead id forever. Any other 4xx
                // (e.g. `CONSTRAINT_VIOLATION`, also `BAD_REQUEST`) is a definite rejection with no
                // dead staged state to clear.
                if let reason = apiError.reason, Self.staleStagedImageReasons.contains(reason) {
                    do {
                        _ = try await reconcileStagedIDs(items)
                    } catch let failure as Failure {
                        // `.stagedImagesExpired` — the ids reconciliation reported missing.
                        throw failure
                    } catch {
                        // Reconciliation itself failed (still offline, decode error, …): keep the
                        // definite 4xx (`apiError`, not this reconcile failure) rather than
                        // replacing it with an ambiguous one.
                        throw apiError
                    }
                }
                throw apiError
            }
            do {
                let reconciled = try await reconcileAfterAmbiguousCommit(items)
                committedClientIDs = reconciled
                return reconciled
            } catch let failure as Failure {
                if case .commitNotApplied = failure { throw apiError }
                throw failure
            }
        } catch {
            let originalError = error
            do {
                let reconciled = try await reconcileAfterAmbiguousCommit(items)
                committedClientIDs = reconciled
                return reconciled
            } catch let failure as Failure {
                if case .commitNotApplied = failure { throw originalError }
                throw failure
            }
        }
        let committed = items.map(\.clientID)
        committedClientIDs = committed
        return committed
    }

    /// Re-checks an ambiguous or offline commit without resending the write, for a caller that
    /// already holds a `.commitOutcomeUncertain`/`.commitInvariant` failure from `commit(_:)` (an
    /// offline "Check status" retry). A successful reconciliation is remembered the same way a
    /// successful `commit(_:)` is, so a later `commit(_:)` call short-circuits instead of
    /// re-POSTing the write.
    public func reconcile(_ items: [PhotoImportBatchItem]) async throws -> [String] {
        if let committedClientIDs { return committedClientIDs }
        let reconciled = try await reconcileAfterAmbiguousCommit(items)
        committedClientIDs = reconciled
        return reconciled
    }

    /// Collects the currently staged image ids for `items`, fetches their server-side
    /// reconciliation, and — when any are reported missing — removes those entries from
    /// `stagedByClientID` (so a later `commit(_:)` re-stages a fresh upload instead of retrying a
    /// dead id forever) and throws `.stagedImagesExpired`. Does not itself catch a failure from
    /// `client.reconcilePhotoImport`: callers disagree on what an unreachable reconcile means (a
    /// 4xx keeps its original error; an ambiguous commit becomes `.commitOutcomeUncertain`).
    private func reconcileStagedIDs(
        _ items: [PhotoImportBatchItem]
    ) async throws -> (
        unique: [String: Staged], imageIDs: [ImageCode], reconciliation: PhotoImportReconcileOutput
    ) {
        let (unique, imageIDs) = stagedImageIDs(for: items)
        let reconciliation = try await client.reconcilePhotoImport(imageIDs)
        if !reconciliation.missing.isEmpty {
            let missing = Set(reconciliation.missing)
            for (clientID, staged) in unique where missing.contains(staged.imageID) {
                stagedByClientID.removeValue(forKey: clientID)
            }
            throw Failure.stagedImagesExpired(reconciliation.missing)
        }
        return (unique, imageIDs, reconciliation)
    }

    /// The staged image id for every item that has one, deduplicated. Pure (no network, no
    /// mutation) so it can be recomputed after a failed reconcile without re-deriving state.
    private func stagedImageIDs(
        for items: [PhotoImportBatchItem]
    ) -> (unique: [String: Staged], imageIDs: [ImageCode]) {
        let unique = Dictionary(
            items.map { item in
                (item.clientID, stagedByClientID[item.clientID])
            }.compactMap { clientID, staged in staged.map { (clientID, $0) } },
            uniquingKeysWith: { first, _ in first })
        let imageIDs = Array(Set(unique.values.map(\.imageID))).sorted {
            $0.rawValue < $1.rawValue
        }
        return (unique, imageIDs)
    }

    /// A transport error after the commit request is ambiguous: the server may have committed
    /// before the response was lost. Reconciliation is read-only and never repeats the write.
    private func reconcileAfterAmbiguousCommit(
        _ items: [PhotoImportBatchItem]
    ) async throws -> [String] {
        let unique: [String: Staged]
        let imageIDs: [ImageCode]
        let reconciliation: PhotoImportReconcileOutput
        do {
            (unique, imageIDs, reconciliation) = try await reconcileStagedIDs(items)
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.commitOutcomeUncertain(stagedImageIDs(for: items).imageIDs)
        }
        let details = Dictionary(
            reconciliation.items.map { ($0.imageId, $0) },
            uniquingKeysWith: { first, _ in first })

        let newlyStaged = Set(unique.values.filter { !$0.reusedExisting }.map(\.imageID))
        let newStatuses = newlyStaged.compactMap { details[$0]?.status }
        if !newStatuses.isEmpty, newStatuses.allSatisfy({ $0 == .pending }) {
            throw Failure.commitNotApplied(Array(newlyStaged).sorted { $0.rawValue < $1.rawValue })
        }
        if newStatuses.contains(.pending) || newStatuses.contains(.failed) {
            throw Failure.commitInvariant(imageIDs)
        }

        for item in items {
            guard let staged = unique[item.clientID], let detail = details[staged.imageID],
                let route = PhotoImportCatalog.ingressRoutes.first(where: { $0.id == item.routeID })
            else { throw Failure.commitInvariant(imageIDs) }
            if item.createDraftID != nil, staged.reusedExisting {
                // An already-active image may have an older association of the same entity type;
                // without a receipt or a known created ID, that cannot prove this commit won.
                throw Failure.commitOutcomeUncertain(imageIDs)
            }
            let associationMatches = detail.associations.contains { association in
                guard association.entityType.rawValue == route.target.rawValue else { return false }
                return item.candidateID.map { association.entityId == $0 } ?? true
            }
            guard detail.status == .uploaded, associationMatches else {
                throw Failure.commitInvariant(imageIDs)
            }
        }
        return items.map(\.clientID)
    }

    private func stage(
        _ items: [PhotoImportBatchItem],
        progress: (@Sendable (PhotoImportTransactionProgress) -> Void)?
    ) async throws {
        let input = try PhotoImportStageInput(
            items: items.map { item in
                guard
                    let contentType = PhotoImportStageItem.ContentTypePayload(
                        rawValue: item.file.contentType)
                else { throw Failure.unsupportedContentType(item.file.contentType) }
                return PhotoImportStageItem(
                    clientId: item.clientID,
                    filename: item.file.filename,
                    contentType: contentType,
                    size: item.file.size,
                    width: item.file.width,
                    height: item.file.height,
                    sha256: item.analysis.sha256,
                    perceptualHash: item.analysis.perceptualHash?.hex,
                    sourceFingerprint: item.analysis.sourceFingerprint.map {
                        PhotoImportStageItem.SourceFingerprintPayload(
                            hash: $0.hash.hex, aspectRatio: $0.aspectRatio)
                    },
                    allowExactReuse: item.duplicateChoice != .keepBoth)
            })
        let response = try await client.stagePhotoImport(input)
        let files = Dictionary(uniqueKeysWithValues: items.map { ($0.clientID, $0.file) })
        var uploads: [(clientID: String, imageID: ImageCode, uploadURL: URL, file: PhotoFile)] = []
        var failed: [String] = []

        for result in response.items {
            if let existing = result.value1 {
                stagedByClientID[existing.clientId] = Staged(
                    imageID: existing.imageId, reusedExisting: true)
            } else if let upload = result.value2 {
                guard let file = files[upload.clientId], let uploadURL = URL(string: upload.uploadUrl)
                else { throw Failure.invalidStageResponse(upload.clientId) }
                uploads.append((upload.clientId, upload.imageId, uploadURL, file))
            } else if let failure = result.value3 {
                failed.append(failure.clientId)
            } else {
                throw Failure.invalidStageResponse("unknown")
            }
        }

        let uploadResults = await upload(uploads, progress: progress)
        for result in uploadResults {
            switch result.result {
            case .success:
                stagedByClientID[result.clientID] = Staged(
                    imageID: result.imageID, reusedExisting: false)
            case .failure:
                failed.append(result.clientID)
            }
        }
        guard failed.isEmpty else { throw Failure.stagingFailed(failed.sorted()) }
    }

    private func upload(
        _ uploads: [(clientID: String, imageID: ImageCode, uploadURL: URL, file: PhotoFile)],
        progress: (@Sendable (PhotoImportTransactionProgress) -> Void)?
    ) async -> [(clientID: String, imageID: ImageCode, result: Result<Void, any Error>)] {
        guard !uploads.isEmpty else { return [] }
        return await withTaskGroup(
            of: (Int, String, ImageCode, Result<Void, any Error>).self,
            returning: [(String, ImageCode, Result<Void, any Error>)].self
        ) { group in
            var next = 0
            var completed = 0
            var results: [Int: (String, ImageCode, Result<Void, any Error>)] = [:]

            func enqueue() {
                guard next < uploads.count else { return }
                let index = next
                let upload = uploads[index]
                next += 1
                group.addTask { [put] in
                    do {
                        try Task.checkCancellation()
                        defer { withExtendedLifetime(upload.file) {} }
                        try await put(upload.file.url, upload.uploadURL, upload.file.contentType)
                        return (index, upload.clientID, upload.imageID, .success(()))
                    } catch {
                        return (index, upload.clientID, upload.imageID, .failure(error))
                    }
                }
            }

            for _ in 0..<min(maximumConcurrentUploads, uploads.count) { enqueue() }
            for await (index, clientID, imageID, result) in group {
                results[index] = (clientID, imageID, result)
                completed += 1
                progress?(.uploading(completed: completed, total: uploads.count))
                enqueue()
            }
            return results.keys.sorted().compactMap { results[$0] }
        }
    }

    private func payload(_ analysis: PhotoLocalAnalysis) -> PhotoImportAnalysisPayload {
        PhotoImportAnalysisPayload(
            analysisVersion: analysis.analysisVersion,
            analyzedAt: analysis.analyzedAt,
            sha256: analysis.sha256,
            capturedAt: analysis.capturedAt,
            contentType: analysis.contentType,
            width: analysis.width,
            height: analysis.height,
            classifications: analysis.classifications.map {
                PhotoImportClassificationPayload(identifier: $0.identifier, confidence: $0.confidence)
            },
            recognizedText: analysis.recognizedText.map {
                PhotoImportRecognizedTextPayload(text: $0.text, confidence: $0.confidence)
            },
            featurePrint: PhotoImportFeaturePrintPayload(
                revision: analysis.featurePrint.revision,
                data: analysis.featurePrint.data.base64EncodedString()),
            provenance: PhotoImportProvenancePayload(
                source: .init(rawValue: analysis.provenance.source.rawValue)!,
                localIdentifier: analysis.provenance.localIdentifier,
                filename: analysis.provenance.filename))
    }

    private func apiJSON(_ value: JSONValue) throws -> Components.Schemas.JsonValue {
        try JSONDecoder().decode(
            Components.Schemas.JsonValue.self,
            from: JSONEncoder().encode(value))
    }
}
