import ArgumentParser
import CubbyKit

/// `search.find` over every intent-exposed entity, the way the Search tab does.
struct Search: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Search every catalog entity by text.")

    @OptionGroup var global: GlobalOptions
    @Option(help: "Most hits to return (server cap \(SearchHit.maxLimit)).")
    var limit: Int = 10
    @Argument(help: "The text to search for.")
    var text: [String]

    func run() async throws {
        try await CLI.run {
            let context = try CLIContext.make(from: global)
            let hits = try await context.client.search(text.joined(separator: " "), limit: limit)
            for hit in hits {
                let kind = hit.key.map { EntityCatalog[$0].singular } ?? hit.entityType
                print("\(hit.id)  \(kind): \(hit.title)\(hit.subtitle.map { " — \($0)" } ?? "")")
            }
        }
    }
}
