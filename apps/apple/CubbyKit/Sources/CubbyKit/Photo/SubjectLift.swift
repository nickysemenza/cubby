import CoreGraphics
import CoreImage
import Foundation
import Vision

/// The result of lifting a subject: the image to upload and whether Vision found anything to
/// lift. When it did not, `image` is the original, never an error — a product on a busy bench is
/// still a photo worth keeping.
public struct LiftedImage: Sendable {
    public let image: CGImage
    public let foundSubject: Bool

    public init(image: CGImage, foundSubject: Bool) {
        self.image = image
        self.foundSubject = foundSubject
    }
}

/// Foreground-instance lifting with Vision, the same effect as pressing and
/// holding a subject in Photos. Every instance Vision finds is kept (a multi-pack is one product).
public enum SubjectLift {
    public enum Background: Sendable, Hashable {
        /// Composited over white: the catalog look, and what JPEG needs.
        case white
        /// Alpha kept: needs PNG on the wire.
        case transparent
    }

    /// One context for every lift; creating a `CIContext` per call is the expensive part.
    private static let context = CIContext(options: [.cacheIntermediates: false])

    @concurrent
    public static func lift(_ image: CGImage, background: Background = .white, cropToSubject: Bool = true)
        async throws -> LiftedImage
    {
        try Task.checkCancellation()
        // The Swift request reports requestCancelled for some uniform images with an uncancelled
        // parent. This API returns the actual empty observation instead; never reinterpret an error.
        let handler = VNImageRequestHandler(cgImage: image)
        let request = VNGenerateForegroundInstanceMaskRequest()
        try handler.perform([request])
        try Task.checkCancellation()
        guard let observation = request.results?.first,
            !observation.allInstances.isEmpty
        else {
            return LiftedImage(image: image, foundSubject: false)
        }
        let buffer = try observation.generateMaskedImage(
            ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: cropToSubject
        )
        var lifted = CIImage(cvPixelBuffer: buffer)
        let extent = lifted.extent
        if background == .white {
            lifted = lifted.composited(over: CIImage(color: .white).cropped(to: extent))
        }
        guard let result = context.createCGImage(lifted, from: extent) else {
            return LiftedImage(image: image, foundSubject: false)
        }
        return LiftedImage(image: result, foundSubject: true)
    }
}
