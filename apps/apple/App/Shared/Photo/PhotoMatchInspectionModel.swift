import CoreGraphics
import CryptoKit
import CubbyKit
import Foundation
import Observation
import Photos

@MainActor
@Observable
final class PhotoMatchInspectionModel {
    typealias Report = PhotoMatchDiagnosticReport
    var expectedOwnerShortcode = ""
    private(set) var report: Report?
    private(set) var stage: String?
    private(set) var export: PhotoMatchExport?
    private(set) var exportError: String?
    private(set) var thumbnail: CGImage?
    private(set) var materializedThumbnail: CGImage?
    private(set) var file: PhotoFile?
    let contentDiagnostics = PhotoDiagnosticsModel()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()

    /// Snapshot synchronously, before any PhotoKit, cache or server await. In particular, never
    /// call PhotoLibraryStore.query or PhotoMatchStore.refresh here: both can change the evidence.
    func inspect(
        asset: PHAsset, matches: PhotoMatchStore, analysisStore: PhotoAnalysisStore?,
        client: CubbyClient
    ) {
        inspect(
            snapshot: matches.inspectorSnapshot(for: asset.localIdentifier),
            localIdentifier: asset.localIdentifier, assetWidth: asset.pixelWidth,
            assetHeight: asset.pixelHeight,
            assetModificationDate: asset.modificationDate, analysisStore: analysisStore,
            readIndex: { try await client.imageHashIndex() },
            authorization: { PHPhotoLibrary.authorizationStatus(for: .readWrite) },
            loadThumbnail: { progress in
                try await PhotoLibraryIO.shared.thumbnail(for: asset, network: true, progress: progress)
            },
            materialize: { progress in
                try await PhotoLibraryIO.shared.file(for: asset, network: true, progress: progress)
            })
    }

    /// PhotoKit and the HTTP GET are external seams; tests supply these without a real library.
    @discardableResult
    func inspect(
        snapshot: PhotoMatchInspectorSnapshot, localIdentifier: String, assetWidth: Int, assetHeight: Int,
        assetModificationDate: Date?, analysisStore: PhotoAnalysisStore?,
        readIndex: @escaping @Sendable () async throws -> ImageHashIndex,
        authorization: @escaping @Sendable () -> PHAuthorizationStatus,
        loadThumbnail: @escaping @Sendable (@escaping @Sendable (Double) -> Void) async throws -> CGImage,
        materialize: @escaping @Sendable (@escaping @Sendable (Double) -> Void) async throws -> PhotoFile
    ) -> Task<Void, Never> {
        cancel()
        let token = UUID()
        generation = token
        let owner = expectedOwnerShortcode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let empty = Report.HashInput(actualHash: nil, width: nil, height: nil)
        report = Report(
            initial: .init(
                state: snapshot.gridState.matchState.rawValue,
                registeredQuery: snapshot.registeredQuery, capturedAt: snapshot.capturedAt,
                localIdentifier: localIdentifier, assetModificationDate: assetModificationDate,
                assetWidth: assetWidth, assetHeight: assetHeight, coverage: snapshot.coverage,
                serverError: snapshot.matchError, totalCount: snapshot.totalEntries,
                remainingCount: snapshot.remainingEntries),
            inputs: .init(file: empty, thumbnail: empty, materialized: empty),
            candidates: snapshot.candidates, loadedServerEntries: snapshot.entries,
            expectedOwnerShortcode: owner.isEmpty ? nil : owner)
        if let error = snapshot.matchError {
            report?.issues.append(.init(stage: .loadedIndex, message: error))
        }
        if !snapshot.gridState.indexIsComplete {
            report?.issues.append(.init(stage: .loadedIndex, message: snapshot.coverage))
        }
        export = nil
        exportError = nil
        thumbnail = nil
        materializedThumbnail = nil
        file = nil
        stage = "Reading cached hash…"
        let work = Task { [weak self] in
            guard let self else { return }
            do {
                try check(token)
                // A cache read is recorded even when PhotoKit access has since been revoked.
                if let analysisStore {
                    do {
                        let record = try await analysisStore.record(for: localIdentifier)
                        try check(token)
                        report?.cacheRead = .init(
                            status: .success, perceptualHash: record?.perceptualHash,
                            revision: record?.hashRevision,
                            message: record == nil ? "No cached record" : nil,
                            modificationDate: record?.modificationDate)
                    } catch {
                        try check(token)
                        report?.cacheRead = .init(status: .failure, message: error.localizedDescription)
                        failure(error, stage: .cacheRead)
                    }
                } else {
                    report?.cacheRead = .init(status: .failure, message: "Local hash cache is unavailable")
                    report?.issues.append(
                        .init(stage: .cacheRead, message: "Local hash cache is unavailable"))
                }

                stage = "Reading server index (no repair)…"
                do {
                    let document = try await readIndex()
                    try check(token)
                    _ = try HashIndex(entries: [], algorithmRevision: document.algorithmRevision.rawValue)
                    report?.freshServerIndex = .init(
                        status: document.repair.isEmpty ? .success : .partial,
                        algorithmRevision: document.algorithmRevision.rawValue,
                        entries: try document.items.map(ImageHashEntry.init),
                        message: document.repair.isEmpty
                            ? nil : "\(document.repair.count) images are not indexed; no repair was attempted"
                    )
                } catch {
                    try check(token)
                    report?.freshServerIndex = .init(status: .failure, message: error.localizedDescription)
                    failure(error, stage: .freshIndex)
                }

                let access = authorization()
                guard access == .authorized || access == .limited else {
                    throw InspectionFailure.permission
                }
                stage = "Requesting full-frame Photos thumbnail…"
                do {
                    let image = try await loadThumbnail(progress(token, label: "Downloading thumbnail"))
                    try check(token)
                    let input = try await Self.hash(
                        image, originalWidth: assetWidth,
                        originalHeight: assetHeight)
                    try check(token)
                    thumbnail = image
                    if let inputs = report?.inputs {
                        report?.inputs = .init(
                            file: inputs.file, thumbnail: input, materialized: inputs.materialized)
                    }
                } catch {
                    try check(token)
                    if error is CancellationError { throw error }
                    failure(error, stage: .thumbnail)
                }

                stage = "Materializing current Photos file…"
                do {
                    let materialized = try await materialize(
                        progress(token, label: "Downloading current file"))
                    try check(token)
                    let (original, input, hashImage) = try await Self.hash(materialized)
                    try check(token)
                    file = materialized
                    materializedThumbnail = hashImage
                    if let inputs = report?.inputs {
                        report?.inputs = .init(
                            file: original, thumbnail: inputs.thumbnail, materialized: input)
                    }
                } catch {
                    try check(token)
                    if error is CancellationError { throw error }
                    failure(error, stage: .materialization)
                }
                try await finish(token)
            } catch is CancellationError {
                guard token == generation else { return }
                report?.issues.append(
                    .init(stage: .cancelled, message: "Inspection cancelled; report is incomplete"))
                stage = nil
            } catch {
                guard token == generation else { return }
                failure(error, stage: .permission)
                do { try await finish(token) } catch { stage = nil }
            }
        }
        task = work
        return work
    }

    func cancel() {
        task?.cancel()
        task = nil
        generation = UUID()
        if stage != nil {
            report?.issues.append(
                .init(stage: .cancelled, message: "Inspection cancelled; report is incomplete"))
        }
        stage = nil
        contentDiagnostics.cancel()
    }

    func analyzeContents() {
        guard let file else { return }
        // Retains the old Diagnostics sections without its former cache write side effect.
        contentDiagnostics.run(file: file)
    }

    func shareFailed(_ error: Error) {
        exportError = error.localizedDescription
        Diagnostics.report(error, context: "photos.match.export")
    }

    func json() throws -> Data {
        let encoder = JSONEncoder.cubby()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(report)
    }

    private func check(_ token: UUID) throws {
        try Task.checkCancellation()
        guard token == generation else { throw CancellationError() }
    }

    private func failure(_ error: Error, stage: Report.Issue.Stage) {
        report?.issues.append(.init(stage: stage, message: error.localizedDescription))
        Diagnostics.report(error, context: "photos.match.\(stage.rawValue)")
    }

    private func progress(_ token: UUID, label: String) -> @Sendable (Double) -> Void {
        { [weak self] value in
            Task { @MainActor in
                guard let self, self.generation == token, self.stage != nil else { return }
                self.stage = "\(label): \(Int(value * 100))%"
            }
        }
    }

    private func finish(_ token: UUID) async throws {
        try check(token)
        stage = "Comparing fingerprints…"
        if let current = report {
            let evaluated = await Self.evaluate(current)
            try check(token)
            report = evaluated
        }
        stage = "Preparing diagnostic files…"
        do {
            let files = try await PhotoMatchExport.prepare(json: json(), thumbnail: thumbnail, file: file)
            try check(token)
            export = files
        } catch {
            try check(token)
            shareFailed(error)
            report?.issues.append(.init(stage: .export, message: error.localizedDescription))
        }
        stage = nil
        task = nil
    }

    @concurrent private static func evaluate(_ report: Report) async -> Report {
        PhotoMatchDiagnostics.evaluate(report)
    }

    @concurrent private static func hash(_ image: CGImage, originalWidth: Int, originalHeight: Int)
        async throws -> Report.HashInput
    {
        try Task.checkCancellation()
        return try .init(
            actualHash: PerceptualHash64.compute(image), width: image.width,
            height: image.height, originalWidth: originalWidth, originalHeight: originalHeight)
    }

    @concurrent private static func hash(_ file: PhotoFile) async throws -> (
        Report.HashInput, Report.HashInput, CGImage
    ) {
        try Task.checkCancellation()
        let image = try file.thumbnail()
        let hash = try PerceptualHash64.compute(image)
        let sha = SHA256.hash(data: try Data(contentsOf: file.url, options: .mappedIfSafe))
            .map { String(format: "%02x", $0) }.joined()
        let original = Report.HashInput(actualHash: hash, width: file.width, height: file.height, sha256: sha)
        let input = Report.HashInput(
            actualHash: hash, width: image.width, height: image.height,
            originalWidth: file.width, originalHeight: file.height)
        return (original, input, image)
    }

    private enum InspectionFailure: LocalizedError {
        case permission
        var errorDescription: String? {
            "Photos permission is unavailable. Allow access to this photo in Settings, then inspect again."
        }
    }
}
