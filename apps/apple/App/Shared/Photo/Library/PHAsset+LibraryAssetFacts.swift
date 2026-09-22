import CoreLocation
import CubbyKit
import Photos

/// Wraps one `PHAsset` to satisfy `LibraryAssetFacts`. A direct `PHAsset` extension would collide
/// with several of the asset's own members (`sourceType`, `location`, `mediaSubtypes`, and
/// `pixelWidth`/`pixelHeight` are already declared on `PHAsset` with different types than the
/// protocol wants), so the mapping lives on this thin wrapper instead.
///
/// `PHAsset` itself carries no camera EXIF (`camera`/`captureTimeZoneOffsetMinutes` are always
/// `nil` here) — only a materialized `PhotoFile`'s EXIF read has that, merged in by
/// `LibraryAssetMetadata.mergingFileEXIF`. Every other fact below is a direct, verified `PHAsset`
/// read; `addedDate` is iOS/macOS 26+, matching this app's deployment target.
struct PHAssetLibraryFacts: LibraryAssetFacts {
    let asset: PHAsset

    var localIdentifier: String { asset.localIdentifier }

    var originalFilename: String? {
        PHAssetResource.assetResources(for: asset).first?.originalFilename
    }

    var creationDate: Date? { asset.creationDate }
    var addedDate: Date? { asset.addedDate }
    var modificationDate: Date? { asset.modificationDate }

    var location: LibraryAssetMetadata.Location? {
        guard let location = asset.location else { return nil }
        return LibraryAssetMetadata.Location(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            altitude: location.verticalAccuracy >= 0 ? location.altitude : nil,
            horizontalAccuracy: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil)
    }

    var sourceType: ImageSightingSourceType {
        if asset.sourceType.contains(.typeCloudShared) { return .cloudShared }
        if asset.sourceType.contains(.typeiTunesSynced) { return .iTunesSynced }
        return .userLibrary
    }

    var mediaSubtypes: [String] {
        var labels: [String] = []
        if asset.mediaSubtypes.contains(.photoScreenshot) { labels.append("screenshot") }
        if asset.mediaSubtypes.contains(.photoLive) { labels.append("livePhoto") }
        if asset.mediaSubtypes.contains(.photoHDR) { labels.append("hdr") }
        if asset.mediaSubtypes.contains(.photoPanorama) { labels.append("panorama") }
        if asset.mediaSubtypes.contains(.photoDepthEffect) { labels.append("depthEffect") }
        return labels
    }

    var hasAdjustments: Bool { asset.hasAdjustments }
    var isFavorite: Bool { asset.isFavorite }
    var pixelWidth: Int { asset.pixelWidth }
    var pixelHeight: Int { asset.pixelHeight }
    var burstIdentifier: String? { asset.burstIdentifier }
    var camera: LibraryAssetMetadata.Camera? { nil }
    var captureTimeZoneOffsetMinutes: Int? { nil }
}
