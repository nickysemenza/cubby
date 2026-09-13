import ArgumentParser
import CubbyKit
import Foundation

/// Ranks an image against an on-device feature-print index of the household's product covers.
/// The index is built from the product list on first use and cached under the user's caches
/// directory; `--rebuild` discards it.
struct Identify: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Rank product covers against an image (Vision feature prints).")

    @OptionGroup var global: GlobalOptions
    @Argument(help: "Path to a JPEG/PNG/HEIC image.")
    var imagePath: String
    @Option(help: "How many candidates to print.")
    var limit: Int = 5
    @Option(
        name: .customLong("max-products"), help: "How many products to index (most recently created first).")
    var maxProducts: Int = 400
    @Flag(help: "Discard the cached index and rebuild it.")
    var rebuild: Bool = false

    func run() async throws {
        try await CLI.run {
            let context = try CLIContext.make(from: global)
            let index = FeaturePrintIndex()
            if rebuild { await index.clear() }
            let cached = try await index.loadCache()
            if cached == 0 {
                FileHandle.standardError.write(Data("Indexing up to \(maxProducts) product covers…\n".utf8))
                // List rows carry no image URLs (the projection omits them), so page through
                // the ids of products that have images, then fetch each detail for its cover.
                var ids: [ProductCode] = []
                var page = 1
                while ids.count < maxProducts {
                    let result = try await context.client.productIDsWithImages(page: page, pageSize: 100)
                    ids += result.items
                    if result.items.count < 100 { break }
                    page += 1
                }
                FileHandle.standardError.write(
                    Data("  \(ids.count) products with images; fetching covers…\n".utf8))
                let client = context.client
                let (products, firstFailure) = await withTaskGroup(
                    of: Result<ProductSummary, any Error>.self,
                    returning: ([ProductSummary], String?).self
                ) { group in
                    var iterator = ids.prefix(maxProducts).makeIterator()
                    func enqueue() {
                        guard let id = iterator.next() else { return }
                        group.addTask {
                            do { return .success(try await client.product(id)) } catch {
                                return .failure(error)
                            }
                        }
                    }
                    for _ in 0..<6 { enqueue() }
                    var collected: [ProductSummary] = []
                    var failure: String?
                    for await result in group {
                        switch result {
                        case .success(let product): collected.append(product)
                        case .failure(let error): failure = failure ?? String(describing: error)
                        }
                        enqueue()
                    }
                    return (collected, failure)
                }
                if let firstFailure {
                    FileHandle.standardError.write(
                        Data("  some detail fetches failed, first error: \(firstFailure.prefix(400))\n".utf8))
                }
                let added = await index.build(from: Array(products.prefix(maxProducts))) { done, total in
                    if done % 25 == 0 || done == total {
                        FileHandle.standardError.write(Data("  \(done)/\(total)\n".utf8))
                    }
                }
                try await index.saveCache()
                FileHandle.standardError.write(Data("Indexed \(added) covers (cached for next time).\n".utf8))
            } else {
                FileHandle.standardError.write(Data("Using cached index of \(cached) covers.\n".utf8))
            }

            let image = try CoverImageLoader.decode(contentsOf: URL(filePath: imagePath))
            let ranked = try await index.rank(image, limit: limit)
            if global.json {
                let rows: [JSONValue] = ranked.map {
                    .object([
                        "productId": .string($0.productID.rawValue), "name": .string($0.name),
                        "distance": .number($0.distance),
                    ])
                }
                print(try CLI.prettyJSON(.array(rows)))
            } else {
                for (rank, candidate) in ranked.enumerated() {
                    print(
                        "\(rank + 1). \(candidate.productID.rawValue)  \(String(format: "%.3f", candidate.distance))  \(candidate.name)"
                    )
                }
            }
        }
    }
}
