import ArgumentParser
import CubbyKit

/// Generic entity list/get, driven entirely by `EntityCatalog` — no per-entity CLI code.
struct Entity: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "List or get rows for any cataloged entity.",
        subcommands: [List.self, Get.self]
    )
}

extension Entity {
    struct List: AsyncParsableCommand {
        static let configuration = CommandConfiguration(commandName: "list", abstract: "List rows for an entity.")

        @OptionGroup var global: GlobalOptions
        @Argument(help: "Entity key, e.g. product, location, usda-food.")
        var key: String
        @Option var page: Int = 1
        @Option(name: .customLong("page-size")) var pageSize: Int = 50
        @Option var sort: String?

        func run() async throws {
            try await CLI.run {
                let descriptor = try Entity.descriptor(for: key)
                // `httpActions` is authoritative over the kernel roster's `descriptor.actions` —
                // it's the set the HTTP document actually routes.
                guard descriptor.key.httpActions.contains(.list) else {
                    throw CLIError.message("\(descriptor.plural) has no list route.")
                }

                let context = try CLIContext.make(from: global)
                let result = try await context.client.list(descriptor, page: page, pageSize: pageSize, sort: sort)

                if global.json {
                    print(try CLI.prettyJSON(.array(result.items.map(\.raw))))
                } else {
                    for row in result.items {
                        print("\(row.id)\t\(row.title)")
                    }
                }
            }
        }
    }

    struct Get: AsyncParsableCommand {
        static let configuration = CommandConfiguration(commandName: "get", abstract: "Get one row by id.")

        @OptionGroup var global: GlobalOptions
        @Argument(help: "Entity key, e.g. product, location, usda-food.")
        var key: String
        @Argument(help: "Row id (shortcode).")
        var id: String

        func run() async throws {
            try await CLI.run {
                let descriptor = try Entity.descriptor(for: key)
                guard descriptor.key.httpActions.contains(.get) else {
                    throw CLIError.message("\(descriptor.singular) has no get route.")
                }

                let context = try CLIContext.make(from: global)
                guard let row = try await context.client.row(descriptor, id: id) else {
                    throw CLIError.message("No \(descriptor.singular.lowercased()) called \(id).")
                }

                if global.json {
                    print(try CLI.prettyJSON(row.raw))
                } else {
                    print("\(row.id)\t\(row.title)")
                }
            }
        }
    }
}

extension Entity {
    /// Parses `key` as an `EntityKey` and looks it up in the catalog, or throws a message that
    /// lists every valid key.
    fileprivate static func descriptor(for key: String) throws -> EntityDescriptor {
        guard let entityKey = EntityKey(rawValue: key) else {
            let known = EntityKey.allCases.map(\.rawValue).sorted().joined(separator: ", ")
            throw CLIError.message("Unknown entity key: \(key). Known keys: \(known)")
        }
        return EntityCatalog[entityKey]
    }
}
