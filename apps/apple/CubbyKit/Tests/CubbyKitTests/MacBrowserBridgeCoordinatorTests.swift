#if os(macOS)
    import Foundation
    import Synchronization
    import Testing

    @testable import CubbyKit

    @MainActor
    @Suite("Mac browser bridge roster refresh")
    struct MacBrowserBridgeCoordinatorTests {
        /// The listing fake. While gated, every listing suspends until the test releases it, so a
        /// test decides which of two overlapping listings returns first.
        private final class Roster: BrowserBridgeVendorAccountListing {
            private struct State {
                var accounts: [BrowserBridgeVendorAccount] = []
                var gated = false
                var pending: [CheckedContinuation<Void, Never>] = []
            }
            private let state = Mutex(State())

            func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount] {
                await withCheckedContinuation { continuation in
                    let proceed = state.withLock { state in
                        guard state.gated else { return true }
                        state.pending.append(continuation)
                        return false
                    }
                    if proceed { continuation.resume() }
                }
                return state.withLock { $0.accounts }
            }

            func set(_ ids: [String]) {
                state.withLock {
                    $0.accounts = ids.map {
                        BrowserBridgeVendorAccount(
                            id: $0, label: "Account \($0)", ledgerPartyId: "LPY-TEST", browser: .chrome)
                    }
                }
            }

            func gate() { state.withLock { $0.gated = true } }
            var pendingCount: Int { state.withLock { $0.pending.count } }

            /// Releases the `index`-th listing still waiting.
            func release(_ index: Int) {
                state.withLock { $0.pending.remove(at: index) }.resume()
            }

            func ungate() {
                let pending = state.withLock { state in
                    state.gated = false
                    defer { state.pending = [] }
                    return state.pending
                }
                for continuation in pending { continuation.resume() }
            }
        }

        /// A manual clock for the periodic refresh: each tick suspends until the test fires it,
        /// and a cancelled loop's tick throws.
        private final class Ticks: Sendable {
            private struct State {
                var waiting: CheckedContinuation<Void, any Error>?
                var waits = 0
            }
            private let state = Mutex(State())

            var waits: Int { state.withLock { $0.waits } }

            func tick() async throws {
                try await withTaskCancellationHandler {
                    try await withCheckedThrowingContinuation { continuation in
                        state.withLock {
                            $0.waiting = continuation
                            $0.waits += 1
                        }
                    }
                } onCancel: {
                    take()?.resume(throwing: CancellationError())
                }
            }

            func fire() { take()?.resume() }

            private func take() -> CheckedContinuation<Void, any Error>? {
                state.withLock { state in
                    defer { state.waiting = nil }
                    return state.waiting
                }
            }
        }

        /// Yields (no wall clock) until `condition` holds or the bound runs out.
        private static func yield(until condition: () -> Bool) async {
            for _ in 0..<10_000 where !condition() { await Task.yield() }
        }

        private struct NoSync: BrowserBridgeSyncRequesting {
            func syncPlan() async throws -> SyncPlanOutput { .init(accounts: []) }
            func requestSync(vendorAccountID: String, backfill: BrowserBridgeBackfillRange?) async throws
                -> StartSyncOutput
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

            let ticks = Ticks()

            init(syncClient: any BrowserBridgeSyncRequesting = NoSync()) throws {
                let store = InMemorySessionTokenStore()
                try store.save(.bearer("tok"), for: "127.0.0.1:9")
                coordinator = MacBrowserBridgeCoordinator(
                    baseURL: URL(string: "http://127.0.0.1:9")!,
                    credentials: CredentialProvider(host: "127.0.0.1:9", store: store),
                    deviceID: UUID(), accountClient: roster, syncClient: syncClient,
                    executorFactory: { [unowned self] _, accountID in
                        openedExecutors.append(accountID)
                        return try MacBrowserCommandExecutor(
                            target: .installed(.chrome), accountID: accountID, evidenceUploader: NoUpload(),
                            captureStore: .init(
                                rootDirectory: FileManager.default.temporaryDirectory
                                    .appendingPathComponent(UUID().uuidString)))
                    },
                    replayStoreFactory: { _ in EmptyReplayStore() },
                    rosterRefreshTick: { [ticks] in try await ticks.tick() },
                    observer: { [unowned self] event in
                        switch event {
                        case .accounts(let accounts): publishedAccounts.append(accounts.map(\.id))
                        case .fleetStatus(_, _, let total): fleetTotals.append(total)
                        default: break
                        }
                    })
            }
        }

        private actor SyncRequests: BrowserBridgeSyncRequesting {
            let plan: SyncPlanOutput
            private(set) var submitted: [String] = []

            init() throws {
                // Failure modes: a selected blocked account silently succeeds; Sync all drops
                // blocked or omitted accounts; selecting one eligible account submits others.
                plan = try JSONDecoder().decode(
                    SyncPlanOutput.self,
                    from: Data(
                        #"""
                        {"accounts":[
                          {"shortcode":"VACCT-AAAA","label":"Blocked","vendorName":"Example shop",
                           "action":{"kind":"blocked","runId":"RUN-EXAMPLE","purpose":"product_enrichment"},
                           "line":"Finish selected work.","disabledReason":"Finish selected work."},
                          {"shortcode":"VACCT-BBBB","label":"Eligible","vendorName":"Example shop",
                           "action":{"kind":"firstSync"},"line":"First sync.","disabledReason":null}
                        ]}
                        """#.utf8))
            }

            func syncPlan() async throws -> SyncPlanOutput { plan }
            func requestSync(vendorAccountID: String, backfill: BrowserBridgeBackfillRange?) async throws
                -> StartSyncOutput
            {
                submitted.append(vendorAccountID)
                return .init(runId: "RUN-EXAMPLE", resumed: false)
            }
        }

        @Test("Selected sync refuses blocked accounts; Sync all submits eligible work and reports every skip")
        func syncAdmission() async throws {
            let sync = try SyncRequests()
            let harness = try Harness(syncClient: sync)
            harness.roster.set(["VACCT-AAAA", "VACCT-BBBB", "VACCT-CCCC"])
            do {
                _ = try await harness.coordinator.syncNow(browser: .chrome, accountID: "VACCT-AAAA")
                Issue.record("Selected blocked account succeeded")
            } catch {
                #expect(error.localizedDescription.contains("Finish selected work."))
            }
            #expect(await sync.submitted.isEmpty)
            let selected = try await harness.coordinator.syncNow(browser: .chrome, accountID: "VACCT-BBBB")
            #expect(selected.count == 1)
            #expect(await sync.submitted == ["VACCT-BBBB"])
            do {
                _ = try await harness.coordinator.syncNow(browser: .chrome)
                Issue.record("Sync all silently skipped accounts")
            } catch {
                #expect(error.localizedDescription.contains("VACCT-AAAA: Finish selected work."))
                #expect(error.localizedDescription.contains("VACCT-CCCC: This account is unavailable"))
                #expect(error.localizedDescription.contains("submitted 1"))
                let partial = try #require(error as? BrowserBridgeSyncFailure)
                #expect(partial.submitted.map(\.runId) == ["RUN-EXAMPLE"])
            }
            #expect(await sync.submitted == ["VACCT-BBBB", "VACCT-BBBB"])
            await harness.coordinator.disconnect()
        }

        @Test("A newly listed account gets a bridge without reconnecting existing ones")
        func addedAccount() async throws {
            let harness = try Harness()
            harness.roster.set(["VACCT-AAAA"])
            try await harness.coordinator.connect(browser: .chrome)
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
            try await harness.coordinator.connect(browser: .chrome)

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
                try await harness.coordinator.connect(browser: .chrome)
            }
            harness.roster.set(["VACCT-AAAA"])
            try await harness.coordinator.refreshRoster()
            #expect(harness.openedExecutors == ["VACCT-AAAA"])
            #expect(harness.fleetTotals.last == 1)
            await harness.coordinator.disconnect()
        }

        @Test("The periodic refresh picks up an account after an empty connect, and stops on disconnect")
        func periodicRefresh() async throws {
            let harness = try Harness()
            await #expect(throws: MacBrowserBridgeCoordinator.Failure.self) {
                try await harness.coordinator.connect(browser: .chrome)
            }
            await Self.yield { harness.ticks.waits == 1 }
            harness.roster.set(["VACCT-AAAA"])
            harness.ticks.fire()
            // The loop waits on its next tick only after the refresh it ran has finished.
            await Self.yield { harness.ticks.waits == 2 }
            #expect(harness.ticks.waits == 2)
            #expect(harness.openedExecutors == ["VACCT-AAAA"])

            await harness.coordinator.disconnect()
            harness.roster.set(["VACCT-AAAA", "VACCT-BBBB"])
            harness.ticks.fire()
            await Self.yield { false }
            #expect(harness.openedExecutors == ["VACCT-AAAA"])
            #expect(harness.ticks.waits == 2)
        }

        @Test("A refresh racing a reconnect never leaves a second bridge for one account")
        func refreshDuringReconnect() async throws {
            let harness = try Harness()
            harness.roster.set(["VACCT-AAAA"])
            harness.roster.gate()
            let connect = Task {
                try await harness.coordinator.connect(browser: .chrome)
            }
            await Self.yield { harness.roster.pendingCount == 1 }
            #expect(harness.roster.pendingCount == 1)

            // An activation refresh while the replacement's listing is outstanding. If it lists
            // at all before the replacement finishes, it finishes first: the worst order.
            let refresh = Task { try await harness.coordinator.refreshRoster() }
            await Self.yield { harness.roster.pendingCount == 2 }
            if harness.roster.pendingCount == 2 {
                harness.roster.release(1)
                try await refresh.value
            }
            harness.roster.ungate()
            try await connect.value
            try await refresh.value

            // One executor ever created means no second, unowned bridge for the account.
            #expect(harness.openedExecutors == ["VACCT-AAAA"])
            #expect(harness.fleetTotals.last == 1)
            await harness.coordinator.disconnect()
        }
    }
#endif
