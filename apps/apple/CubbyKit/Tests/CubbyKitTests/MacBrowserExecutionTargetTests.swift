#if os(macOS)
    import Foundation
    import Testing

    @testable import CubbyKit

    /// Fixture configuration must fail before any browser launch or Automation permission request.
    @Suite("Mac browser target")
    @MainActor
    struct MacBrowserExecutionTargetTests {
        @Test func isolatedTargetRejectsRemoteServerAndInstalledBrowserIdentity() throws {
            for (server, bundle) in [
                ("https://example.test", "com.cubby.fixture.browser"),
                ("http://127.0.0.1:3000", "com.google.Chrome"),
            ] {
                #expect(throws: MacBrowserExecutionTarget.Failure.invalidFixtureConfiguration) {
                    try MacBrowserExecutionTarget.fixtureChrome(
                        baseURL: URL(string: server)!, bundleIdentifier: bundle,
                        applicationURL: URL(fileURLWithPath: "/tmp/synthetic-browser.app"),
                        processID: 1, teamID: "SYNTHETIC")
                }
            }
        }
    }
#endif
