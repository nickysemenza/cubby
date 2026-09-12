import CoreGraphics
import Foundation
import Vision

/// One product in the on-device index. `FeaturePrintObservation` is `Codable`, so entries cache
/// to disk as-is.
public struct FeaturePrintEntry: Sendable, Codable, Identifiable {
    public var id: ProductCode { productID }
    public let productID: ProductCode
    public let name: String
    public let imageURL: URL
    public let print: FeaturePrintObservation
}

public struct IdentificationCandidate: Sendable, Identifiable, Hashable {
    public var id: ProductCode { productID }
    public let productID: ProductCode
    public let name: String
    public let imageURL: URL
    /// Vision's feature-print distance: lower is closer. There is no documented scale, so this
    /// is shown as a rank and a raw number, never as a percentage.
    public let distance: Double
}

/// Nearest-neighbour lookup of a camera frame against the household's own product covers, using
/// Vision's image feature prints. Closed-set matching ("which of MY products is this") is where
/// feature prints work well; open-world identification belongs to the cloud vision model.
///
/// The disk cache is keyed by Vision revision in its filename: prints from two revisions must
/// never be compared, and `distance(to:)` throwing on mismatch is the backstop.
public actor FeaturePrintIndex {
    public static let revision = GenerateImageFeaturePrintRequest.Revision.revision2
    /// Bump when `revision` changes so an old cache is never compared against new prints.
    static let revisionTag = "rev2"

    private var entries: [ProductCode: FeaturePrintEntry] = [:]
    private let cacheURL: URL?

    public init(cacheDirectory: URL? = FeaturePrintIndex.defaultCacheDirectory) {
        cacheURL = cacheDirectory?.appending(path: "featureprints-\(Self.revisionTag).json")
    }

    public static var defaultCacheDirectory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appending(path: "com.nickysemenza.cubby", directoryHint: .isDirectory)
    }

    public var count: Int { entries.count }
    public var all: [FeaturePrintEntry] { Array(entries.values) }

    // MARK: Building

    /// Computes a feature print for one image.
    public static func featurePrint(of image: CGImage) async throws -> FeaturePrintObservation {
        var request = GenerateImageFeaturePrintRequest(revision)
        request.cropAndScaleAction = .scaleToFill
        return try await request.perform(on: image)
    }

    public func add(productID: ProductCode, name: String, imageURL: URL, image: CGImage) async throws {
        let print = try await Self.featurePrint(of: image)
        entries[productID] = FeaturePrintEntry(productID: productID, name: name, imageURL: imageURL, print: print)
    }

    /// Adds every product that has a cover, downloading with bounded concurrency. Products already
    /// indexed are skipped, so this is safe to call repeatedly. Returns how many were added.
    @discardableResult
    public func build(
        from products: [ProductSummary],
        loader: CoverImageLoader = CoverImageLoader(),
        concurrency: Int = 6,
        progress: (@Sendable (Int, Int) -> Void)? = nil
    ) async -> Int {
        let pending = products.filter { $0.coverImageURL != nil && entries[$0.id] == nil }
        var added = 0
        var done = 0
        await withTaskGroup(of: (ProductSummary, FeaturePrintObservation)?.self) { group in
            var iterator = pending.makeIterator()
            func enqueue() {
                guard let product = iterator.next(), let url = product.coverImageURL else { return }
                group.addTask {
                    guard let image = try? await loader.load(url),
                        let print = try? await Self.featurePrint(of: image)
                    else { return nil }
                    return (product, print)
                }
            }
            for _ in 0..<max(1, concurrency) { enqueue() }
            for await result in group {
                done += 1
                if let (product, print) = result, let url = product.coverImageURL {
                    entries[product.id] = FeaturePrintEntry(productID: product.id, name: product.name, imageURL: url, print: print)
                    added += 1
                }
                progress?(done, pending.count)
                enqueue()
            }
        }
        return added
    }

    // MARK: Ranking

    public func rank(_ image: CGImage, limit: Int = 5) async throws -> [IdentificationCandidate] {
        let query = try await Self.featurePrint(of: image)
        return rank(query, limit: limit)
    }

    public func rank(_ query: FeaturePrintObservation, limit: Int = 5) -> [IdentificationCandidate] {
        entries.values
            .compactMap { entry -> IdentificationCandidate? in
                guard let distance = try? query.distance(to: entry.print) else { return nil }
                return IdentificationCandidate(productID: entry.productID, name: entry.name, imageURL: entry.imageURL, distance: distance)
            }
            .sorted { $0.distance < $1.distance }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: Cache

    public func loadCache() throws -> Int {
        guard let cacheURL, FileManager.default.fileExists(atPath: cacheURL.path(percentEncoded: false)) else { return 0 }
        let cached = try JSONDecoder().decode([FeaturePrintEntry].self, from: Data(contentsOf: cacheURL))
        for entry in cached { entries[entry.productID] = entry }
        return cached.count
    }

    public func saveCache() throws {
        guard let cacheURL else { return }
        try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(Array(entries.values)).write(to: cacheURL, options: .atomic)
    }

    public func clear() {
        entries.removeAll()
        if let cacheURL { try? FileManager.default.removeItem(at: cacheURL) }
    }
}
