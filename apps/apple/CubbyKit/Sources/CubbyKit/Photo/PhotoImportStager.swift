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
    public let sourceEntity: EntityKey
    public let sourceID: String
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

    public init(
        clientID: String,
        file: PhotoFile,
        analysis: PhotoLocalAnalysis,
        routeID: String,
        sourceEntity: EntityKey,
        sourceID: String,
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

/// Runs the import's presign/upload phase and its single atomic commit. The actor retains every
/// successful staged image and one idempotency key, so retrying a recoverable failure neither
/// uploads those bytes again nor creates duplicate associations after a lost response.
public actor PhotoImportTransaction {
    public enum Failure: Error, Sendable, Equatable {
        case unsupportedContentType(String)
        case stagingFailed([String])
        case invalidStageResponse(String)
    }

    private struct Staged: Sendable {
        let imageID: ImageCode
        let reusedExisting: Bool
    }

    private let client: CubbyClient
    private let put: PresignedUpload.FilePut
    private let maximumConcurrentUploads: Int
    private let idempotencyKey: String
    private var stagedByClientID: [String: Staged] = [:]

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
    ) async throws -> PhotoImportCommitOutput {
        try Task.checkCancellation()
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
            guard
                let sourceEntity = PhotoImportSourcePayload.EntityPayload(
                    rawValue: item.sourceEntity.rawValue)
            else {
                throw Failure.invalidStageResponse("unsupported source:\(item.sourceEntity.rawValue)")
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
                source: PhotoImportSourcePayload(entity: sourceEntity, id: item.sourceID),
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
        return try await client.commitPhotoImport(
            PhotoImportCommitInput(idempotencyKey: idempotencyKey, images: images, creates: drafts))
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
