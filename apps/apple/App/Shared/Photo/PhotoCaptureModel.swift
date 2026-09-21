import CoreGraphics
import CubbyKit
import Foundation
import Observation

/// One photo on its way onto an entity. Subject lifting is a preview of the separately stored
/// derivative; upload and duplicate review always use the original encoded bytes.
@MainActor @Observable
final class PhotoCaptureModel {
    enum Phase: Equatable {
        case picking
        case preparing
        case lifting
        case ready
        case uploading(PhotoUploader.Step)
        case done(ImageCode)
        case failed(String)
    }

    let entity: EntityKey
    let entityID: String
    let entityTitle: String

    private(set) var phase: Phase = .picking
    private(set) var preparationProgress: Double?
    private(set) var original: CGImage?
    private(set) var lifted: LiftedImage?
    var useLifted = false {
        didSet {
            if useLifted != oldValue {
                uploadCheckpoint = nil
                uploadFailureCanRetry = false
            }
        }
    }
    private let background = SubjectLift.Background.transparent
    var makeCover: Bool

    private let uploader: PhotoUploader
    private let client: CubbyClient
    private let featurePrints: FeaturePrintIndex
    @ObservationIgnored private var preparationTask: Task<Void, Never>?
    private var selection: PhotoSelectionItem?
    private var originalPhoto: PreparedPhoto?
    private var originalReviewItem: PhotoSelectionItem?
    private var uploadCheckpoint: PhotoUploader.Checkpoint?
    private var uploadFailureCanRetry = false
    private var lifecycleGeneration = UUID()

    init(
        client: CubbyClient, entity: EntityKey, entityID: String, entityTitle: String,
        featurePrints: FeaturePrintIndex
    ) {
        self.entity = entity
        self.entityID = entityID
        self.entityTitle = entityTitle
        self.client = client
        self.featurePrints = featurePrints
        uploader = PhotoUploader(service: client)
        makeCover = entity == .product
    }

    var canMakeCover: Bool { entity == .product }
    var canUpload: Bool { phase == .ready || uploadFailureCanRetry }
    var hasDraft: Bool {
        switch phase {
        case .picking, .done:
            false
        default:
            true
        }
    }
    var canLift: Bool {
        selection != nil && (phase == .ready || (!uploadFailureCanRetry && isFailed))
    }

    /// Preview pixels only. Original uploads use `originalPhoto.file`, never these pixels.
    var chosen: CGImage? {
        if useLifted, let lifted, lifted.foundSubject { return lifted.image }
        return original
    }

    func uses(client: CubbyClient) -> Bool {
        self.client === client
    }

    func receive(_ selection: PhotoSelectionItem) {
        cancelPreparation()
        resetPreparedState()
        self.selection = selection
        original = selection.preview
        phase = .preparing
        let generation = lifecycleGeneration
        preparationTask = Task { [weak self] in
            guard let self else { return }
            await receive(selection, generation: generation)
        }
    }

    private func receive(_ selection: PhotoSelectionItem, generation: UUID) async {
        defer { finishPreparation(generation: generation) }
        do {
            if selection.existingImageID == nil {
                let file = try await selection.materialize { [weak self] progress in
                    Task { @MainActor [weak self] in
                        guard self?.lifecycleGeneration == generation, self?.preparationTask != nil else {
                            return
                        }
                        self?.preparationProgress = progress
                    }
                }
                let task = Task.detached(priority: .userInitiated) {
                    try PreparedPhoto.prepare(file: file)
                }
                let photo = try await withTaskCancellationHandler {
                    try await task.value
                } onCancel: {
                    task.cancel()
                }
                guard canPublish(generation) else { return }
                originalPhoto = photo
            }
            guard canPublish(generation) else { return }
            phase = .ready
        } catch is CancellationError {
        } catch {
            guard canPublish(generation) else { return }
            fail(error, context: "photo.prepare", uploadRetry: false)
        }
    }

    func prepareLift() {
        guard let selection else { return }
        cancelPreparation()
        let generation = lifecycleGeneration
        uploadCheckpoint = nil
        uploadFailureCanRetry = false
        phase = .lifting
        preparationTask = Task { [weak self] in
            guard let self else { return }
            await prepareLift(selection: selection, generation: generation)
        }
    }

    private func prepareLift(selection: PhotoSelectionItem, generation: UUID) async {
        defer { finishPreparation(generation: generation) }
        do {
            let photo: PreparedPhoto
            if let originalPhoto {
                photo = originalPhoto
            } else {
                let file = try await selection.materialize { [weak self] progress in
                    Task { @MainActor [weak self] in
                        guard self?.lifecycleGeneration == generation, self?.preparationTask != nil else {
                            return
                        }
                        self?.preparationProgress = progress
                    }
                }
                let task = Task.detached(priority: .userInitiated) {
                    try PreparedPhoto.prepare(file: file)
                }
                photo = try await withTaskCancellationHandler {
                    try await task.value
                } onCancel: {
                    task.cancel()
                }
            }
            guard canPublish(generation) else { return }
            let selectedBackground = background
            let task = Task.detached(priority: .userInitiated) {
                let image = try photo.file.decodeFullResolution()
                return try await SubjectLift.lift(
                    image, background: selectedBackground, cropToSubject: true)
            }
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            guard canPublish(generation) else { return }
            originalPhoto = photo
            lifted = result
            useLifted = result.foundSubject
            phase = .ready
        } catch is CancellationError {
        } catch {
            guard canPublish(generation) else { return }
            lifted = nil
            useLifted = false
            fail(error, context: "photo.lift", uploadRetry: false)
        }
    }

    /// Rechecks the exact pixels and metadata that would be uploaded. The first picker review
    /// uses a bounded PhotoKit preview, which can differ slightly from ImageIO's final file path.
    func finalSelectionForReview() async throws -> PhotoSelectionItem? {
        let generation = lifecycleGeneration
        guard let originalPhoto else { return nil }
        if let originalReviewItem { return originalReviewItem }
        let photo = originalPhoto
        guard canPublish(generation) else { throw CancellationError() }
        var item = PhotoSelectionItem(
            file: photo.file, preview: try photo.file.thumbnail(), query: photo.hashQuery)
        guard canPublish(generation) else { throw CancellationError() }
        item.approvedCandidates = selection?.approvedCandidates ?? []
        item.existingImageID = selection?.existingImageID
        originalReviewItem = item
        return item
    }

    func acceptFinalReview(_ item: PhotoSelectionItem) {
        let previousExistingID = selection?.existingImageID
        originalReviewItem = item
        selection?.existingImageID = item.existingImageID
        selection?.approvedCandidates = item.approvedCandidates
        if previousExistingID != item.existingImageID {
            uploadCheckpoint = nil
        }
    }

    func failPreparation(_ error: Error) {
        fail(error, context: "photo.review", uploadRetry: false)
    }

    func retake() {
        cancelPreparation()
        selection = nil
        original = nil
        resetPreparedState()
        phase = .picking
    }

    func cancelPendingWork() {
        cancelPreparation()
    }

    func upload() async {
        guard canUpload, selection != nil else { return }
        let generation = lifecycleGeneration
        phase = .uploading(.encoding)
        uploadFailureCanRetry = false
        do {
            if let existingID = selection?.existingImageID {
                try await uploader.attachExisting(
                    existingID, entity: entity, entityID: entityID,
                    makeCover: makeCover && canMakeCover
                ) { [weak self] step in
                    Task { @MainActor in self?.report(step, generation: generation) }
                }
                guard canPublish(generation) else { return }
                phase = .done(existingID)
                return
            }

            let photo: PreparedPhoto
            if let originalPhoto {
                photo = originalPhoto
            } else if let selection {
                let file = try await selection.materialize()
                let task = Task.detached(priority: .userInitiated) {
                    try PreparedPhoto.prepare(file: file)
                }
                photo = try await withTaskCancellationHandler {
                    try await task.value
                } onCancel: {
                    task.cancel()
                }
                guard canPublish(generation) else { return }
                originalPhoto = photo
            } else {
                throw PhotoFile.Failure.unreadable
            }
            let outcome = try await uploader.upload(
                .init(
                    photo: photo, entity: entity, entityID: entityID,
                    makeCover: makeCover && canMakeCover),
                resuming: uploadCheckpoint
            ) { [weak self] step in
                Task { @MainActor in self?.report(step, generation: generation) }
            }
            guard canPublish(generation) else { return }
            if entity == .product, let preview = original {
                try? await featurePrints.add(
                    productID: ProductCode(entityID), name: entityTitle, imageURL: outcome.url,
                    image: preview)
                try? await featurePrints.saveCache()
            }
            guard canPublish(generation) else { return }
            phase = .done(outcome.imageID)
        } catch let failure as PhotoUploader.Failure {
            guard canPublish(generation), !(failure.underlying is CancellationError) else { return }
            uploadCheckpoint = failure.checkpoint
            fail(failure.underlying, context: "photo.upload", uploadRetry: true)
        } catch is CancellationError {
        } catch {
            guard canPublish(generation) else { return }
            fail(error, context: "photo.upload", uploadRetry: true)
        }
    }

    private func report(_ step: PhotoUploader.Step, generation: UUID) {
        if canPublish(generation), case .uploading = phase { phase = .uploading(step) }
    }

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    private func fail(_ error: Error, context: String, uploadRetry: Bool) {
        uploadFailureCanRetry = uploadRetry
        if let apiError = error as? CubbyAPIError {
            phase = .failed(apiError.detail?.message ?? "HTTP \(apiError.status)")
        } else {
            phase = .failed(error.localizedDescription)
        }
        Diagnostics.report(error, context: context)
    }

    private func resetPreparedState() {
        uploadCheckpoint = nil
        originalPhoto = nil
        originalReviewItem = nil
        lifted = nil
        useLifted = false
        uploadFailureCanRetry = false
        preparationProgress = nil
    }

    private func cancelPreparation() {
        lifecycleGeneration = UUID()
        preparationTask?.cancel()
        preparationTask = nil
        preparationProgress = nil
    }

    private func finishPreparation(generation: UUID) {
        guard lifecycleGeneration == generation else { return }
        preparationTask = nil
        preparationProgress = nil
    }

    private func canPublish(_ generation: UUID) -> Bool {
        lifecycleGeneration == generation && !Task.isCancelled
    }
}
