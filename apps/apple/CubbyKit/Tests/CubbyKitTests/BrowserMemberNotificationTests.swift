#if os(macOS)
    import Foundation
    import Testing
    @testable import CubbyKit

    @MainActor
    struct BrowserMemberNotificationTests {
        @Test func staleAttentionCannotRaiseAfterOwnedWindowLookupSuspends() async throws {
            var current = true
            var raised = false
            try await MacBrowserCommandExecutor.raiseAttentionWindow(
                isCurrent: { current },
                requireWindow: { current = false },
                raise: { raised = true })
            #expect(!raised)
        }

        @Test func resolvedPauseCannotDeliverOrRaiseAfterAuthorizationSuspends() async throws {
            let suite = "browser-attention-test-\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let notifier = MacBrowserBridgeNotifier(defaults: defaults)
            let generation = try #require(
                notifier.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in"))
            var delivered = false
            let fresh = await notifier.deliverAttention(
                accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in",
                generation: generation,
                isCurrent: { true },
                canPresent: {
                    notifier.resolveAttentionEdge(
                        accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in")
                    // A new pause must not make the suspended old delivery current again.
                    _ = notifier.claimAttentionEdge(
                        accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in")
                    return true
                }, post: { delivered = true }, remove: {})
            #expect(!delivered)
            #expect(!fresh)
        }

        @Test func staleAttentionIsFencedBeforeAndAfterDelivery() async throws {
            let suite = "browser-attention-test-\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let notifier = MacBrowserBridgeNotifier(defaults: defaults)
            for interval in ["before_task", "authorization", "posting"] {
                let generation = try #require(
                    notifier.claimAttentionEdge(
                        accountID: "synthetic-account", runID: interval, reason: "sign_in"))
                var authorizationAsked = false
                var installed = true
                var delivered = false
                var removed = false
                if interval == "before_task" {
                    notifier.resolveAttentionEdge(
                        accountID: "synthetic-account", runID: interval, reason: "sign_in")
                }
                let fresh = await notifier.deliverAttention(
                    accountID: "synthetic-account", runID: interval, reason: "sign_in",
                    generation: generation,
                    isCurrent: { installed },
                    canPresent: {
                        authorizationAsked = true
                        if interval == "authorization" { installed = false }
                        return true
                    },
                    post: {
                        delivered = true
                        notifier.resolveAttentionEdge(
                            accountID: "synthetic-account", runID: interval, reason: "sign_in")
                        _ = notifier.claimAttentionEdge(
                            accountID: "synthetic-account", runID: interval, reason: "sign_in")
                    }, remove: { removed = true })
                #expect(!fresh)
                #expect(authorizationAsked == (interval != "before_task"))
                #expect(delivered == (interval == "posting"))
                #expect(removed == (interval == "posting"))
            }
        }

        // Replayed pauses across process restart must not notify twice; a different
        // member action or account must still be eligible for a notification.
        @Test func retainedPauseEdgesSurviveNotifierRecreation() throws {
            let suite = "browser-attention-test-\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let first = MacBrowserBridgeNotifier(defaults: defaults)
            #expect(
                first.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in") != nil)
            let recreated = MacBrowserBridgeNotifier(defaults: defaults)
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in") == nil)
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "screen_recording_denied")
                    != nil
            )
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "other-account", runID: "synthetic-run", reason: "sign_in") != nil)
            recreated.resolveAttentionEdge(
                accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in")
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "sign_in") != nil)
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "synthetic-account", runID: "synthetic-run", reason: "screen_recording_denied")
                    == nil
            )
            #expect(
                recreated.claimAttentionEdge(
                    accountID: "other-account", runID: "synthetic-run", reason: "sign_in") == nil)
        }
    }
#endif
