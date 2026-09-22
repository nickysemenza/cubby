import ArgumentParser
import CubbyKit
import Foundation

/// Options every subcommand accepts: which server to talk to, an optional static API key, and
/// output shape.
struct GlobalOptions: ParsableArguments {
    @Option(
        name: .customLong("base-url"),
        help: "Cubby server base URL. Defaults to $CUBBY_BASE_URL, else https://cubby.nickysemenza.com.")
    var baseURLString: String =
        ProcessInfo.processInfo.environment["CUBBY_BASE_URL"] ?? "https://cubby.nickysemenza.com"

    @Option(
        name: .customLong("api-key"),
        help: "Static API key. Defaults to $CUBBY_API_KEY. Never written to Keychain.")
    var apiKeyString: String = ""

    @Flag(name: .customLong("json"), help: "Print raw JSON instead of a table.")
    var json: Bool = false

    init() {}

    /// `--api-key`, falling back to `$CUBBY_API_KEY`; `nil` when neither is set. (The stored
    /// property can't be `String?` with a default — ArgumentParser deprecates that combination —
    /// so the empty string doubles as "not passed on the command line".)
    var apiKey: String? {
        let value =
            apiKeyString.isEmpty ? (ProcessInfo.processInfo.environment["CUBBY_API_KEY"] ?? "") : apiKeyString
        return value.isEmpty ? nil : value
    }

    var resolvedBaseURL: URL {
        get throws {
            guard let url = URL(string: baseURLString), url.host() != nil else {
                throw CLIError.message("Invalid --base-url: \(baseURLString)")
            }
            return url
        }
    }
}

/// The wiring every subcommand needs: the resolved base URL, the credential provider for this
/// host, and a `CubbyClient` built on top of it.
///
/// `--api-key` (or `$CUBBY_API_KEY`) always resolves to an in-memory credential store — an
/// environment-supplied key is never persisted to Keychain — while the default path uses the
/// real Keychain store so `auth login` survives across CLI invocations.
struct CLIContext {
    let baseURL: URL
    /// Same value as `credentials.host`, kept here too since `CredentialProvider` is an actor and
    /// its `host` needs `await` from call sites that otherwise have no other reason to suspend.
    let host: String
    let credentials: CredentialProvider
    /// The CLI's own product name; it carries no installation id (that concept is native-app only).
    let identity: ClientIdentity
    let client: CubbyClient
    let json: Bool

    static func make(from options: GlobalOptions) throws -> CLIContext {
        let baseURL = try options.resolvedBaseURL
        let host = CubbyBaseURL.host(of: baseURL)

        let credentials: CredentialProvider
        if let apiKey = options.apiKey {
            let store = InMemorySessionTokenStore()
            try store.save(.apiKey(apiKey), for: host)
            credentials = CredentialProvider(host: host, store: store)
        } else {
            // File store, not Keychain: an ad-hoc-signed `swift run` binary re-prompts on every rebuild.
            credentials = CredentialProvider(host: host, store: FileSessionTokenStore.standard())
        }
        let identity = ClientIdentity.currentApp(product: "cubby-cli", installationID: nil)

        return CLIContext(
            baseURL: baseURL,
            host: host,
            credentials: credentials,
            identity: identity,
            client: CubbyClient(baseURL: baseURL, credentials: credentials, identity: identity),
            json: options.json
        )
    }
}
