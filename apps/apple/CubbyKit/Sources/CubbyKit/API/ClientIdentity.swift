import Foundation

/// Who is calling: a product name, its version, the platform it runs on, and (for an installed
/// native app) this install's id. `CubbyAuthMiddleware` turns this into a `User-Agent` and
/// `X-Cubby-Device` header on every REST request; the two companion sockets fold the installation
/// id into their own `User-Agent` strings directly.
public struct ClientIdentity: Sendable, Hashable {
    public let product: String
    public let version: String
    public let platform: String
    public let installationID: UUID?

    public init(
        product: String, version: String, platform: String = ClientIdentity.currentPlatform,
        installationID: UUID? = nil
    ) {
        self.product = product
        self.version = version
        self.platform = platform
        self.installationID = installationID
    }

    /// `<product>/<version> (<platform>; <installationID>)`.
    public var userAgent: String {
        "\(product)/\(version) (\(platform); \(installationID?.uuidString.lowercased() ?? "none"))"
    }

    /// `macos` or `ios` — the only two platforms CubbyKit's native targets build for.
    public static var currentPlatform: String {
        #if os(macOS)
            "macos"
        #else
            "ios"
        #endif
    }

    /// Every native app target's identity: `CFBundleShortVersionString` from the main bundle, the
    /// current OS, and this install's id. The CLI builds its own literal identity instead
    /// (`product: "cubby-cli"`) since it has no meaningful app bundle version.
    public static func currentApp(product: String, installationID: UUID?) -> ClientIdentity {
        let version =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        return ClientIdentity(product: product, version: version, installationID: installationID)
    }

    /// The identity a client that was never told who it is presents: every request still carries a
    /// `User-Agent`, just without a real product name or install id. The default for every
    /// `CubbyClient`/`AuthFlow`/`CubbyDebugClient` initializer, so call sites that do not care about
    /// identity headers (most tests, previews, and playgrounds) do not have to supply one.
    public static let unknown = ClientIdentity(product: "cubby-unknown", version: "0")
}
