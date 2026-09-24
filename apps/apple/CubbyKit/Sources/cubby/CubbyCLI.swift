import ArgumentParser
import CubbyKit

@main
struct CubbyCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "cubby",
        abstract: "Cubby native test harness (CLI, not a shipped product).",
        subcommands: [
            Version.self, Auth.self, Call.self, Entity.self, Scan.self, Search.self, Parse.self,
            Photo.self, HeadlessProductEdit.self, HeadlessPhotoImport.self,
        ]
    )
}

extension CubbyCLI {
    struct Version: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            abstract: "Print the CubbyKit package version."
        )

        func run() async throws {
            print(CubbyKitInfo.version)
        }
    }
}
