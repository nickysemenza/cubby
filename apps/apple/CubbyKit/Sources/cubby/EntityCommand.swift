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
                guard descriptor.actions.contains(.list) else {
                    throw CLIError.message("\(descriptor.plural) has no list route.")
                }

                let context = try CLIContext.make(from: global)
                let result = try await context.client.raw.list(
                    basePath: descriptor.basePath, page: page, pageSize: pageSize, sort: sort
                )

                if global.json {
                    print(try CLI.prettyJSON(.array(result.items)))
                } else {
                    for item in result.items {
                        let row = descriptor.row(from: item)
                        print("\(row?.id ?? "?")\t\(row?.title ?? "?")")
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
                guard descriptor.actions.contains(.get) else {
                    throw CLIError.message("\(descriptor.singular) has no get route.")
                }

                let context = try CLIContext.make(from: global)
                let object = try await context.client.raw.get(basePath: descriptor.basePath, id: id)

                if global.json {
                    print(try CLI.prettyJSON(object))
                } else {
                    let row = descriptor.row(from: object)
                    print("\(row?.id ?? id)\t\(row?.title ?? id)")
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
