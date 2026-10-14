import Foundation

/// The journal and its owned files survive termination. A cancelled selection is retained for
/// inspection but is never automatically continued; confirmed server photos are never deleted.
public struct PhotoImportRunCheckpoint: Codable, Sendable {
    public struct Photo: Codable, Sendable {
        var id: String
        var filename: String
        var contentType: String
        var size: Int
        var width: Int
        var height: Int
        var capturedAt: Date?
        var provenance: PhotoAnalysisProvenance
        var library: ImageSightingReportFields?
        var captureTimeZoneOffsetMinutes: Int?
        var camera: LibraryAssetMetadata.Camera?
        var gpsLocation: LibraryAssetMetadata.Location?
    }

    public struct Uploaded: Codable, Sendable {
        var imageID: ImageCode
        var sha256: String
    }

    struct Pending: Codable, Sendable {
        var imageID: ImageCode
        var sha256: String
        var url: URL
    }
    var pending: [String: Pending] = [:]
    var photos: [Photo]
    public var runID: RunShortcode?
    public var createRun: PhotoImportCreateRunInput?
    var uploaded: [String: Uploaded] = [:]
    var finalized: Set<String> = []
    var analyzed: Set<String> = []
    var excluded: Set<String> = []
    var analysisExcluded: Set<String> = []
    var cancelled = false
    var clientBatchID: String
    public var notificationsRequested = false
    var legacy = false
    var admissionAttempted: Bool?
    var admitted = false
    var sealed = false
    var positionOffset = 0

    public var needsCancellationSettlement: Bool {
        cancelled && (admitted || admissionAttempted == true) && !sealed
    }
    public var shouldResume: Bool {
        !cancelled
            && (finalized.count + excluded.count < photos.count
                || !finalized.subtracting(analyzed).subtracting(analysisExcluded).isEmpty)
    }

    public static func journals(in directory: URL) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
    }

    public static func pending(in directory: URL) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .filter {
                let state = try JSONDecoder().decode(Self.self, from: Data(contentsOf: $0))
                return state.shouldResume
            }
    }

    public static func cancelledAwaitingSeal(in directory: URL) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .filter {
                let state = try JSONDecoder().decode(Self.self, from: Data(contentsOf: $0))
                return state.cancelled && state.admitted && !state.sealed
            }
    }

    public func materializedPhotos(at url: URL) throws -> [PhotoImportRunPhoto] {
        try photos.enumerated().map { index, photo in
            PhotoImportRunPhoto(
                id: photo.id,
                file: try PhotoFile(
                    url: url.deletingPathExtension().appendingPathComponent("\(index)"),
                    filename: photo.filename, contentType: photo.contentType, size: photo.size,
                    width: photo.width, height: photo.height, capturedAt: photo.capturedAt,
                    captureTimeZoneOffsetMinutes: photo.captureTimeZoneOffsetMinutes, camera: photo.camera,
                    gpsLocation: photo.gpsLocation),
                provenance: photo.provenance, library: photo.library)
        }
    }

    static func prepare(
        _ photos: [PhotoImportRunPhoto], runID: RunShortcode?, createRun: PhotoImportCreateRunInput?,
        clientBatchID: String, notificationsRequested: Bool = false, at url: URL
    ) throws -> Self {
        let directory = url.deletingPathExtension()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (index, photo) in photos.enumerated() {
            let destination = directory.appendingPathComponent("\(index)")
            if !FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.copyItem(at: photo.file.url, to: destination)
                #if os(iOS)
                    try FileManager.default.setAttributes(
                        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                        ofItemAtPath: destination.path)
                #endif
            }
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var ownedDirectory = directory
        try ownedDirectory.setResourceValues(values)
        var journalDirectory = url.deletingLastPathComponent()
        try journalDirectory.setResourceValues(values)
        let state = Self(
            photos: photos.map {
                Photo(
                    id: $0.id, filename: $0.file.filename, contentType: $0.file.contentType,
                    size: $0.file.size, width: $0.file.width, height: $0.file.height,
                    capturedAt: $0.file.capturedAt, provenance: $0.provenance, library: $0.library,
                    captureTimeZoneOffsetMinutes: $0.file.captureTimeZoneOffsetMinutes,
                    camera: $0.file.camera, gpsLocation: $0.file.gpsLocation)
            }, runID: runID, createRun: createRun, clientBatchID: clientBatchID,
            notificationsRequested: notificationsRequested)
        try state.save(at: url)
        return state
    }

    func save(at url: URL) throws {
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
    }
}
