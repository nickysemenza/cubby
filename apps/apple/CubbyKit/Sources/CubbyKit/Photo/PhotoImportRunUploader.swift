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

    public init(id: String, file: PhotoFile, provenance: PhotoAnalysisProvenance) {
        self.id = id
        self.file = file
        self.provenance = provenance
    }
}

/// Bulk-uploads 1–1000 photos into one `photo_inventory` import run: creates the run (or attaches
/// to an existing one), chunks the ordered selection by the server's 100-image cap, stages and PUTs
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
        public var analyzed: Int = 0
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

    private let client: CubbyClient
    private let put: PresignedUpload.FilePut
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
    private var finalizedIDs: Set<String> = []
    private var analyzedIDs: Set<String> = []
    private var uploadFailures: Set<String> = []
    private var analysisFailures: Set<String> = []
    /// Chains device-work reports onto one another so they reach the server in the order
    /// `analyzeOne` issued them (`queued` before `running` before `failed`) without making any of
    /// them block the caller: each report is scheduled after the previous one settles, but
    /// `reportDeviceWork` itself returns immediately.
    private var pendingReport: Task<Void, Never>?

    public init(
        client: CubbyClient,
        maximumConcurrentUploads: Int = 4,
        analysisConcurrency: Int = 2,
        systemConditionsFavorable: @escaping @Sendable () -> Bool = {
            let info = ProcessInfo.processInfo
            return !info.isLowPowerModeEnabled
                && info.thermalState.rawValue < ProcessInfo.ThermalState.serious.rawValue
        },
        put: @escaping PresignedUpload.FilePut = {
            try await PresignedUpload.putFile($0, to: $1, contentType: $2)
        },
        analyze: @escaping @Sendable (PhotoAnalysisInput) async throws -> PhotoLocalAnalysis = {
            try await LocalPhotoAnalyzer().analyze($0)
        }
    ) {
        self.client = client
        self.maximumConcurrentUploads = max(1, maximumConcurrentUploads)
        self.analysisConcurrency = max(1, min(2, analysisConcurrency))
        self.systemConditionsFavorable = systemConditionsFavorable
        self.put = put
        self.analyze = analyze
    }

    public var progress: Progress {
        Progress(
            total: photos.count, uploaded: finalizedIDs.count, analyzed: analyzedIDs.count,
            failedIDs: uploadFailures.union(analysisFailures))
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
        progress reportProgress: (@Sendable (Progress) -> Void)? = nil
    ) async throws -> RunShortcode {
        self.photos = photos
        positions = Dictionary(uniqueKeysWithValues: photos.enumerated().map { ($1.id, $0) })
        let resolvedRunID = try await resolveRun(runID: runID, createRun: createRun)
        try Task.checkCancellation()
        try await uploadRemainingChunks(runID: resolvedRunID, report: reportProgress)
        try Task.checkCancellation()
        if performLocalAnalysis {
            await analyzeRemaining(report: reportProgress)
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
        let output = try await client.createPhotoRun(createRun)
        self.runID = output.runId
        return output.runId
    }

    private func uploadRemainingChunks(
        runID: RunShortcode, report: (@Sendable (Progress) -> Void)?
    ) async throws {
        let pending = photos.filter { !finalizedIDs.contains($0.id) }
        for chunk in pending.chunked(into: Self.chunkSize) {
            try Task.checkCancellation()
            try await processChunk(chunk, runID: runID)
            report?(progress)
        }
    }

    private func processChunk(_ chunk: [PhotoImportRunPhoto], runID: RunShortcode) async throws {
        let toStage = chunk.filter { staged[$0.id] == nil }
        if !toStage.isEmpty {
            try await stageAndUpload(toStage, runID: runID)
        }
        let toFinalize = chunk.filter { !finalizedIDs.contains($0.id) }
        guard !toFinalize.isEmpty else { return }
        let images = try toFinalize.map { photo -> PhotoImportFinalizeImage in
            guard let entry = staged[photo.id], let position = positions[photo.id] else {
                throw Failure.invalidStageResponse(photo.id)
            }
            return PhotoImportFinalizeImage(
                imageId: entry.imageID, position: position, sha256: entry.sha256,
                width: photo.file.width, height: photo.file.height)
        }
        do {
            // A submitted id always comes back in exactly one of `finalized`/`alreadyFinalized`
            // (the server's contract); a non-throwing response means every id in this chunk is
            // confirmed, so there is no need to reconcile the two arrays against `toFinalize`.
            _ = try await client.finalizePhotoRun(
                PhotoImportFinalizeInput(runId: runID, images: images))
            for photo in toFinalize {
                finalizedIDs.insert(photo.id)
                uploadFailures.remove(photo.id)
            }
        } catch {
            uploadFailures.formUnion(toFinalize.map(\.id))
            throw error
        }
    }

    private func stageAndUpload(_ photos: [PhotoImportRunPhoto], runID: RunShortcode) async throws {
        let hashes = try Dictionary(uniqueKeysWithValues: photos.map { ($0.id, try $0.file.sha256()) })
        let items = try photos.map { photo -> PhotoImportStageItem in
            guard
                let contentType = PhotoImportStageItem.ContentTypePayload(rawValue: photo.file.contentType)
            else { throw Failure.unsupportedContentType(photo.file.contentType) }
            return PhotoImportStageItem(
                clientId: photo.id, filename: photo.file.filename, contentType: contentType,
                size: photo.file.size, width: photo.file.width, height: photo.file.height,
                sha256: hashes[photo.id] ?? "")
        }
        let response = try await client.stagePhotoImport(
            PhotoImportStageInput(items: items, runId: runID))
        let filesByID = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0.file) })
        var uploads: [(id: String, imageID: ImageCode, url: URL, file: PhotoFile)] = []
        var failed: [String] = []

        for result in response.items {
            if let existing = result.value1 {
                staged[existing.clientId] = StagedUpload(
                    imageID: existing.imageId, sha256: hashes[existing.clientId] ?? "")
            } else if let upload = result.value2 {
                guard let file = filesByID[upload.clientId], let url = URL(string: upload.uploadUrl)
                else { throw Failure.invalidStageResponse(upload.clientId) }
                uploads.append((upload.clientId, upload.imageId, url, file))
            } else if let failure = result.value3 {
                failed.append(failure.clientId)
            } else {
                throw Failure.invalidStageResponse("unknown")
            }
        }

        let uploadResults = await performUploads(uploads)
        for result in uploadResults {
            switch result.outcome {
            case .success:
                staged[result.id] = StagedUpload(imageID: result.imageID, sha256: hashes[result.id] ?? "")
            case .failure:
                failed.append(result.id)
            }
        }
        guard failed.isEmpty else {
            uploadFailures.formUnion(failed)
            throw Failure.stagingFailed(failed.sorted())
        }
    }

    private func performUploads(
        _ uploads: [(id: String, imageID: ImageCode, url: URL, file: PhotoFile)]
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
                enqueue()
            }
            return results.keys.sorted().compactMap { results[$0] }
        }
    }

    private func analyzeRemaining(report: (@Sendable (Progress) -> Void)?) async {
        let pending = photos.filter { finalizedIDs.contains($0.id) && !analyzedIDs.contains($0.id) }
        await runAnalysis(pending, report: report)
    }

    /// Re-runs local analysis for exactly the photos currently in `analysisFailures`, ignoring
    /// anything already analyzed or never finalized. The uploader's own per-photo state means
    /// this is a plain re-queue of just those photos, not a second full pass over the run.
    public func retryFailedAnalysis(report: (@Sendable (Progress) -> Void)? = nil) async {
        let pending = photos.filter { analysisFailures.contains($0.id) }
        await runAnalysis(pending, report: report)
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
                group.addTask { await self.analyzeOne(photo) }
            }
            for _ in 0..<min(analysisConcurrency, pending.count) { enqueue() }
            for await _ in group {
                report?(progress)
                enqueue()
            }
        }
    }

    private func analyzeOne(_ photo: PhotoImportRunPhoto) async {
        guard let entry = staged[photo.id] else { return }
        if let runID {
            reportDeviceWork(runID: runID, image: entry.imageID, state: .running)
        }
        if await awaitFavorableConditions(), let runID {
            reportDeviceWork(runID: runID, image: entry.imageID, state: .paused)
        }
        do {
            let analysis = try await analyze(
                PhotoAnalysisInput(id: photo.id, file: photo.file, provenance: photo.provenance))
            _ = try await client.recordImageAnalysis(entry.imageID, ImageAnalysisOutput(analysis))
            analyzedIDs.insert(photo.id)
            analysisFailures.remove(photo.id)
            // Completion is optional: the server already marks this target completed when it
            // records the analysis above, so posting it again here would be redundant.
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

    /// Bounded so a stuck thermal/power state cannot stall the background analysis pass forever —
    /// after ~1 minute of polling it proceeds anyway rather than never posting analysis at all.
    /// Returns whether it actually had to wait at least once, so callers only report `paused` when
    /// conditions were genuinely unfavorable.
    private func awaitFavorableConditions() async -> Bool {
        var attempts = 0
        while !systemConditionsFavorable(), attempts < 30 {
            attempts += 1
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
        return attempts > 0
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
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var progress = PhotoImportRunUploader.Progress()
    public private(set) var runID: RunShortcode?
    /// The photos whose local analysis failed, for the "needs retry" list — mirrors the actor's
    /// `failedAnalysisPhotos` after every progress update.
    public private(set) var failedAnalysisPhotos: [PhotoImportRunPhoto] = []

    private let uploader: PhotoImportRunUploader
    private var task: Task<Void, Never>?
    private var targetRunID: RunShortcode?
    private var createRunInput: PhotoImportCreateRunInput?

    public init(uploader: PhotoImportRunUploader) {
        self.uploader = uploader
    }

    public var isRunning: Bool { phase == .running }
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
        createRun: PhotoImportCreateRunInput? = nil
    ) {
        guard task == nil else { return }
        if let runID { targetRunID = runID }
        if let createRun { createRunInput = createRun }
        progress.total = photos.count
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
                    photos, runID: targetRunID, createRun: createRunInput
                ) {
                    [weak self, uploader] update in
                    Task { @MainActor in
                        guard let self else { return }
                        self.progress = update
                        self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                        if update.total > 0, update.uploaded == update.total {
                            self.runID = await uploader.runID
                            self.phase = .complete
                        }
                    }
                }
                self.runID = resolved
                self.progress = await uploader.progress
                self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                self.phase = .complete
            } catch is CancellationError {
                self.progress = await uploader.progress
                self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                if progress.total > 0, progress.uploaded == progress.total {
                    self.runID = await uploader.runID
                    self.phase = .complete
                } else {
                    self.phase = .cancelled
                }
            } catch {
                self.progress = await uploader.progress
                self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                self.phase = .failed(Self.message(for: error))
            }
            self.task = nil
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
                    self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
                }
            }
            self.progress = await uploader.progress
            self.failedAnalysisPhotos = await uploader.failedAnalysisPhotos
            self.task = nil
        }
    }

    /// Stops further chunks from starting; chunks already finalized stay finalized (the server has
    /// them), so calling `start(_:)` again with the same photos picks up where this left off.
    public func cancel() {
        task?.cancel()
    }

    private static func message(for error: any Error) -> String {
        if let error = error as? PhotoImportRunUploader.Failure {
            return error.errorDescription ?? String(describing: error)
        }
        if let error = error as? CubbyAPIError {
            return error.detail?.message ?? "HTTP \(error.status)"
        }
        return String(describing: error)
    }
}
