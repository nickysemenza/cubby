import CoreGraphics
import CubbyKit
import Foundation
import Photos
import Synchronization
import UniformTypeIdentifiers

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// PhotoKit may callback before returning its request ID, repeatedly, or during cancellation.
nonisolated private final class PhotoRequest<Value: Sendable>: Sendable {
    private struct State {
        var continuation: CheckedContinuation<Value, Error>?
        var result: Result<Value, Error>?
        var requestID: PHImageRequestID?
        var cancelled = false
    }
    private let state = Mutex(State())

    func install(_ continuation: CheckedContinuation<Value, Error>) {
        let result: Result<Value, Error>? = state.withLock { state in
            if let result = state.result { return result }
            state.continuation = continuation
            return nil
        }
        if let result { continuation.resume(with: result) }
    }

    func started(_ id: PHImageRequestID, manager: PHImageManager) {
        let cancelled = state.withLock { state in
            state.requestID = id
            return state.cancelled
        }
        if cancelled { manager.cancelImageRequest(id) }
    }

    func finish(_ result: Result<Value, Error>) {
        let continuation = state.withLock { state in
            guard state.result == nil else { return Optional<CheckedContinuation<Value, Error>>.none }
            state.result = result
            let continuation = state.continuation
            state.continuation = nil
            return continuation
        }
        continuation?.resume(with: result)
    }

    func cancel(manager: PHImageManager) {
        let id = state.withLock { state in
            state.cancelled = true
            return state.requestID
        }
        finish(.failure(CancellationError()))
        if let id { manager.cancelImageRequest(id) }
    }
}

actor PhotoLibraryIO {
    static let shared = PhotoLibraryIO()
    private let manager = PHCachingImageManager()
    /// Shared by every grid/hash-source request and by `startCaching`/`stopCaching`, so a
    /// pre-warmed cache entry actually matches what the grid later requests.
    private static let targetSize = CGSize(width: 256, height: 256)

    func thumbnail(for asset: PHAsset, network: Bool = false, progress: (@Sendable (Double) -> Void)? = nil)
        async throws -> CGImage
    {
        let options = PHImageRequestOptions()
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = network
        options.progressHandler = { value, _, _, _ in progress?(value) }
        let request = PhotoRequest<CGImage>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                request.install(continuation)
                let id = manager.requestImage(
                    for: asset, targetSize: Self.targetSize,
                    contentMode: .aspectFit, options: options
                ) { image, info in
                    if (info?[PHImageCancelledKey] as? Bool) == true {
                        request.finish(.failure(CancellationError()))
                    } else if let error = info?[PHImageErrorKey] as? Error {
                        request.finish(.failure(error))
                    } else if (info?[PHImageResultIsDegradedKey] as? Bool) != true {
                        #if os(macOS)
                            let decoded = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
                        #else
                            let decoded = image?.cgImage
                        #endif
                        if let decoded {
                            request.finish(.success(decoded))
                        } else {
                            request.finish(.failure(PhotoLibraryFailure.cloudUnavailable))
                        }
                    }
                }
                request.started(id, manager: manager)
            }
        } onCancel: { [manager] in
            request.cancel(manager: manager)
        }
    }

    /// Progressive grid thumbnails: `.opportunistic` may deliver a fast, low-resolution frame
    /// before the final one. The grid shows that degraded frame immediately instead of a blank
    /// cell while flinging, then replaces it once the final frame arrives. `query(_:)`'s hash
    /// source deliberately keeps using `thumbnail(for:)` above (`.highQualityFormat`, single
    /// frame) — a degraded frame must never become the input to a perceptual hash.
    func thumbnails(for asset: PHAsset, network: Bool = false)
        async -> AsyncThrowingStream<CGImage, Error>
    {
        let options = PHImageRequestOptions()
        options.version = .current
        options.deliveryMode = .opportunistic
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = network
        return AsyncThrowingStream { continuation in
            let id = manager.requestImage(
                for: asset, targetSize: Self.targetSize,
                contentMode: .aspectFit, options: options
            ) { image, info in
                if (info?[PHImageCancelledKey] as? Bool) == true {
                    continuation.finish(throwing: CancellationError())
                    return
                }
                if let error = info?[PHImageErrorKey] as? Error {
                    continuation.finish(throwing: error)
                    return
                }
                #if os(macOS)
                    let decoded = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
                #else
                    let decoded = image?.cgImage
                #endif
                let isDegraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
                guard let decoded else {
                    if !isDegraded { continuation.finish(throwing: PhotoLibraryFailure.cloudUnavailable) }
                    return
                }
                continuation.yield(decoded)
                if !isDegraded { continuation.finish() }
            }
            continuation.onTermination = { [manager] _ in manager.cancelImageRequest(id) }
        }
    }

    /// A 512px, local-only (no iCloud network fetch) thumbnail for the classification sweep
    /// (B3). Deliberately its own request rather than reusing `thumbnail(for:)`'s 256px grid
    /// size — Vision's classifier does better on a larger frame, and this must never register a
    /// `PHImageResultIsDegradedKey` frame as final the way the grid's progressive stream can.
    ///
    /// `PHImageRequestOptions` has no QoS/priority knob of its own — `PHImageManager` services
    /// every request on its own internal queue regardless of the calling `Task`'s priority, so
    /// the sweep's `Task(priority: .utility)` (`PhotoClassificationSweep.reconcile()`) governs
    /// only the Vision/actor work around this call, not the PhotoKit fetch itself.
    func classificationThumbnail(for asset: PHAsset) async throws -> CGImage {
        let options = PHImageRequestOptions()
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = false
        let request = PhotoRequest<CGImage>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                request.install(continuation)
                let id = manager.requestImage(
                    for: asset, targetSize: CGSize(width: 512, height: 512),
                    contentMode: .aspectFit, options: options
                ) { image, info in
                    if (info?[PHImageCancelledKey] as? Bool) == true {
                        request.finish(.failure(CancellationError()))
                    } else if let error = info?[PHImageErrorKey] as? Error {
                        request.finish(.failure(error))
                    } else if (info?[PHImageResultIsDegradedKey] as? Bool) != true {
                        #if os(macOS)
                            let decoded = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
                        #else
                            let decoded = image?.cgImage
                        #endif
                        if let decoded {
                            request.finish(.success(decoded))
                        } else {
                            request.finish(.failure(PhotoLibraryFailure.cloudUnavailable))
                        }
                    }
                }
                request.started(id, manager: manager)
            }
        } onCancel: { [manager] in
            request.cancel(manager: manager)
        }
    }

    /// `PhotosRootView` calls these for the visible month's assets ± one neighbor as sections
    /// scroll on/off screen, so PhotoKit has already decoded nearby thumbnails before a fling
    /// reaches them.
    func startCaching(_ assets: [PHAsset]) {
        manager.startCachingImages(
            for: assets, targetSize: Self.targetSize, contentMode: .aspectFit, options: nil)
    }

    func stopCaching(_ assets: [PHAsset]) {
        manager.stopCachingImages(
            for: assets, targetSize: Self.targetSize, contentMode: .aspectFit, options: nil)
    }

    func file(
        for asset: PHAsset, network: Bool = true,
        progress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> PhotoFile {
        let options = PHImageRequestOptions()
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = network
        options.progressHandler = { value, _, _, _ in progress?(value) }
        let request = PhotoRequest<PhotoFile>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                request.install(continuation)
                let id = manager.requestImageDataAndOrientation(for: asset, options: options) {
                    data, typeIdentifier, _, info in
                    if (info?[PHImageCancelledKey] as? Bool) == true {
                        request.finish(.failure(CancellationError()))
                        return
                    }
                    if let error = info?[PHImageErrorKey] as? Error {
                        request.finish(.failure(error))
                        return
                    }
                    guard let data, let typeIdentifier, let type = UTType(typeIdentifier),
                        let contentType = type.preferredMIMEType
                    else {
                        request.finish(.failure(PhotoLibraryFailure.cloudUnavailable))
                        return
                    }
                    do {
                        let ext = type.preferredFilenameExtension ?? "image"
                        let original = PHAssetResource.assetResources(for: asset).first?.originalFilename
                        let stem = original.map {
                            URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent
                        }
                        request.finish(
                            .success(
                                try PhotoFile.materialize(
                                    data: data, filename: "\(stem ?? "photo").\(ext)",
                                    contentType: contentType,
                                    capturedAt: asset.creationDate)))
                    } catch { request.finish(.failure(error)) }
                }
                request.started(id, manager: manager)
            }
        } onCancel: { [manager] in
            request.cancel(manager: manager)
        }
    }
}

nonisolated enum PhotoLibraryFailure: LocalizedError {
    case cloudUnavailable
    var errorDescription: String? {
        "This photo needs to download from iCloud. Select it to download, or try again when connected."
    }
}
