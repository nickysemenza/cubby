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

        func syncPlan() async throws -> SyncPlanOutput {
            planReads += 1
            return .init(accounts: [])
        }

        func connect(browser: BrowserChoice) async throws {}
        func syncNow(
            browser: BrowserChoice, accountID: String?, backfill: BrowserBridgeBackfillRange?
        ) async throws {
            selectedAccountIDs.append(accountID)
            backfills.append(backfill)
            if let failure { throw failure }
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
