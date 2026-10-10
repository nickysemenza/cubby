#if os(macOS)
    import Foundation
    import Testing
    @testable import CubbyKit

    @MainActor
    struct BrowserMemberNotificationTests {
        // Replayed pauses across process restart must not notify twice; a different
        // member action or account must still be eligible for a notification.
        @Test func retainedPauseEdgesSurviveNotifierRecreation() throws {
            let suite = "browser-attention-test-\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let first = MacBrowserBridgeNotifier(defaults: defaults)
            #expect(
                first.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in"))
            let recreated = MacBrowserBridgeNotifier(defaults: defaults)
            #expect(
                !recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in"))
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "screen_recording_denied")
            )
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "other-account", runID: "synthetic-run", reason: "sign_in"))
            recreated.resolveAttentionEdge(
                accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in")
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in"))
            #expect(
                !recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "screen_recording_denied")
            )
            #expect(
                !recreated.claimAttentionEdge(
                    accountID: "other-account", runID: "synthetic-run", reason: "sign_in"))
        }
    }
#endif
