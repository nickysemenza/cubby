#if os(macOS)
    import Foundation
    import Synchronization
    import Testing

    @testable import CubbyKit

    @MainActor
    @Suite("Mac browser bridge roster refresh")
    struct MacBrowserBridgeCoordinatorTests {
        private final class Roster: BrowserBridgeVendorAccountListing {
            let accounts = Mutex<[BrowserBridgeVendorAccount]>([])
            func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount] {
                accounts.withLock { $0 }
            }
            func set(_ ids: [String]) {
                accounts.withLock {
                    $0 = ids.map {
                        BrowserBridgeVendorAccount(
                            id: $0, label: "Account \($0)", ledgerPartyID: "LPY-TEST", browser: .chrome)
                    }
                }
            }
        }

        private struct NoSync: BrowserBridgeSyncRequesting {
            func requestSync(vendorAccountID: String, backfill: BrowserBridgeBackfillRange?) async throws
                -> BrowserBridgeSyncResponse
            { throw URLError(.unsupportedURL) }
        }

        private actor EmptyReplayStore: BrowserBridgeReplayStoring {
            func load() async throws -> BrowserBridgeReplayLedger { BrowserBridgeReplayLedger() }
            func save(_ ledger: BrowserBridgeReplayLedger) async throws {}
        }

        private struct NoUpload: BrowserEvidenceUploading {
            func upload(
                _ evidence: BrowserLocalEvidence, runID: String, scope: BrowserEvidenceUploadScope?
            ) async throws -> BrowserEvidenceReference { throw URLError(.unsupportedURL) }
        }

        /// One coordinator over a loopback server nothing listens on: sockets never connect, so the
        /// tests observe only which bridges the roster opens and closes.
        @MainActor
        private final class Harness {
            let roster = Roster()
            var openedExecutors: [String] = []
            var fleetTotals: [Int] = []
            var publishedAccounts: [[String]] = []
            var coordinator: MacBrowserBridgeCoordinator!

            init(rosterRefreshInterval: Duration = .seconds(600)) throws {
                let store = InMemorySessionTokenStore()
                try store.save(.bearer("tok"), for: "127.0.0.1:9")
                coordinator = MacBrowserBridgeCoordinator(
                    baseURL: URL(string: "http://127.0.0.1:9")!,
                    credentials: CredentialProvider(host: "127.0.0.1:9", store: store),
                    deviceID: UUID(), accountClient: roster, syncClient: NoSync(),
                    executorFactory: { [unowned self] _, accountID in
                        openedExecutors.append(accountID)
                        return try MacBrowserCommandExecutor(
                            target: .installed(.chrome), accountID: accountID, evidenceUploader: NoUpload())
                    },
                    replayStoreFactory: { _ in EmptyReplayStore() },
                    capabilities: { _ in
                        BrowserBridgeCapabilities(enhancedScreenshot: false, renderedPDF: false)
                    },
                    rosterRefreshInterval: rosterRefreshInterval,
                    observer: { [unowned self] event in
                        switch event {
                        case .accounts(let accounts): publishedAccounts.append(accounts.map(\.id))
                        case .fleetStatus(_, _, let total): fleetTotals.append(total)
                        default: break
                        }
                    })
            }
        }

        @Test("A newly listed account gets a bridge without reconnecting existing ones")
        func addedAccount() async throws {
            let harness = try Harness()
            harness.roster.set(["VACCT-AAAA"])
            try await harness.coordinator.connect(browser: .chrome, enhancedEvidence: false)
            #expect(harness.openedExecutors == ["VACCT-AAAA"])

            harness.roster.set(["VACCT-AAAA", "VACCT-BBBB"])
            try await harness.coordinator.refreshRoster()
            #expect(harness.openedExecutors == ["VACCT-AAAA", "VACCT-BBBB"])
            #expect(harness.coordinator.vendorAccounts.map(\.id) == ["VACCT-AAAA", "VACCT-BBBB"])
            #expect(harness.publishedAccounts.last == ["VACCT-AAAA", "VACCT-BBBB"])
            #expect(harness.fleetTotals.last == 2)

            // An unchanged roster opens nothing and republishes no account list.
            let published = harness.publishedAccounts.count
            try await harness.coordinator.refreshRoster()
            #expect(harness.openedExecutors == ["VACCT-AAAA", "VACCT-BBBB"])
            #expect(harness.publishedAccounts.count == published)
            await harness.coordinator.disconnect()
        }

        @Test("An account that is no longer listed loses its bridge")
        func removedAccount() async throws {
            let harness = try Harness()
            harness.roster.set(["VACCT-AAAA", "VACCT-BBBB"])
            try await harness.coordinator.connect(browser: .chrome, enhancedEvidence: false)

            harness.roster.set(["VACCT-BBBB"])
            try await harness.coordinator.refreshRoster()
            #expect(harness.openedExecutors == ["VACCT-AAAA", "VACCT-BBBB"])
            #expect(harness.coordinator.vendorAccounts.map(\.id) == ["VACCT-BBBB"])
            #expect(harness.publishedAccounts.last == ["VACCT-BBBB"])
            #expect(harness.fleetTotals.last == 1)
            await harness.coordinator.disconnect()
        }

        @Test("No accounts at connect is not terminal: a refresh connects one listed later")
        func emptyThenListed() async throws {
            let harness = try Harness()
            await #expect(throws: MacBrowserBridgeCoordinator.Failure.self) {
                try await harness.coordinator.connect(browser: .chrome, enhancedEvidence: false)
            }
            harness.roster.set(["VACCT-AAAA"])
            try await harness.coordinator.refreshRoster()
            #expect(harness.openedExecutors == ["VACCT-AAAA"])
            #expect(harness.fleetTotals.last == 1)
            await harness.coordinator.disconnect()
        }

        @Test("The periodic refresh picks up an account after an empty connect, and stops on disconnect")
        func periodicRefresh() async throws {
            let harness = try Harness(rosterRefreshInterval: .milliseconds(20))
            await #expect(throws: MacBrowserBridgeCoordinator.Failure.self) {
                try await harness.coordinator.connect(browser: .chrome, enhancedEvidence: false)
            }
            harness.roster.set(["VACCT-AAAA"])
            let deadline = ContinuousClock.now + .seconds(5)
            while harness.openedExecutors.isEmpty, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(harness.openedExecutors == ["VACCT-AAAA"])

            await harness.coordinator.disconnect()
            harness.roster.set(["VACCT-AAAA", "VACCT-BBBB"])
            try await Task.sleep(for: .milliseconds(100))
            #expect(harness.openedExecutors == ["VACCT-AAAA"])
        }
    }
#endif
