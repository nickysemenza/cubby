import CoreGraphics
import CubbyKit
import Foundation
import Observation

/// One photo on its way onto an entity: picked → lifted → ready → uploading → done. The lift
/// runs as soon as a picture arrives so the sheet can show both versions; the upload only starts
/// on request and reports the uploader's steps as they happen.
@Observable
final class PhotoCaptureModel {
    enum Phase: Equatable {
        case picking
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
    private(set) var original: CGImage?
    private(set) var lifted: LiftedImage?
    /// Send the lifted version when Vision found a subject; the toggle is only shown then.
    var useLifted = true
    var background: SubjectLift.Background = .white {
        didSet { if background != oldValue, let original { Task { await lift(original) } } }
    }
    var makeCover: Bool

    private let uploader: PhotoUploader
    private let featurePrints: FeaturePrintIndex

    init(client: CubbyClient, entity: EntityKey, entityID: String, entityTitle: String, featurePrints: FeaturePrintIndex) {
        self.entity = entity
        self.entityID = entityID
        self.entityTitle = entityTitle
        self.featurePrints = featurePrints
        uploader = PhotoUploader(service: client)
        makeCover = entity == .product
    }

    var canMakeCover: Bool { entity == .product }

    /// The bytes that will go up: the lift when it found something and is selected, else the original.
    var chosen: CGImage? {
        if useLifted, let lifted, lifted.foundSubject { return lifted.image }
        return original
    }

    /// Transparent lifts need PNG; everything else is JPEG (HEIC never reaches the wire).
    var format: ImageEncoding.Format {
        useLifted && lifted?.foundSubject == true && background == .transparent ? .png : .jpeg
    }

    func receive(_ image: CGImage) async {
        original = image
        await lift(image)
    }

    func retake() {
        original = nil
        lifted = nil
        phase = .picking
    }

    func upload() async {
        guard let image = chosen, phase == .ready else { return }
        phase = .uploading(.encoding)
        do {
            let outcome = try await uploader.upload(
                .init(image: image, format: format, entity: entity, entityID: entityID, makeCover: makeCover && canMakeCover, filenameBase: entityID.lowercased())
            ) { step in
                Task { @MainActor [weak self] in
                    if case .uploading = self?.phase { self?.phase = .uploading(step) }
                }
            }
            if entity == .product {
                // Index the new photo right away so Identify can match it before the next rebuild.
                try? await featurePrints.add(productID: ProductCode(entityID), name: entityTitle, imageURL: outcome.url, image: image)
                try? await featurePrints.saveCache()
            }
            phase = .done(outcome.imageID)
        } catch let error as CubbyAPIError {
            phase = .failed(error.detail?.message ?? "HTTP \(error.status)")
        } catch {
            phase = .failed(String(describing: error))
        }
    }

    private func lift(_ image: CGImage) async {
        phase = .lifting
        do {
            lifted = try await SubjectLift.lift(image, background: background, cropToSubject: true)
        } catch {
            lifted = LiftedImage(image: image, foundSubject: false)
        }
        phase = .ready
    }
}
