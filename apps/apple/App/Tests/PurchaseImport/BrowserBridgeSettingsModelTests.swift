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

        func syncPlan() async throws -> SyncPlanOutput {
            planReads += 1
            return .init(accounts: plans)
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
    @Test func repeatedAccountAppearsOnceButDistinctAccountsRemain() async {
        let controller = StubController()
        let first = SyncPlanAccount(
            shortcode: "VACCT-4K7M", label: "Example Seeds",
            vendorName: "Example Seeds", action: .firstSync(.init(kind: .firstSync)),
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
