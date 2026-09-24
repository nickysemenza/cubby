import ArgumentParser
import CubbyKit
import Foundation

/// Exercises the native auth, search, editor patch, and read path without launching SwiftUI.
struct HeadlessProductEdit: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "headless-product-edit")

    @Option(name: .customLong("base-url")) var baseURLString: String
    @Option(name: .customLong("product-id")) var productID: String
    @Option(name: .customLong("original-name")) var originalName: String
    @Option(name: .customLong("updated-name")) var updatedName: String

    func run() async throws {
        try await CLI.run {
            guard
                let baseURL = URL(string: baseURLString),
                baseURL.scheme == "http", baseURL.host() == "127.0.0.1",
                baseURL.port != nil, baseURL.user() == nil, baseURL.password() == nil,
                baseURL.path().isEmpty || baseURL.path() == "/"
            else {
                throw CLIError.message("Headless product edit requires a loopback HTTP server")
            }

            let credentials = CredentialProvider(
                host: CubbyBaseURL.host(of: baseURL), store: InMemorySessionTokenStore())
            let identity = ClientIdentity.currentApp(product: "cubby-cli", installationID: nil)
            let auth = AuthFlow(baseURL: baseURL, credentials: credentials, identity: identity)
            _ = try await auth.signIn(
                email: "sim@cubby.localhost", password: "cubby-sim-local-only")
            let client = CubbyClient(
                baseURL: baseURL, credentials: credentials, identity: identity)
            let descriptor = EntityCatalog[.product]

            let hits = try await client.search(originalName, kinds: [.product])
            guard hits.contains(where: { $0.id == productID }) else {
                throw CLIError.message("Seeded product was missing from native search")
            }
            guard let before = try await client.row(descriptor, id: productID),
                before.title == originalName
            else {
                throw CLIError.message("Seeded product did not match its native detail")
            }

            let patch = try EntityPatch.diff(
                original: before.raw,
                draft: ["name": .string(updatedName)], nullableKeys: [])
            guard !patch.isEmpty else {
                throw CLIError.message("Native editor produced an empty product patch")
            }
            try await client.update(descriptor, id: productID, patch: patch)
            guard let after = try await client.row(descriptor, id: productID),
                after.title == updatedName
            else {
                throw CLIError.message("Native product read did not reflect the edit")
            }
            let updatedHits = try await client.search(updatedName, kinds: [.product])
            guard updatedHits.contains(where: { $0.id == productID }) else {
                throw CLIError.message("Edited product was missing from native search")
            }
            print("Headless native product edit verified: \(productID)")
        }
    }
}
