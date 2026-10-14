import Foundation
import Observation

/// One ordered photo bound for a bulk import-run upload: materialized bytes and no per-photo
/// destination — the run itself is the destination. `id` is the picker's stable client-side key;
/// the uploader derives each photo's `position` from its index in the array passed to
/// `upload(_:runID:createRun:progress:)`, so callers never assign positions themselves.
public struct PhotoImportRunPhoto: Sendable {
    public let id: String
    public let file: PhotoFile
    public let provenance: PhotoAnalysisProvenance
    public let library: ImageSightingReportFields?

    public init(
        id: String, file: PhotoFile, provenance: PhotoAnalysisProvenance,
        library: ImageSightingReportFields? = nil
    ) {
        self.id = id
        self.file = file
        self.provenance = provenance
        self.library = library
    }
}

/// Bulk-uploads up to `SharedConstants.photoRunImageLimit` photos into one `photo_inventory`
/// import run: creates the run (or attaches to an existing one), chunks the ordered selection by the server's 100-image cap, stages and PUTs
/// each chunk, finalizes it, and then runs on-device Vision analysis in the background and posts
/// each result. There is no grouping or per-photo review — the manifest-based
/// `PhotoImportTransaction` owns that flow; this is the plain "select N photos, done" path.
///
/// State (`staged`/`finalizedIDs`/`analyzedIDs`) persists across calls, so calling
/// `upload(_:runID:createRun:progress:)` again with the same photos after a thrown error resumes:
/// already-staged bytes are not re-PUT, already-finalized images are not re-sent, and the
/// previously created run is reused rather than starting a second one. `finalize` is idempotent
/// server-side (a resend answers `alreadyFinalized`), so a chunk that fails after its bytes
/// uploaded needs only its `finalize` call retried, never the PUT.
public actor PhotoImportRunUploader {
    /// The server accepts at most 100 images per `finalize` call (`photoImportFinalizeInput`); the
    /// same cap is used for `stage` chunking here so a chunk's stage and finalize calls line up
    /// one-to-one.
    static let chunkSize = 100

    public struct Progress: Sendable, Equatable {
        public var total: Int = 0
        public var uploaded: Int = 0
        public var transferred: Int = 0
        public var waitingReason: String?
        public var analyzed: Int = 0
        public var excluded: Int = 0
        public var remaining: Int = 0
        public var analysisPending: Int = 0
        public var failedIDs: Set<String> = []
    }

    public enum Failure: Error, LocalizedError, Sendable, Equatable {
        /// Neither an existing run id nor `createRun` inputs were given.
        case missingRunTarget
        case unsupportedContentType(String)
        /// Staging or uploading bytes failed for these client ids; already-staged photos in the
        /// same chunk are unaffected and are not retried.
        case stagingFailed([String])
        case invalidStageResponse(String)

        public var errorDescription: String? {
            switch self {
            case .missingRunTarget:
                "Cubby needs either an existing run or the details for a new one."
            case .unsupportedContentType(let type):
                "\(type) photos are not supported."
            case .stagingFailed:
                "Some photos could not be staged. Retry to continue from where this left off."
            case .invalidStageResponse:
                "Cubby returned an invalid photo staging response."
            }
        }
    }

    private struct StagedUpload: Sendable {
        let imageID: ImageCode
        let sha256: String
    }

    private let waitForConditions: PhotoImportConditions.Wait?
    private let waitingReason: (@Sendable () -> String?)?
    private var currentWaitingReason: String?
    private let checkpointURL: URL?
    private let selectionCheckpointURL: URL?
    private var checkpoint: PhotoImportRunCheckpoint?
    private var createRunIntent: PhotoImportCreateRunInput?
    private var admissionAttempted = false
    private var admitted = false
    private var sealed = false
    private var positionOffset = 0
    private var legacy = false
    private var activeBatchID: String
    private let client: CubbyClient
    private let put: PresignedUpload.FilePut
    private let cancelUploads: @Sendable ([URL]) async -> Void
    private let maximumConcurrentUploads: Int
    private let analysisConcurrency: Int
    /// Injectable so tests can substitute a fast fake instead of running real Vision requests;
    /// production leaves the default, a plain `LocalPhotoAnalyzer` per photo.
    private let analyze: @Sendable (PhotoAnalysisInput) async throws -> PhotoLocalAnalysis
    /// Polled before each analysis dispatch, never mid-flight — a bulk run is a bounded batch, not
    /// a continuous sweep, so this only delays starting the next photo. Defaults to
    /// `ProcessInfo` directly: the thermal/power gate protocols in `PhotoClassificationSweep`
    /// (App/Shared/Photo/Library) are an App-target type CubbyKit cannot import, so this
    /// reimplements the same two-condition check rather than sharing it across the module boundary.
    private let systemConditionsFavorable: @Sendable () -> Bool

    public private(set) var runID: RunShortcode?
    private var photos: [PhotoImportRunPhoto] = []
    private var positions: [String: Int] = [:]
    private var staged: [String: StagedUpload] = [:]
    private var pendingUploads: [String: PhotoImportRunCheckpoint.Pending] = [:]
    private var finalizedIDs: Set<String> = []
    private var analyzedIDs: Set<String> = []
    private var excludedIDs: Set<String> = []
    private var analysisExcludedIDs: Set<String> = []
    private var uploadFailures: Set<String> = []
    private var analysisFailures: Set<String> = []
    /// Chains device-work reports onto one another so they reach the server in the order
    /// `analyzeOne` issued them (`queued` before `running` before `failed`) without making any of
    /// them block the caller: each report is scheduled after the previous one settles, but
    /// `reportDeviceWork` itself returns immediately.
    private var pendingReport: Task<Void, Never>?

    public init(
        client: CubbyClient,
        checkpointURL: URL? = nil,
        selectionCheckpointURL: URL? = nil,
        waitForConditions: PhotoImportConditions.Wait? = nil,
        waitingReason: (@Sendable () -> String?)? = nil,
        maximumConcurrentUploads: Int = 4,
        analysisConcurrency: Int = 2,
        systemConditionsFavorable: @escaping @Sendable () -> Bool = {
            let info = ProcessInfo.processInfo
            return !info.isLowPowerModeEnabled
                && info.thermalState.rawValue < ProcessInfo.ThermalState.serious.rawValue
        },
        cancelUploads: @escaping @Sendable ([URL]) async -> Void = { _ in },
        put: @escaping PresignedUpload.FilePut = {
            try await PresignedUpload.putFile($0, to: $1, contentType: $2)
        },
        analyze: @escaping @Sendable (PhotoAnalysisInput) async throws -> PhotoLocalAnalysis = {
            try await LocalPhotoAnalyzer().analyze($0)
        }
    ) {
        self.client = client
        self.checkpointURL = checkpointURL
        self.selectionCheckpointURL = selectionCheckpointURL
        self.activeBatchID = checkpointURL?.deletingPathExtension().lastPathComponent ?? UUID().uuidString
        self.waitForConditions = waitForConditions
        self.waitingReason = waitingReason
        self.maximumConcurrentUploads = max(1, maximumConcurrentUploads)
        self.analysisConcurrency = max(1, min(2, analysisConcurrency))
        self.systemConditionsFavorable = systemConditionsFavorable
        self.put = put
        self.cancelUploads = cancelUploads
        self.analyze = analyze
    }

    public var progress: Progress {
        Progress(
            total: photos.count, uploaded: finalizedIDs.count, transferred: staged.count,
            waitingReason: currentWaitingReason, analyzed: analyzedIDs.count,
            excluded: excludedIDs.count,
            remaining: max(0, photos.count - finalizedIDs.count - excludedIDs.count),
            analysisPending: finalizedIDs.subtracting(analyzedIDs).subtracting(analysisExcludedIDs).count,
            failedIDs: uploadFailures.union(analysisFailures))
    }

    private func saveCheckpoint() throws {
        guard let checkpointURL, var checkpoint else { return }
        checkpoint.runID = runID
        checkpoint.admissionAttempted = admissionAttempted
        checkpoint.admitted = admitted
        checkpoint.sealed = sealed
        checkpoint.positionOffset = positionOffset
        checkpoint.legacy = legacy
        checkpoint.uploaded = staged.mapValues {
            PhotoImportRunCheckpoint.Uploaded(imageID: $0.imageID, sha256: $0.sha256)
        }
        checkpoint.pending = pendingUploads
        checkpoint.finalized = finalizedIDs
        checkpoint.analyzed = analyzedIDs
        checkpoint.excluded = excludedIDs
        checkpoint.analysisExcluded = analysisExcludedIDs
        self.checkpoint = checkpoint
        try checkpoint.save(at: checkpointURL)
    }

    private func discardSettledCheckpoint() throws {
        guard let checkpointURL, checkpoint != nil,
            (checkpoint?.cancelled == true && (!admitted && !admissionAttempted || sealed))
                || (sealed && finalizedIDs.count + excludedIDs.count == photos.count
                    && finalizedIDs.subtracting(analyzedIDs).subtracting(analysisExcludedIDs).isEmpty)
        else { return }
        if FileManager.default.fileExists(atPath: checkpointURL.path) {
            try FileManager.default.removeItem(at: checkpointURL)
        }
        let directory = checkpointURL.deletingPathExtension()
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        checkpoint = nil
    }

    public func recordCancellationIntent() throws {
        checkpoint?.cancelled = true
        try saveCheckpoint()
    }

    public func cancelRemaining() async throws {
        checkpoint?.cancelled = true
        try saveCheckpoint()
        await cancelUploads(photos.filter { pendingUploads[$0.id] != nil }.map { $0.file.url })
        if admissionAttempted, !admitted {
            let resolved = try await resolveRun(
                runID: runID, createRun: checkpoint?.createRun ?? createRunIntent)
            if !admitted {
                let admission = try await client.admitPhotoImportBatch(
                    .init(
                        runId: resolved, clientBatchId: activeBatchID, imageCount: photos.count))
                positionOffset = admission.positionOffset
                legacy = admission.lifecycle.processor == nil
                positions = Dictionary(
                    uniqueKeysWithValues: photos.enumerated().map { ($1.id, positionOffset + $0) })
                admitted = true
                try saveCheckpoint()
            }
        }
        if let runID, admitted, !sealed {
            let ready = photos.filter { staged[$0.id] != nil && !finalizedIDs.contains($0.id) }
            if !ready.isEmpty {
                let images = try ready.map { photo -> PhotoImportFinalizeImage in
                    guard let upload = staged[photo.id], let position = positions[photo.id] else {
                        throw Failure.invalidStageResponse(photo.id)
                    }
                    return PhotoImportFinalizeImage(
                        imageId: upload.imageID, position: position,
                        sha256: upload.sha256, width: photo.file.width, height: photo.file.height,
                        library: photo.library)
                }
                var input = PhotoImportFinalizeInput(runId: runID, images: images)
                input.clientBatchId = legacy ? nil : activeBatchID
                _ = try await client.finalizePhotoRun(input)
                finalizedIDs.formUnion(ready.map(\.id))
                try saveCheckpoint()
            }
            _ = try await client.sealPhotoImportBatch(
                PhotoImportSealBatchInput(runId: runID, clientBatchId: activeBatchID))
            sealed = true
            excludedIDs.formUnion(photos.filter { !finalizedIDs.contains($0.id) }.map(\.id))
            uploadFailures.subtract(excludedIDs)
            try saveCheckpoint()
        }
        try discardSettledCheckpoint()
    }

    public func settleCancellation() async throws {
        guard let checkpointURL else { throw Failure.missingRunTarget }
        let state = try JSONDecoder().decode(
            PhotoImportRunCheckpoint.self, from: Data(contentsOf: checkpointURL))
        guard state.cancelled else { return }
        checkpoint = state
        activeBatchID = state.clientBatchID
        legacy = state.legacy
        runID = state.runID
        admissionAttempted = state.admissionAttempted ?? false
        admitted = state.admitted
        sealed = state.sealed
        staged = state.uploaded.mapValues { StagedUpload(imageID: $0.imageID, sha256: $0.sha256) }
        finalizedIDs = state.finalized
        analyzedIDs = state.analyzed
        excludedIDs = state.excluded
        analysisExcludedIDs = state.analysisExcluded
        pendingUploads = state.pending
        positionOffset = state.positionOffset
        photos = try state.materializedPhotos(at: checkpointURL)
        positions = Dictionary(uniqueKeysWithValues: photos.enumerated().map { ($1.id, positionOffset + $0) })
        try await cancelRemaining()
    }

    public func recover() async throws -> RunShortcode {
        guard let checkpointURL else { throw Failure.missingRunTarget }
        let state = try JSONDecoder().decode(
            PhotoImportRunCheckpoint.self, from: Data(contentsOf: checkpointURL))
        guard !state.cancelled else { throw CancellationError() }
        return try await upload(
            state.materializedPhotos(at: checkpointURL), runID: state.runID, createRun: state.createRun)
    }

    public var importedPhotoIDs: Set<String> { finalizedIDs }

    public var failedUploadPhotos: [PhotoImportRunPhoto] {
        photos.filter { uploadFailures.contains($0.id) }
    }

    public func retryPhoto(_ id: String, report: (@Sendable (Progress) -> Void)? = nil) async throws {
        guard let runID, let photo = photos.first(where: { $0.id == id }) else {
            throw Failure.missingRunTarget
        }
        if !finalizedIDs.contains(id) { try await processChunk([photo], runID: runID, report: report) }
        report?(progress)
        try await uploadRemainingChunks(runID: runID, excludingKnownFailures: true, report: report)
        try await sealIfSettled(runID: runID)
        await analyzeRemaining(report: report)
        try discardSettledCheckpoint()
    }

    public func continueWithoutFailedUploads(report: (@Sendable (Progress) -> Void)? = nil) async throws {
        guard let runID else { throw Failure.missingRunTarget }
        excludedIDs.formUnion(uploadFailures.filter { staged[$0] == nil })
        uploadFailures.subtract(excludedIDs)
        try saveCheckpoint()
        try await uploadRemainingChunks(runID: runID, report: report)
        try await sealIfSettled(runID: runID)
        await analyzeRemaining(report: report)
        try discardSettledCheckpoint()
    }

    private func sealIfSettled(runID: RunShortcode) async throws {
        guard progress.remaining == 0, !sealed else { return }
        _ = try await client.sealPhotoImportBatch(.init(runId: runID, clientBatchId: activeBatchID))
        sealed = true
        try saveCheckpoint()
    }

    public func skipFailedAnalysis() throws {
        analysisExcludedIDs.formUnion(analysisFailures)
        analysisFailures.removeAll()
        try saveCheckpoint()
        try discardSettledCheckpoint()
    }

    /// The run's photos whose local analysis failed, for a retry list — `progress.failedIDs`
    /// also includes upload failures, but only these are worth an analysis-only retry
    /// (`retryFailedAnalysis`).
    public var failedAnalysisPhotos: [PhotoImportRunPhoto] {
        photos.filter { analysisFailures.contains($0.id) }
    }

    /// Uploads `photos` in picker order, creating a run first when `runID` is `nil` (from
    /// `createRun`), then finalizes every chunk and runs background analysis. Returns the run id.
    /// A retry (same photos, `runID`/`createRun` may be omitted) resumes using the id and
    /// per-photo state a prior call already recorded.
    @discardableResult
    public func upload(
        _ photos: [PhotoImportRunPhoto],
        runID: RunShortcode? = nil,
        createRun: PhotoImportCreateRunInput? = nil,
        performLocalAnalysis: Bool = true,
        notificationsRequested: Bool = false,
        progress reportProgress: (@Sendable (Progress) -> Void)? = nil
    ) async throws -> RunShortcode {
        if let createRun {
            createRunIntent = createRun
            activeBatchID = createRun.clientBatchId
        }
        if let checkpointURL, checkpoint == nil {
            if FileManager.default.fileExists(atPath: checkpointURL.path) {
                checkpoint = try JSONDecoder().decode(
                    PhotoImportRunCheckpoint.self, from: Data(contentsOf: checkpointURL))
            } else {
                checkpoint = try PhotoImportRunCheckpoint.prepare(
                    photos, runID: runID, createRun: createRun, clientBatchID: activeBatchID,
                    notificationsRequested: notificationsRequested, at: checkpointURL)
            }
            if let checkpoint {
                self.runID = checkpoint.runID
                activeBatchID = checkpoint.clientBatchID
                legacy = checkpoint.legacy
                admissionAttempted = checkpoint.admissionAttempted ?? false
                admitted = checkpoint.admitted
                sealed = checkpoint.sealed
                positionOffset = checkpoint.positionOffset
                staged = checkpoint.uploaded.mapValues {
                    StagedUpload(imageID: $0.imageID, sha256: $0.sha256)
                }
                pendingUploads = checkpoint.pending
                finalizedIDs = checkpoint.finalized
                analyzedIDs = checkpoint.analyzed
                excludedIDs = checkpoint.excluded
                analysisExcludedIDs = checkpoint.analysisExcluded
            }
        }
        if checkpoint != nil, let selectionCheckpointURL {
            if FileManager.default.fileExists(atPath: selectionCheckpointURL.path) {
                try FileManager.default.removeItem(at: selectionCheckpointURL)
            }
            let selectionFiles = selectionCheckpointURL.deletingPathExtension().appendingPathExtension(
                "files")
            if FileManager.default.fileExists(atPath: selectionFiles.path) {
                try FileManager.default.removeItem(at: selectionFiles)
            }
        }
        self.photos =
            try checkpointURL.flatMap { url in
                try checkpoint?.materializedPhotos(at: url)
            } ?? photos
        positions = Dictionary(
            uniqueKeysWithValues: self.photos.enumerated().map { ($1.id, positionOffset + $0) })
        let resolvedRunID = try await resolveRun(runID: runID, createRun: createRun ?? checkpoint?.createRun)
        try Task.checkCancellation()
        if !admitted {
            admissionAttempted = true
            try saveCheckpoint()
            let admission = try await client.admitPhotoImportBatch(
                PhotoImportAdmitBatchInput(
                    runId: resolvedRunID, clientBatchId: activeBatchID, imageCount: self.photos.count))
            positionOffset = admission.positionOffset
            legacy = admission.lifecycle.processor == nil
            positions = Dictionary(
                uniqueKeysWithValues: self.photos.enumerated().map { ($1.id, positionOffset + $0) })
            admitted = true
            try saveCheckpoint()
        }
        try await uploadRemainingChunks(runID: resolvedRunID, report: reportProgress)
        try Task.checkCancellation()
        if !sealed {
            _ = try await client.sealPhotoImportBatch(
                PhotoImportSealBatchInput(runId: resolvedRunID, clientBatchId: activeBatchID))
            sealed = true
            try saveCheckpoint()
        }
        if performLocalAnalysis {
            await analyzeRemaining(report: reportProgress)
            try discardSettledCheckpoint()
        }
        return resolvedRunID
    }

    private func resolveRun(
        runID: RunShortcode?, createRun: PhotoImportCreateRunInput?
    ) async throws -> RunShortcode {
        if let existing = self.runID { return existing }
        if let runID {
            self.runID = runID
            return runID
        }
        guard let createRun else { throw Failure.missingRunTarget }
        admissionAttempted = true
        try saveCheckpoint()
        let output = try await client.createPhotoRun(createRun)
        self.runID = output.runId
        admitted = true
        try saveCheckpoint()
        return output.runId
    }

    private func uploadRemainingChunks(
        runID: RunShortcode, excludingKnownFailures: Bool = false, report: (@Sendable (Progress) -> Void)?
    ) async throws {
        let pending = photos.filter {
            !finalizedIDs.contains($0.id) && !excludedIDs.contains($0.id)
                && (!excludingKnownFailures || !uploadFailures.contains($0.id) || staged[$0.id] != nil)
        }
        for chunk in pending.chunked(into: Self.chunkSize) {
            try Task.checkCancellation()
            report?(progress)
            try await processChunk(chunk, runID: runID, report: report)
            report?(progress)
        }
    }

    private func processChunk(
        _ chunk: [PhotoImportRunPhoto], runID: RunShortcode, report: (@Sendable (Progress) -> Void)?
    ) async throws {
        let toStage = chunk.filter { staged[$0.id] == nil }
        if !toStage.isEmpty {
            try await stageAndUpload(toStage, runID: runID, report: report)
        }
        let toFinalize = chunk.filter { !finalizedIDs.contains($0.id) && staged[$0.id] != nil }
        guard !toFinalize.isEmpty else {
            try Task.checkCancellation()
            throw Failure.stagingFailed(chunk.map(\.id).sorted())
        }
        let images = try toFinalize.map { photo -> PhotoImportFinalizeImage in
            guard let entry = staged[photo.id], let position = positions[photo.id] else {
                throw Failure.invalidStageResponse(photo.id)
            }
            return PhotoImportFinalizeImage(
                imageId: entry.imageID, position: position, sha256: entry.sha256,
                width: photo.file.width, height: photo.file.height, library: photo.library)
        }
        do {
            // A submitted id always comes back in exactly one of `finalized`/`alreadyFinalized`
            // (the server's contract); a non-throwing response means every id in this chunk is
            // confirmed, so there is no need to reconcile the two arrays against `toFinalize`.
            var input = PhotoImportFinalizeInput(runId: runID, images: images)
            input.clientBatchId = legacy ? nil : activeBatchID
            _ = try await client.finalizePhotoRun(input)
            for photo in toFinalize {
                finalizedIDs.insert(photo.id)
                uploadFailures.remove(photo.id)
            }
            try saveCheckpoint()
        } catch {
            uploadFailures.formUnion(toFinalize.map(\.id))
            throw error
        }
        try Task.checkCancellation()
        let failed = chunk.filter { !finalizedIDs.contains($0.id) }.map(\.id)
        if !failed.isEmpty { throw Failure.stagingFailed(failed.sorted()) }
    }

    private func stageAndUpload(
        _ photos: [PhotoImportRunPhoto], runID: RunShortcode, report: (@Sendable (Progress) -> Void)?,
        renewExpiredPresigns: Bool = true
    ) async throws {
        let resumingIDs = Set(photos.filter { pendingUploads[$0.id] != nil }.map(\.id))
        var hashes: [String: String] = [:]
        var failed: [String] = []
        for photo in photos {
            do { hashes[photo.id] = try pendingUploads[photo.id]?.sha256 ?? photo.file.sha256() } catch {
                failed.append(photo.id)
            }
        }
        uploadFailures.formUnion(failed)
        let items = try photos.filter { hashes[$0.id] != nil }.map { photo -> PhotoImportStageItem in
            guard
                let contentType = PhotoImportStageItem.ContentTypePayload(rawValue: photo.file.contentType)
            else { throw Failure.unsupportedContentType(photo.file.contentType) }
            return PhotoImportStageItem(
                clientId: photo.id, filename: photo.file.filename, contentType: contentType,
                size: photo.file.size, width: photo.file.width, height: photo.file.height,
                sha256: hashes[photo.id] ?? "")
        }
        let newItems = items.filter { pendingUploads[$0.clientId] == nil }
        let filesByID = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0.file) })
        var uploads: [(id: String, imageID: ImageCode, url: URL, file: PhotoFile)] = []
        for photo in photos {
            if let pending = pendingUploads[photo.id] {
                uploads.append((photo.id, pending.imageID, pending.url, photo.file))
            }
        }

        if !newItems.isEmpty {
            try await awaitDeviceConditions(report: report)
            let response = try await client.stagePhotoImport(
                PhotoImportStageInput(items: newItems, runId: runID))
            for result in response.items {
                if let existing = result.value1 {
                    staged[existing.clientId] = StagedUpload(
                        imageID: existing.imageId, sha256: hashes[existing.clientId] ?? "")
                } else if let upload = result.value2 {
                    guard let file = filesByID[upload.clientId], let url = URL(string: upload.uploadUrl)
                    else { throw Failure.invalidStageResponse(upload.clientId) }
                    pendingUploads[upload.clientId] = PhotoImportRunCheckpoint.Pending(
                        imageID: upload.imageId, sha256: hashes[upload.clientId] ?? "", url: url)
                    uploads.append((upload.clientId, upload.imageId, url, file))
                } else if let failure = result.value3 {
                    failed.append(failure.clientId)
                } else {
                    throw Failure.invalidStageResponse("unknown")
                }
            }
        }

        try saveCheckpoint()
        let uploadResults = await performUploads(
            uploads, hashes: hashes, resumingIDs: resumingIDs, report: report)
        for result in uploadResults {
            switch result.outcome {
            case .success:
                staged[result.id] = StagedUpload(imageID: result.imageID, sha256: hashes[result.id] ?? "")
            case .failure(let error):
                if !(error is CancellationError) { failed.append(result.id) }
            }
        }
        uploadFailures.formUnion(failed)
        if renewExpiredPresigns, !Task.isCancelled {
            let expiredIDs = Set(
                uploadResults.compactMap { result -> String? in
                    guard case .failure(let error) = result.outcome,
                        let response = error as? CubbyAPIError, response.status == 403,
                        let url = uploads.first(where: { $0.id == result.id })?.url,
                        Self.presignHasExpired(url)
                    else { return nil }
                    return result.id
                })
            if !expiredIDs.isEmpty {
                // Consume the old background result first; renewing before it finishes could
                // incorrectly apply an old object's completed PUT to a newly staged Image.
                for id in expiredIDs { pendingUploads.removeValue(forKey: id) }
                try saveCheckpoint()
                try await stageAndUpload(
                    photos.filter { expiredIDs.contains($0.id) },
                    runID: runID, report: report, renewExpiredPresigns: false)
            }
        }
    }

    private static func presignHasExpired(_ url: URL) -> Bool {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let dateText = query.first(where: { $0.name == "X-Amz-Date" })?.value,
            let secondsText = query.first(where: { $0.name == "X-Amz-Expires" })?.value,
            let seconds = TimeInterval(secondsText), seconds >= 0
        else { return false }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        guard let signedAt = formatter.date(from: dateText) else { return false }
        return signedAt.addingTimeInterval(seconds) <= .now
    }

    private func awaitDeviceConditions(report: (@Sendable (Progress) -> Void)?) async throws {
        currentWaitingReason = waitingReason?()
        report?(progress)
        try await waitForConditions? { reason in await self.reportWaitingReason(reason, report: report) }
        currentWaitingReason = nil
        report?(progress)
    }

    private func reportWaitingReason(_ reason: String?, report: (@Sendable (Progress) -> Void)?) {
        currentWaitingReason = reason
        report?(progress)
    }

    private func performUploads(
        _ uploads: [(id: String, imageID: ImageCode, url: URL, file: PhotoFile)],
        hashes: [String: String], resumingIDs: Set<String>, report: (@Sendable (Progress) -> Void)?
    ) async -> [(id: String, imageID: ImageCode, outcome: Result<Void, any Error>)] {
        guard !uploads.isEmpty else { return [] }
        return await withTaskGroup(
            of: (Int, String, ImageCode, Result<Void, any Error>).self,
            returning: [(String, ImageCode, Result<Void, any Error>)].self
        ) { group in
            var next = 0
            var results: [Int: (String, ImageCode, Result<Void, any Error>)] = [:]

            func enqueue() {
                guard next < uploads.count else { return }
                let index = next
                let upload = uploads[index]
                next += 1
                group.addTask { [put] in
                    do {
                        try Task.checkCancellation()
                        if !resumingIDs.contains(upload.id) {
                            try await self.awaitDeviceConditions(report: report)
                        }
                        defer { withExtendedLifetime(upload.file) {} }
                        try await put(upload.file.url, upload.url, upload.file.contentType)
                        return (index, upload.id, upload.imageID, .success(()))
                    } catch {
                        return (index, upload.id, upload.imageID, .failure(error))
                    }
                }
            }

            for _ in 0..<min(maximumConcurrentUploads, uploads.count) { enqueue() }
            for await (index, id, imageID, outcome) in group {
                results[index] = (id, imageID, outcome)
                if case .success = outcome {
                    staged[id] = StagedUpload(imageID: imageID, sha256: hashes[id] ?? "")
                    uploadFailures.remove(id)
                    pendingUploads.removeValue(forKey: id)
                } else if case .failure(let error) = outcome, !(error is CancellationError) {
                    uploadFailures.insert(id)
                    pendingUploads.removeValue(forKey: id)
                }
                do { try saveCheckpoint() } catch {
                    uploadFailures.insert(id)
                }
                report?(progress)
                if !Task.isCancelled { enqueue() }
            }
            return results.keys.sorted().compactMap { results[$0] }
        }
    }

    private func analyzeRemaining(report: (@Sendable (Progress) -> Void)?) async {
        let pending = photos.filter {
            finalizedIDs.contains($0.id) && !analyzedIDs.contains($0.id)
                && !analysisExcludedIDs.contains($0.id)
        }
        await runAnalysis(pending, report: report)
    }

    /// Re-runs local analysis for exactly the photos currently in `analysisFailures`, ignoring
    /// anything already analyzed or never finalized. The uploader's own per-photo state means
    /// this is a plain re-queue of just those photos, not a second full pass over the run.
    public func retryFailedAnalysis(report: (@Sendable (Progress) -> Void)? = nil) async {
        let pending = photos.filter { analysisFailures.contains($0.id) }
        await runAnalysis(pending, report: report)
        try? discardSettledCheckpoint()
    }

    private func runAnalysis(
        _ pending: [PhotoImportRunPhoto], report: (@Sendable (Progress) -> Void)?
    ) async {
        guard !pending.isEmpty else { return }
        if let runID {
            for photo in pending {
                if let imageID = staged[photo.id]?.imageID {
                    reportDeviceWork(runID: runID, image: imageID, state: .queued)
                }
            }
        }
        await withTaskGroup(of: Void.self) { group in
            var next = 0
            func enqueue() {
                guard next < pending.count else { return }
                let photo = pending[next]
                next += 1
                group.addTask {
                    do {
                        try await self.awaitDeviceConditions(report: report)
                        await self.analyzeOne(photo, report: report)
                    } catch is CancellationError {
                        return
                    } catch {
                        await self.recordAnalysisFailure(photo, error: error)
                    }
                }
            }
            for _ in 0..<min(analysisConcurrency, pending.count) { enqueue() }
            for await _ in group {
                report?(progress)
                enqueue()
            }
        }
    }

    private func recordAnalysisFailure(_ photo: PhotoImportRunPhoto, error: any Error) {
        analysisFailures.insert(photo.id)
        if let runID, let entry = staged[photo.id] {
            reportDeviceWork(
                runID: runID, image: entry.imageID, state: .failed,
                error: Self.deviceWorkErrorDescription(error))
        }
    }

    private func analyzeOne(_ photo: PhotoImportRunPhoto, report: (@Sendable (Progress) -> Void)?) async {
        guard let entry = staged[photo.id] else { return }
        if let runID {
            reportDeviceWork(runID: runID, image: entry.imageID, state: .running)
        }
        do {
            if !systemConditionsFavorable() {
                if let runID { reportDeviceWork(runID: runID, image: entry.imageID, state: .paused) }
                try await
                    (waitForConditions ?? { changed in
                        try await PhotoImportConditions.shared.wait(report: changed)
                    }) { reason in await self.reportWaitingReason(reason, report: report) }
            }
            try Task.checkCancellation()
            let analysis = try await analyze(
                PhotoAnalysisInput(id: photo.id, file: photo.file, provenance: photo.provenance))
            _ = try await client.recordImageAnalysis(entry.imageID, ImageAnalysisOutput(analysis))
            analyzedIDs.insert(photo.id)
            try saveCheckpoint()
            analysisFailures.remove(photo.id)
            // Completion is optional: the server already marks this target completed when it
            // records the analysis above, so posting it again here would be redundant.
        } catch is CancellationError {
            return
        } catch {
            // Best-effort: analysis runs in the background after the photo is already imported, so
            // a Vision or network failure on one photo is recorded and skipped rather than aborting
            // the rest of the batch.
            analysisFailures.insert(photo.id)
            if let runID {
                reportDeviceWork(
                    runID: runID, image: entry.imageID, state: .failed,
                    error: Self.deviceWorkErrorDescription(error))
            }
        }
    }

    /// Fires a best-effort device-work status report without waiting for it or letting it affect
    /// analysis: chained after any report already in flight (so `queued`/`running`/`paused`/
    /// `failed` for one photo reach the server in the order they were reported), never retried,
    /// and never able to block or abort the pipeline that queued it (`try?` swallows the result).
    private func reportDeviceWork(
        runID: RunShortcode, image: ImageCode, state: RunTargetDeviceWorkState, error: String? = nil
    ) {
        let client = client
        let previous = pendingReport
        pendingReport = Task {
            _ = await previous?.value
            _ = try? await client.reportRunDeviceWork(run: runID, image: image, state: state, error: error)
        }
    }

    /// Returns once every device-work report issued so far has settled.
    func reportsSettled() async {
        await pendingReport?.waitUnlessCancelled()
    }

    /// A short, PII-free description for a `failed` device-work report: a Vision or Photos error's
    /// `localizedDescription` can carry on-device detail (file paths, asset identifiers), so this
    /// keeps only the error's type name (plus the HTTP status for an API error).
    private static func deviceWorkErrorDescription(_ error: any Error) -> String {
        if let error = error as? CubbyAPIError { return "HTTP \(error.status)" }
        return String(describing: type(of: error))
    }
}

extension Array {
    fileprivate func chunked(into size: Int) -> [[Element]] {
        guard size > 0 else { return isEmpty ? [] : [self] }
        return stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

/// The `@Observable` state one screen binds to for a bulk import-run upload: owns one
/// `PhotoImportRunUploader` and republishes its `Progress` on the main actor as the background
/// upload/analysis work reports it, matching the `Task { @MainActor in ... }` bridge
/// `PhotoImportManifest.updateProgress` uses for `PhotoImportTransaction`.
@MainActor
@Observable
public final class PhotoImportRunSession {
    public enum Phase: Sendable, Equatable {
        case idle
        case running
        case complete
        case cancelled
        case interrupted
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var progress = PhotoImportRunUploader.Progress()
    public private(set) var runID: RunShortcode?
    public private(set) var importedPhotoIDs: Set<String> = []
    /// The photos whose local analysis failed, for the "needs retry" list — mirrors the actor's
    /// `failedAnalysisPhotos` after every progress update.
    public private(set) var failedAnalysisPhotos: [PhotoImportRunPhoto] = []
    public private(set) var failedUploadPhotos: [PhotoImportRunPhoto] = []

    private let uploader: PhotoImportRunUploader
    private let reportDiagnostic: @MainActor (any Error) -> Void
    private var task: Task<Void, Never>?
    private var cancellationTask: Task<Void, Never>?
    private var interruptionRequested = false
    private var targetRunID: RunShortcode?
    private var createRunInput: PhotoImportCreateRunInput?

    public init(
        uploader: PhotoImportRunUploader,
        reportDiagnostic: @escaping @MainActor (any Error) -> Void = { _ in }
    ) {
        self.uploader = uploader
        self.reportDiagnostic = reportDiagnostic
    }

    public var isRunning: Bool { phase == .running }
    public var hasActiveWork: Bool { task != nil || cancellationTask != nil }
    public var canRetry: Bool {
        if case .failed = phase { return true }
        return false
    }
    public var canRetryAnalysis: Bool {
        phase == .complete && task == nil && !failedAnalysisPhotos.isEmpty
    }

    /// Starts (or, called again after `.failed`/`.cancelled` with the same `photos`, resumes) the
    /// upload. A no-op while already running.
    public func start(
        _ photos: [PhotoImportRunPhoto],
        runID: RunShortcode? = nil,
        createRun: PhotoImportCreateRunInput? = nil,
        notificationsRequested: Bool = false
    ) {
        guard task == nil else { return }
        if let runID { targetRunID = runID }
        if let createRun { createRunInput = createRun }
        progress.total = photos.count
        interruptionRequested = false
        phase = .running
        let uploader = uploader
        let targetRunID = targetRunID
        let createRunInput = createRunInput
        // Strong `self` here (bounded lifetime: this task always clears `self.task` before
        // finishing, so it cannot outlive its own reference). The progress callback takes its own
        // `[weak self]` — nesting a weak capture inside an already-weak outer capture is what the
        // compiler rejects ("captured var in concurrently-executing code"), so the outer capture
        // must stay strong for the inner one to be legal.
        task = Task { [self] in
            do {
                let resolved = try await uploader.upload(
                    photos, runID: targetRunID, createRun: createRunInput,
                    notificationsRequested: notificationsRequested
                ) {
                    [weak self, uploader] update in
                    Task { @MainActor in
                        guard let self else { return }
                        self.progress = update
                        self.importedPhotoIDs = await uploader.importedPhotoIDs
                        self.runID = await uploader.runID
                        self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                        self.failedUploadPhotos = await uploader.failedUploadPhotos
                        if update.total > 0, update.remaining == 0, self.phase == .running {
                            self.runID = await uploader.runID
                            self.phase = .complete
                        }
                    }
                }
                self.runID = resolved
                self.progress = await uploader.progress
                self.importedPhotoIDs = await uploader.importedPhotoIDs
                self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                self.failedUploadPhotos = await uploader.failedUploadPhotos
                self.phase = .complete
            } catch is CancellationError {
                self.progress = await uploader.progress
                self.importedPhotoIDs = await uploader.importedPhotoIDs
                self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                self.failedUploadPhotos = await uploader.failedUploadPhotos
                if interruptionRequested {
                    self.phase = .interrupted
                } else if progress.total > 0, progress.uploaded == progress.total {
                    self.runID = await uploader.runID
                    self.phase = .complete
                } else {
                    self.phase = .cancelled
                }
            } catch {
                self.progress = await uploader.progress
                self.importedPhotoIDs = await uploader.importedPhotoIDs
                self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                self.failedUploadPhotos = await uploader.failedUploadPhotos
                self.reportDiagnostic(error)
                self.phase = .failed(error.userMessage)
            }
            self.task = nil
        }
    }

    public func retryPhoto(_ id: String) {
        guard task == nil else { return }
        phase = .running
        task = Task { [self] in
            do {
                try await uploader.retryPhoto(id) { [weak self] update in
                    Task { @MainActor in self?.progress = update }
                }
                phase =
                    await uploader.failedUploadPhotos.isEmpty
                    ? .complete : .failed("Some photos still need a retry.")
            } catch {
                reportDiagnostic(error)
                phase = .failed(error.userMessage)
            }
            progress = await uploader.progress
            importedPhotoIDs = await uploader.importedPhotoIDs
            failedUploadPhotos = await uploader.failedUploadPhotos
            failedAnalysisPhotos = await uploader.failedAnalysisPhotos
            task = nil
        }
    }

    public func continueWithoutFailedUploads() {
        guard task == nil else { return }
        task = Task { [self] in
            do {
                try await uploader.continueWithoutFailedUploads { [weak self] update in
                    Task { @MainActor in self?.progress = update }
                }
                progress = await uploader.progress
                importedPhotoIDs = await uploader.importedPhotoIDs
                failedUploadPhotos = await uploader.failedUploadPhotos
                failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                phase = .complete
            } catch {
                reportDiagnostic(error)
                phase = .failed(error.userMessage)
            }
            task = nil
        }
    }

    public func skipFailedAnalysis() {
        guard task == nil else { return }
        task = Task { [self] in
            do { try await uploader.skipFailedAnalysis() } catch { reportDiagnostic(error) }
            progress = await uploader.progress
            failedAnalysisPhotos = await uploader.failedAnalysisPhotos
            task = nil
        }
    }

    /// Re-runs local analysis for just the photos `failedAnalysisPhotos` currently lists, without
    /// re-touching the upload phase. A no-op while a task (an upload or another retry) is already
    /// running.
    public func retryFailedAnalysis() {
        guard task == nil else { return }
        let uploader = uploader
        task = Task { [self] in
            await uploader.retryFailedAnalysis { [weak self] update in
                Task { @MainActor in
                    guard let self else { return }
                    self.progress = update
                    self.importedPhotoIDs = await uploader.importedPhotoIDs
                    self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                    self.failedUploadPhotos = await uploader.failedUploadPhotos
                }
            }
            self.progress = await uploader.progress
            self.importedPhotoIDs = await uploader.importedPhotoIDs
            self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
            self.failedUploadPhotos = await uploader.failedUploadPhotos
            self.task = nil
        }
    }

    /// Returns once the running upload or analysis retry has finished.
    public func waitUntilIdle() async { await idle() }

    func idle() async {
        while !Task.isCancelled {
            if let task {
                await task.waitUnlessCancelled()
            } else if let cancellationTask {
                await cancellationTask.waitUnlessCancelled()
            } else {
                return
            }
        }
    }

    /// Stops further chunks from starting; chunks already finalized stay finalized (the server has
    /// them), so calling `start(_:)` again with the same photos picks up where this left off.
    public func interrupt() {
        interruptionRequested = true
        task?.cancel()
    }

    public func cancel() {
        interruptionRequested = false
        phase = .cancelled
        guard cancellationTask == nil else { return }
        let uploading = task
        cancellationTask = Task {
            defer { cancellationTask = nil }
            do { try await uploader.recordCancellationIntent() } catch { reportDiagnostic(error) }
            uploading?.cancel()
            await uploading?.value
            do { try await uploader.cancelRemaining() } catch { reportDiagnostic(error) }
            progress = await uploader.progress
            importedPhotoIDs = await uploader.importedPhotoIDs
            runID = await uploader.runID
            failedUploadPhotos = await uploader.failedUploadPhotos
            phase = .cancelled
        }
    }
}
