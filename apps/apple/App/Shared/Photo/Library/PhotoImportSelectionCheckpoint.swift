import CoreGraphics
import CubbyKit
import Foundation
import Photos

/// Selection intent is committed before PhotoKit starts downloading originals. Preparation
/// can therefore restart after termination; a failed asset remains named in the selection.
nonisolated struct PhotoImportSelectionCheckpoint: Codable {
    nonisolated struct Entry: Codable {
        var id: String
        var assetIdentifier: String?
        var fileURL: URL?
        var filename: String?
        var capturedAt: Date?
    }
    var entries: [Entry]
    var runID: RunShortcode?
    var createRun: PhotoImportCreateRunInput?
    var cancelled = false
    var notificationsRequested = false

    nonisolated struct Unavailable: Identifiable {
        let entry: Entry
        let error: String
        var id: String { entry.id }
    }

    nonisolated struct Recovery {
        var items: [PhotoSelectionItem] = []
        var unavailable: [Unavailable] = []
    }

    static func prepare(
        items: [PhotoSelectionItem], runID: RunShortcode?, createRun: PhotoImportCreateRunInput?,
        notificationsRequested: Bool, at url: URL
    ) throws -> Self {
        let directory = url.deletingPathExtension().appendingPathExtension("files")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var journalDirectory = url.deletingLastPathComponent()
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try journalDirectory.setResourceValues(values)
        let entries = try items.enumerated().map { index, item in
            switch item.source {
            case .library(let asset):
                return Entry(
                    id: item.id, assetIdentifier: asset.localIdentifier,
                    filename: item.importFilename, capturedAt: item.capturedAt)
            case .file(let file):
                let destination = directory.appendingPathComponent("\(index)")
                if !FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.copyItem(at: file.url, to: destination)
                }
                return Entry(
                    id: item.id, fileURL: destination, filename: file.filename, capturedAt: file.capturedAt)
            }
        }
        let archive = Self(
            entries: entries, runID: runID, createRun: createRun,
            notificationsRequested: notificationsRequested)
        try JSONEncoder().encode(archive).write(to: url, options: .atomic)
        return archive
    }

    @MainActor func selection() async -> Recovery {
        var result = Recovery()
        for entry in entries {
            do {
                if let identifier = entry.assetIdentifier {
                    guard
                        let asset = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil)
                            .firstObject
                    else {
                        throw PhotoLibraryFailure.cloudUnavailable
                    }
                    let preview: CGImage
                    do { preview = try await PhotoLibraryIO.shared.thumbnail(for: asset) } catch {
                        guard
                            let fallback = CGContext(
                                data: nil, width: 2, height: 2,
                                bitsPerComponent: 8, bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
                        else { throw error }
                        preview = fallback
                    }
                    result.items.append(PhotoSelectionItem(asset: asset, preview: preview))
                } else if let url = entry.fileURL {
                    let file = try PhotoFile.importing(url, filename: entry.filename)
                    result.items.append(
                        PhotoSelectionItem(file: file, preview: try file.thumbnail(), id: entry.id))
                }
            } catch {
                result.unavailable.append(Unavailable(entry: entry, error: error.userMessage))
            }
        }
        return result
    }
}
