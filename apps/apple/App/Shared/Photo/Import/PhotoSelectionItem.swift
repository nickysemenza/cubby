import CoreGraphics
import CoreLocation
import CubbyKit
import Foundation
import Photos

/// Selection retains the source and its capture date even when an existing Cubby image is reused.
nonisolated struct PhotoSelectionItem: Identifiable, Sendable {
    enum Source: Sendable {
        case library(PHAsset)
        case file(PhotoFile)
    }

    let id: String
    let source: Source
    let preview: CGImage
    let capturedAt: Date?
    private let queryOverride: HashQuery?
    var existingImageID: ImageCode?
    var approvedCandidates: Set<ImageCode> = []

    /// For the capture-date provenance caption's reverse-geocoded city (A2). Computed from the
    /// retained `PHAsset` rather than stored, so it needs no separate population step; nil for a
    /// picker/file import since `PhotoFile` carries no location metadata yet.
    var location: CLLocation? {
        switch source {
        case .library(let asset): asset.location
        case .file: nil
        }
    }

    init(asset: PHAsset, preview: CGImage) {
        id = asset.localIdentifier
        source = .library(asset)
        self.preview = preview
        capturedAt = asset.creationDate
        queryOverride = nil
    }

    init(file: PhotoFile, preview: CGImage, query: HashQuery? = nil, id: String = UUID().uuidString) {
        self.id = id
        source = .file(file)
        self.preview = preview
        capturedAt = file.capturedAt
        queryOverride = query
    }

    func materialize(progress: (@Sendable (Double) -> Void)? = nil) async throws -> PhotoFile {
        switch source {
        case .library(let asset): try await PhotoLibraryIO.shared.file(for: asset, progress: progress)
        case .file(let file): file
        }
    }

    var importFilename: String {
        switch source {
        case .file(let file): file.filename
        case .library(let asset):
            PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "Photo"
        }
    }

    @MainActor func importLibraryFields(file: PhotoFile) -> ImageSightingReportFields? {
        guard case .library(let asset) = source else { return nil }
        let metadata = LibrarySightingBuilder.metadata(
            from: PHAssetLibraryFacts(asset: asset), cloudIdentifier: nil
        )
        .mergingFileEXIF(
            camera: file.camera, gpsLocation: file.gpsLocation,
            captureTimeZoneOffsetMinutes: file.captureTimeZoneOffsetMinutes)
        return LibrarySightingBuilder.reportFields(
            for: metadata, installationID: AppInstallationID.current.uuidString.lowercased())
    }

    func query() async throws -> HashQuery {
        if let queryOverride { return queryOverride }
        let image: CGImage
        switch source {
        case .library(let asset):
            // A separate final-quality PhotoKit request, independent of cached grid thumbnails.
            image = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: true)
        case .file(let file):
            return try await Task.detached(priority: .userInitiated) {
                try PreparedPhoto.prepare(file: file).hashQuery
            }.value
        }
        let task = Task.detached(priority: .userInitiated) {
            let hash = try PerceptualHash64.compute(image)
            let ratio = Double(max(image.width, image.height)) / Double(min(image.width, image.height))
            return HashQuery(
                perceptualHash: hash, aspectRatio: ratio,
                sourceFingerprint: SourceFingerprint(hash: hash, aspectRatio: ratio))
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }
}
