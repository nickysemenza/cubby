import CubbyKit
import Foundation
import OSLog
import Sentry

/// The app's Sentry surface: crash reporting, non-fatal capture, and URLSession tracing whose
/// `sentry-trace`/`baggage` headers continue the trace inside the Cubby Workers.
///
/// App targets only. CubbyKit is a non-MainActor package that also builds the `cubby` CLI, so it
/// never imports Sentry; its errors (Rust panics included — UniFFI rethrows them as Swift errors)
/// arrive here through the same catch sites that already show them to the user.
///
/// `nonisolated` because `report` is called from actors (`SpotlightIndexer`) as well as MainActor
/// models, and the SDK is thread-safe. Nothing here holds mutable state.
nonisolated enum Diagnostics {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.nickysemenza.cubby",
        category: "Diagnostics")

    /// Test hosts launch the real app before loading tests, including intentional error paths.
    /// The scheme flag is available at startup; Xcode's markers also cover alternate test runners.
    static func isTestHost(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        environment["CUBBY_TEST_HOST"] == "1"
            || environment["XCTestConfigurationFilePath"] != nil
            || environment["XCTestBundlePath"] != nil
            || environment["XCTestSessionIdentifier"] != nil
    }

    /// Project `cubby-apple`, separate from the web app's. A DSN is not a secret — it is embedded in
    /// the shipped binary by design — so hardcoding it is fine.
    static let dsn =
        "https://629f2f6b5c45bd7df28d1fc4c23977a2@o83311.ingest.us.sentry.io/4512079996846080"

    /// `bundleId@MARKETING_VERSION+CURRENT_PROJECT_VERSION` — the SDK's own default format, spelled
    /// out so DevView can read back exactly what was sent (the SDK exposes no options after
    /// `start`). Bumping those two in project.yml per TestFlight upload is the existing ritual.
    static var release: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let id = Bundle.main.bundleIdentifier ?? "com.nickysemenza.cubby"
        let version = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return "\(id)@\(version)+\(build)"
    }

    /// Same rule as the web's `sentry-environment.ts`: a Debug build, or production code pointed
    /// at a loopback host, is a local execution.
    static func environment(for baseURL: URL) -> String {
        #if DEBUG
            return "development"
        #else
            return isLoopback(baseURL) ? "development" : "production"
        #endif
    }

    private static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        return host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "[::1]"
            || host.hasPrefix("127.")
    }

    /// First thing in `CubbyApp.init`, before `AppModel` exists, so a crash during model setup is
    /// still caught.
    static func start(baseURL: URL) {
        guard !isTestHost() else { return }
        let environment = environment(for: baseURL)
        SentrySDK.start { options in
            options.dsn = dsn
            options.sendDefaultPii = false
            options.environment = environment
            options.releaseName = release
            // Mirrors cf-server.ts: head-based sampling decided on the device propagates to the
            // Worker via `sentry-trace`, so matching its 10% keeps traces connected end to end
            // without full-tracing overhead. Errors are captured regardless of this rate.
            // Off in development, as on the web.
            options.tracesSampleRate = NSNumber(value: environment == "production" ? 0.1 : 0)
            // Only the Cubby host gets `sentry-trace`/`baggage` (matched by substring). R2
            // presigned PUTs (`PresignedUpload`, which sends only `Content-Type` by contract)
            // and cover-image fetches leave the trace domain and must not carry them.
            options.tracePropagationTargets = [CubbyBaseURL.host(of: baseURL)]
            // No `beforeSend` scrubber: unlike the web's MCP `?key=` history, the app carries no
            // credential in a URL — bearer auth rides in a header (`CubbyAuthMiddleware`), and
            // `sendDefaultPii = false` keeps headers out of events.
        }
    }

    /// The single non-fatal entry point. Keep the UI string assignment in the catch; add one
    /// call to this beside it. `context` is a short dotted slug (`"garden.journal.save"`).
    ///
    /// Filtered out: cancellations (the user navigated away), a wrong password or a rate limit
    /// (user-flow outcomes), and the two expected API failures — a 401 (the sign-out path,
    /// already handled by `AppModel.handle`) and a 404 (a stale deep link or Spotlight hit) —
    /// which become breadcrumbs so they still explain a later event without being one.
    static func report(_ error: any Error, context: String) {
        guard !isTestHost() else { return }
        if error is CancellationError { return }
        if let urlError = error as? URLError, urlError.code == .cancelled { return }
        if let auth = error as? AuthError, auth == .invalidCredentials || auth == .rateLimited { return }
        logger.error(
            "[\(context, privacy: .public)] \(String(reflecting: type(of: error)), privacy: .public): \(String(reflecting: error), privacy: .public)"
        )
        if let api = error as? CubbyAPIError, api.isUnauthorized || api.status == 404 {
            let crumb = Breadcrumb(level: .warning, category: context)
            crumb.message = "HTTP \(api.status) \(api.operationID)"
            SentrySDK.addBreadcrumb(crumb)
            return
        }
        SentrySDK.capture(error: error) { scope in
            scope.setTag(value: context, key: "context")
        }
    }

    /// Follows a base URL change (Settings). The environment moves with it on the scope;
    /// `tracePropagationTargets` is fixed at `start` — the SDK has no public way to change it
    /// live — so after switching hosts, traces reconnect to the Worker only on the next launch.
    static func setBaseURL(_ url: URL) {
        guard !isTestHost() else { return }
        let environment = environment(for: url)
        SentrySDK.configureScope { scope in scope.setEnvironment(environment) }
    }
}
