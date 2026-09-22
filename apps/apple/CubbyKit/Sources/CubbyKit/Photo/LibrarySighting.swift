import CubbyAPI
import Foundation

/// One PhotoKit asset's metadata, captured once at import or backfill time. CubbyKit itself never
/// imports Photos — `PHAsset` conforms to `LibraryAssetFacts` in the App target
/// (`App/Shared/Photo/Library/PHAsset+LibraryAssetFacts.swift`); tests substitute a plain fixture
/// struct with the same shape.
public struct LibraryAssetMetadata: Codable, Hashable, Sendable {
    public struct Location: Codable, Hashable, Sendable {
        public let latitude: Double
        public let longitude: Double
        public let altitude: Double?
        public let horizontalAccuracy: Double?

        public init(
            latitude: Double, longitude: Double, altitude: Double? = nil,
            horizontalAccuracy: Double? = nil
        ) {
            self.latitude = latitude
            self.longitude = longitude
            self.altitude = altitude
            self.horizontalAccuracy = horizontalAccuracy
        }
    }

    public struct Camera: Codable, Hashable, Sendable {
        public let make: String?
        public let model: String?
        public let lens: String?
        public let software: String?

        public init(
            make: String? = nil, model: String? = nil, lens: String? = nil, software: String? = nil
        ) {
            self.make = make
            self.model = model
            self.lens = lens
            self.software = software
        }

        /// Nothing worth sending — every field came back empty (no EXIF, or bytes never
        /// materialized). `LibrarySightingBuilder` omits the whole `camera` object in this case.
        public var isEmpty: Bool { make == nil && model == nil && lens == nil && software == nil }
    }

    public let localIdentifier: String
    /// Looked up separately (`PHPhotoLibrary.cloudIdentifierMappings(forLocalIdentifiers:)` is
    /// expensive and batched by the caller — never by this type or its builder) and passed in;
    /// `nil` when this asset has not synced to iCloud Photos from this device.
    public let cloudIdentifier: String?
    public let originalFilename: String?
    public let creationDate: Date?
    public let addedDate: Date?
    public let modificationDate: Date?
    public let location: Location?
    public let sourceType: ImageSightingSourceType
    /// Lowercase-first labels (`screenshot`, `livePhoto`, `hdr`, `panorama`, `depthEffect`, …) —
    /// see `LibraryAssetFacts` conformances for the `PHAssetMediaSubtype` mapping.
    public let mediaSubtypes: [String]
    public let hasAdjustments: Bool
    public let isFavorite: Bool
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let burstIdentifier: String?
    public let camera: Camera?
    public let captureTimeZoneOffsetMinutes: Int?

    public init(
        localIdentifier: String,
        cloudIdentifier: String? = nil,
        originalFilename: String? = nil,
        creationDate: Date? = nil,
        addedDate: Date? = nil,
        modificationDate: Date? = nil,
        location: Location? = nil,
        sourceType: ImageSightingSourceType,
        mediaSubtypes: [String] = [],
        hasAdjustments: Bool = false,
        isFavorite: Bool = false,
        pixelWidth: Int,
        pixelHeight: Int,
        burstIdentifier: String? = nil,
        camera: Camera? = nil,
        captureTimeZoneOffsetMinutes: Int? = nil
    ) {
        self.localIdentifier = localIdentifier
        self.cloudIdentifier = cloudIdentifier
        self.originalFilename = originalFilename
        self.creationDate = creationDate
        self.addedDate = addedDate
        self.modificationDate = modificationDate
        self.location = location
        self.sourceType = sourceType
        self.mediaSubtypes = mediaSubtypes
        self.hasAdjustments = hasAdjustments
        self.isFavorite = isFavorite
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.burstIdentifier = burstIdentifier
        self.camera = camera?.isEmpty == true ? nil : camera
        self.captureTimeZoneOffsetMinutes = captureTimeZoneOffsetMinutes
    }

    /// `ImageSighting.assetKey`: the cloud identifier when this device knows one, else a
    /// device-scoped fallback so two installs that have not both synced the same asset to iCloud
    /// Photos still each record a distinct, stable sighting rather than colliding on a bare local
    /// identifier (which is not unique across libraries).
    public func assetKey(installationID: String) -> String {
        cloudIdentifier ?? "local:\(installationID):\(localIdentifier)"
    }

    /// Fills in `camera`/`location`/`captureTimeZoneOffsetMinutes` from a materialized
    /// `PhotoFile`'s EXIF read when PhotoKit's own facts did not already carry them — `PHAsset`
    /// itself has no camera metadata, and `location` can be present on one side and not the other
    /// (a Limited Library selection, or GPS present in EXIF but stripped from the asset's own
    /// `CLLocation` by a privacy setting). PhotoKit's own value always wins when both are present.
    public func mergingFileEXIF(
        camera fileCamera: Camera?, gpsLocation fileLocation: Location?,
        captureTimeZoneOffsetMinutes fileOffsetMinutes: Int?
    ) -> LibraryAssetMetadata {
        LibraryAssetMetadata(
            localIdentifier: localIdentifier,
            cloudIdentifier: cloudIdentifier,
            originalFilename: originalFilename,
            creationDate: creationDate,
            addedDate: addedDate,
            modificationDate: modificationDate,
            location: location ?? fileLocation,
            sourceType: sourceType,
            mediaSubtypes: mediaSubtypes,
            hasAdjustments: hasAdjustments,
            isFavorite: isFavorite,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            burstIdentifier: burstIdentifier,
            camera: camera ?? fileCamera,
            captureTimeZoneOffsetMinutes: captureTimeZoneOffsetMinutes ?? fileOffsetMinutes)
    }
}

/// The facts one PhotoKit asset (or a test fixture standing in for one) reports about itself.
/// Verified against `PHAsset`'s iOS/macOS 26 API: `addedDate` (26+), `sourceType`
/// (`PHAssetSourceType`), `mediaSubtypes` (`PHAssetMediaSubtype`), `hasAdjustments`,
/// `pixelWidth`/`pixelHeight`, `burstIdentifier`, `location`, `creationDate`, `modificationDate`.
public protocol LibraryAssetFacts: Sendable {
    var localIdentifier: String { get }
    var originalFilename: String? { get }
    var creationDate: Date? { get }
    var addedDate: Date? { get }
    var modificationDate: Date? { get }
    var location: LibraryAssetMetadata.Location? { get }
    var sourceType: ImageSightingSourceType { get }
    var mediaSubtypes: [String] { get }
    var hasAdjustments: Bool { get }
    var isFavorite: Bool { get }
    var pixelWidth: Int { get }
    var pixelHeight: Int { get }
    var burstIdentifier: String? { get }
    /// EXIF-sourced, so only populated when full-resolution bytes have already been read
    /// (`PhotoFile.materialize`/`PhotoFile.importing`) — a `PHAsset` on its own carries no camera
    /// metadata. `nil` here means "not yet known", not "no camera".
    var camera: LibraryAssetMetadata.Camera? { get }
    /// EXIF `OffsetTimeOriginal`, converted to minutes — same materialize-only caveat as `camera`.
    var captureTimeZoneOffsetMinutes: Int? { get }
}

/// Builds the two shapes `ImageSighting`-related data takes on the wire from one set of library
/// facts: the photo-import commit item's `library` sibling of `analysis`
/// (`ImageSightingReportFields`), and a library-scan match's `ImageSightingCreateInput` (used only
/// by `LibraryMetadataSync`'s backward path — the forward/import path never constructs a create
/// input itself; the server derives the `import` sighting from the commit item's `library` block).
public enum LibrarySightingBuilder {
    public static func metadata(
        from facts: some LibraryAssetFacts, cloudIdentifier: String?
    ) -> LibraryAssetMetadata {
        LibraryAssetMetadata(
            localIdentifier: facts.localIdentifier,
            cloudIdentifier: cloudIdentifier,
            originalFilename: facts.originalFilename,
            creationDate: facts.creationDate,
            addedDate: facts.addedDate,
            modificationDate: facts.modificationDate,
            location: facts.location,
            sourceType: facts.sourceType,
            mediaSubtypes: facts.mediaSubtypes,
            hasAdjustments: facts.hasAdjustments,
            isFavorite: facts.isFavorite,
            pixelWidth: facts.pixelWidth,
            pixelHeight: facts.pixelHeight,
            burstIdentifier: facts.burstIdentifier,
            camera: facts.camera,
            captureTimeZoneOffsetMinutes: facts.captureTimeZoneOffsetMinutes)
    }

    public static func reportFields(
        for metadata: LibraryAssetMetadata, installationID: String, observedAt: Date = .now
    ) -> ImageSightingReportFields {
        ImageSightingReportFields(
            assetKey: metadata.assetKey(installationID: installationID),
            cloudIdentifier: metadata.cloudIdentifier,
            localIdentifier: metadata.localIdentifier,
            sourceType: metadata.sourceType,
            mediaSubtypes: metadata.mediaSubtypes,
            originalFilename: metadata.originalFilename,
            pixelWidth: metadata.pixelWidth,
            pixelHeight: metadata.pixelHeight,
            hasAdjustments: metadata.hasAdjustments,
            capturedAt: metadata.creationDate,
            capturedAtOffsetMinutes: metadata.captureTimeZoneOffsetMinutes,
            addedAt: metadata.addedDate,
            location: locationInput(metadata.location),
            placeName: nil,
            camera: cameraInput(metadata.camera),
            hashDistance: nil,
            aspectGate: nil,
            observedAt: observedAt)
    }

    /// `matchKind` is always `.libraryMatch`: this builder is never used for the import path, which
    /// the server derives server-side from the commit item's `library` block instead.
    public static func createInput(
        imageId: ImageShortcode,
        deviceId: DeviceShortcode,
        ledgerPartyId: LedgerPartyShortcode? = nil,
        metadata: LibraryAssetMetadata,
        installationID: String,
        hashDistance: Int?,
        aspectGate: Bool?,
        observedAt: Date = .now
    ) -> ImageSightingCreateInput {
        ImageSightingCreateInput(
            imageId: imageId,
            ledgerPartyId: ledgerPartyId,
            deviceId: deviceId,
            assetKey: metadata.assetKey(installationID: installationID),
            cloudIdentifier: metadata.cloudIdentifier,
            localIdentifier: metadata.localIdentifier,
            sourceType: metadata.sourceType,
            mediaSubtypes: metadata.mediaSubtypes,
            originalFilename: metadata.originalFilename,
            pixelWidth: metadata.pixelWidth,
            pixelHeight: metadata.pixelHeight,
            hasAdjustments: metadata.hasAdjustments,
            capturedAt: metadata.creationDate,
            capturedAtOffsetMinutes: metadata.captureTimeZoneOffsetMinutes,
            addedAt: metadata.addedDate,
            location: locationInput(metadata.location),
            placeName: nil,
            camera: cameraInput(metadata.camera),
            matchKind: .libraryMatch,
            hashDistance: hashDistance,
            aspectGate: aspectGate,
            observedAt: observedAt)
    }

    private static func locationInput(
        _ location: LibraryAssetMetadata.Location?
    ) -> ImageSightingLocationInput? {
        location.map {
            ImageSightingLocationInput(
                lat: $0.latitude, lng: $0.longitude, altitude: $0.altitude,
                horizontalAccuracy: $0.horizontalAccuracy)
        }
    }

    private static func cameraInput(
        _ camera: LibraryAssetMetadata.Camera?
    ) -> ImageSightingCameraInput? {
        camera.map {
            ImageSightingCameraInput(make: $0.make, model: $0.model, lens: $0.lens, software: $0.software)
        }
    }
}
