import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("BrowserBridgeSettingsModel sync")
struct BrowserBridgeSettingsModelTests {
    private final class StubController: BrowserBridgeControlling {
        var backfills: [BrowserBridgeBackfillRange?] = []
        var failure: (any Error)?
        var selectedAccountIDs: [String?] = []
        var planReads = 0
        var plans: [SyncPlanAccount] = []
        var submitted: [StartSyncOutput] = []
        var pending: CheckedContinuation<Void, Never>?
        var suspendSubmission = false
        var suspendPlanRead = false
        var pendingPlan: CheckedContinuation<Void, Never>?

        func syncPlan() async throws -> SyncPlanOutput {
            planReads += 1
            let result = SyncPlanOutput(accounts: plans)
            if suspendPlanRead { await withCheckedContinuation { pendingPlan = $0 } }
            return result
        }

        func connect(browser: BrowserChoice) async throws {}
        func syncNow(
            browser: BrowserChoice, accountID: String?, backfill: BrowserBridgeBackfillRange?
        ) async throws -> [StartSyncOutput] {
            selectedAccountIDs.append(accountID)
            if suspendSubmission {
                await withCheckedContinuation { pending = $0 }
            }
            backfills.append(backfill)
            if let failure { throw failure }
            return submitted
        }
        func disconnect() async {}
        func raiseAuthenticationWindow(for accountID: String) {}
        func appDidBecomeActive() {}
    }

    #if os(macOS)
        @Test func replacedControllerCannotRestoreExecutingBrowserRun() {
            let settings = BrowserBridgeSettingsModel()
            let baseURL = URL(string: "http://127.0.0.1:19876")!
            let credentials = CredentialProvider(
                host: "127.0.0.1:19876", store: InMemorySessionTokenStore())
            let client = CubbyClient(baseURL: baseURL, credentials: credentials)
            let previous = MacBrowserBridgeController(
                baseURL: baseURL, client: client, credentials: credentials, settings: settings)
            settings.install(controller: previous)
            previous.project(
                .accounts([
                    .init(
                        id: "account-first", label: "Example account", ledgerPartyId: "household-example",
                        browser: .chrome)
                ]))
            previous.project(.executingRuns(accountID: "account-first", runIDs: ["RUN-4K7M"]))
            #expect(settings.accountStates.first?.executingRuns.count == 1)

            let replacement = MacBrowserBridgeController(
                baseURL: baseURL, client: client, credentials: credentials, settings: settings)
            settings.install(controller: replacement)
            // A callback already queued on the old bridge can arrive before asynchronous retirement.
            previous.project(.executingRuns(accountID: "account-first", runIDs: ["RUN-4K7M"]))
            #expect(settings.accountStates.first?.executingRuns.isEmpty == true)
            replacement.project(.executingRuns(accountID: "account-first", runIDs: ["RUN-EXAMPLE"]))
            #expect(Set(settings.accountStates.first?.executingRuns.keys.map { $0 } ?? []) == ["RUN-EXAMPLE"])
        }
    #endif

    // Browser execution must be visible outside manual submission, preserve a stable start
    // through reconnect, deduplicate shared Runs, and disappear with retired connections.
    @Test func automaticBrowserRunsProjectIntoExistingActivity() async {
        let model = BrowserBridgeSettingsModel()
        model.install(controller: StubController())
        model.setAccounts([
            .init(
                id: "account-first", label: "Example account", ledgerPartyId: "household-example",
                browser: .chrome),
            .init(
                id: "account-second", label: "Another account", ledgerPartyId: "household-example",
                browser: .chrome),
        ])
        model.setExecutingRuns(["RUN-4K7M"], accountID: "account-first")
        model.setExecutingRuns(["RUN-4K7M", "RUN-EXAMPLE"], accountID: "account-second")
        model.setLastCommand("navigate · shop.example/item", runID: "RUN-4K7M", accountID: "account-first")
        #expect(model.accountStates.first { $0.id == "account-first" }?.lastCommandRunID == "RUN-4K7M")
        let initial = model.currentActivities
        #expect(initial.count == 2)
        #expect(Set(initial.map(\.link)) == [.serverRun("RUN-4K7M"), .serverRun("RUN-EXAMPLE")])
        model.setAccountStatus(.waitingToReconnect(attempt: 1), accountID: "account-first")
        model.setExecutingRuns(["RUN-4K7M"], accountID: "account-first")
        #expect(model.currentActivities == initial)
        model.setExecutingRuns([], accountID: "account-second")
        #expect(model.currentActivities.count == 1)
        model.install(controller: StubController())
        #expect(model.currentActivities.isEmpty)
        model.setExecutingRuns(["RUN-4K7M"], accountID: "account-first")
        await model.disconnect()
        #expect(model.currentActivities.isEmpty)
    }

    private struct ServerRefusal: LocalizedError {
        var errorDescription: String? { "The account already has an active run." }
    }

    private func settle(_ model: BrowserBridgeSettingsModel) async {
        for _ in 0..<500 where model.isSyncing { await Task.yield() }
    }

    private let range = BrowserBridgeBackfillRange(
        from: Date(timeIntervalSince1970: 1_700_000_000),
        to: Date(timeIntervalSince1970: 1_730_000_000))

    // Failure modes: duplicated plan rows can repeat actions; same-vendor accounts must not
    // coalesce; a submitted/resumed run can lose its navigation target; refusals must not navigate.
    // Server snapshots must follow socket/authentication/completion events, rather than
    // depending on a changed roster or the member manually refreshing Browser Sync.
    @Test func lifecycleEventsRefreshServerAccountProjection() async {
        let controller = StubController()
        let model = BrowserBridgeSettingsModel()
        model.setAccounts([
            .init(id: "VACCT-4K7M", label: "Example account", ledgerPartyId: "LP-EXAMPLE", browser: .chrome)
        ])
        model.install(controller: controller)
        await model.refreshSyncPlan()
        var expected = controller.planReads
        func expectRefresh() async {
            expected += 1
            for _ in 0..<500 where controller.planReads < expected { await Task.yield() }
            #expect(controller.planReads >= expected)
        }
        model.setAccountStatus(.connected, accountID: "VACCT-4K7M")
        await expectRefresh()
        model.requireAuthentication(accountID: "VACCT-4K7M", message: "Sign in")
        await expectRefresh()
        model.markRunCompleted(accountID: "VACCT-4K7M", runID: "RUN-4K7M")
        await expectRefresh()
        model.setAccountStatus(.disconnected, accountID: "VACCT-4K7M")
        await expectRefresh()
    }

    @Test func repeatedAccountAppearsOnceButDistinctAccountsRemain() async {
        let controller = StubController()
        let first = SyncPlanAccount(
            shortcode: "VACCT-4K7M", label: "Example Seeds",
            vendorName: "Example Seeds", accountStatus: .active, connected: false, lastSuccessAt: nil,
            action: .firstSync(.init(kind: .firstSync)),
            line: "First sync", disabledReason: nil)
        var second = first
        second.shortcode = "VACCT-EXAMPLE"
        second.label = "Second account"
        controller.plans = [first, second, first]
        let model = BrowserBridgeSettingsModel()
        model.install(controller: controller)
        await model.refreshSyncPlan()
        #expect(model.syncPlans.count == 2)
        #expect(model.syncableAccountCount == 2)
    }

    @Test func submittedRunOpensConsoleBeforePlanRefresh() async {
        let controller = StubController()
        controller.submitted = [.init(runId: "RUN-4K7M", resumed: true)]
        let model = BrowserBridgeSettingsModel()
        model.install(controller: controller)
        let navigator = Navigator()
        var readsAtNavigation: Int?
        model.syncNow(browser: .chrome, accountID: "VACCT-4K7M") { runs in
            readsAtNavigation = controller.planReads
            navigator.openRecord(.init(key: .run, id: runs[0].runId))
        }
        await settle(model)
        #expect(readsAtNavigation == 0)
        #expect(navigator.paths[.today] == [.entityDetail(.run, id: "RUN-4K7M")])
    }

    @Test func partialBatchSuccessStillNavigatesAndPreservesFailure() async {
        let controller = StubController()
        controller.failure = BrowserBridgeSyncFailure(
            message: "One account failed", submitted: [.init(runId: "RUN-4K7M", resumed: false)])
        let model = BrowserBridgeSettingsModel()
        model.install(controller: controller)
        var opened: [String] = []
        model.syncNow(browser: .chrome) { opened = $0.map(\.runId) }
        await settle(model)
        #expect(opened == ["RUN-4K7M"])
        #expect(model.error == "One account failed")
    }

    @Test func replacedControllerDiscardsLateNavigation() async throws {
        let old = StubController()
        old.suspendSubmission = true
        old.submitted = [.init(runId: "RUN-4K7M", resumed: false)]
        let model = BrowserBridgeSettingsModel()
        model.install(controller: old)
        var opened = false
        model.syncNow(browser: .chrome) { _ in opened = true }
        for _ in 0..<500 where old.pending == nil { await Task.yield() }
        let pending = try #require(old.pending)
        let replacement = StubController()
        model.install(controller: replacement)
        pending.resume()
        await settle(model)
        for _ in 0..<20 { await Task.yield() }
        #expect(!opened)
        #expect(replacement.planReads == 0)
        #expect(model.error == nil)
        #expect(!model.isSyncing)
    }

    @Test func replacedControllerDiscardsLatePlan() async throws {
        let old = StubController()
        old.suspendPlanRead = true
        old.plans = [
            .init(
                shortcode: "VACCT-4K7M", label: "Old server account",
                vendorName: "Example shop", accountStatus: .active, connected: false, lastSuccessAt: nil,
                action: .firstSync(.init(kind: .firstSync)),
                line: "First sync", disabledReason: nil)
        ]
        let model = BrowserBridgeSettingsModel()
        model.install(controller: old)
        let refresh = Task { await model.refreshSyncPlan() }
        for _ in 0..<500 where old.pendingPlan == nil { await Task.yield() }
        let pending = try #require(old.pendingPlan)
        let replacement = StubController()
        model.install(controller: replacement)
        pending.resume()
        await refresh.value
        #expect(model.syncPlans.isEmpty)
    }

    @Test func plainSyncCarriesNoBackfillRange() async {
        let controller = StubController()
        let model = BrowserBridgeSettingsModel()
        model.install(controller: controller)

        model.syncNow(browser: .chrome)
        await settle(model)

        #expect(controller.backfills == [nil])
        #expect(controller.selectedAccountIDs == [nil])
        #expect(controller.planReads == 1)
        #expect(model.error == nil)
    }

    @Test func backfillSyncPassesTheRangeAndEndsIdle() async {
        let controller = StubController()
        let model = BrowserBridgeSettingsModel()
        model.install(controller: controller)

        model.syncNow(browser: .chrome, accountID: "VACCT-4K7M", backfill: range)
        await settle(model)

        #expect(controller.backfills == [range])
        #expect(controller.selectedAccountIDs == ["VACCT-4K7M"])
        #expect(controller.planReads == 1)
        #expect(!model.isSyncing)
    }

    @Test func serverRefusalIsShownVerbatim() async {
        let controller = StubController()
        controller.failure = ServerRefusal()
        let model = BrowserBridgeSettingsModel()
        model.install(controller: controller)

        model.syncNow(browser: .chrome, backfill: range)
        await settle(model)

        #expect(model.error == "The account already has an active run.")
        #expect(!model.isSyncing)
    }
}
