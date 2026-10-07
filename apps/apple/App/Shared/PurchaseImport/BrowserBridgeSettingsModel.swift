import CubbyKit
import Foundation
import Observation

@MainActor
protocol BrowserBridgeControlling: AnyObject {
    func connect(browser: BrowserChoice) async throws
    func syncPlan() async throws -> SyncPlanOutput
    func syncNow(
        browser: BrowserChoice, accountID: String?, backfill: BrowserBridgeBackfillRange?
    ) async throws -> [StartSyncOutput]
    func disconnect() async
    func raiseAuthenticationWindow(for accountID: String)
    func appDidBecomeActive()
}

@MainActor
struct BrowserBridgeAccountState: Identifiable, Equatable {
    let id: String
    var label: String
    var connection: BrowserBridgeConnectionStatus
    var error: String?
    var needsAuthentication: Bool
    var lastCompletedRunID: String?
    /// The last browser command and what the Mac observed, e.g. "capture · window minimized →
    /// screenshot unavailable".
    var lastCommand: String? = nil

    var statusLabel: String {
        if needsAuthentication { return "Sign-in required" }
        if error != nil { return "Needs attention" }
        return switch connection {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .waitingToReconnect: "Waiting to reconnect"
        case .failed: "Needs attention"
        }
    }
}

@MainActor
@Observable
final class BrowserBridgeSettingsModel {
    private(set) var status: BrowserBridgeConnectionStatus = .disconnected
    private(set) var isSyncing = false
    /// Set on the transition into syncing, cleared alongside `isSyncing`. SwiftUI reads
    /// `currentActivities` on every body evaluation, so a literal `.now` there would make the
    /// Activity screen's relative timestamp perpetually say "now" — this is computed once per sync
    /// instead.
    private(set) var syncStartedAt: Date?
    private(set) var lastCompletedAt: Date?
    private(set) var connectedAccountCount = 0
    private(set) var accountCount = 0
    private(set) var accountStates: [BrowserBridgeAccountState] = []
    private(set) var error: String?
    private(set) var syncPlans: [SyncPlanAccount] = []
    private(set) var syncPlanError: String?
    @ObservationIgnored private var syncPlanGeneration = UUID()
    @ObservationIgnored private var syncGeneration = UUID()
    @ObservationIgnored private weak var controller: (any BrowserBridgeControlling)?

    var isConfigured: Bool { controller != nil }

    func install(controller: any BrowserBridgeControlling) {
        syncGeneration = UUID()
        isSyncing = false
        syncStartedAt = nil
        self.controller = controller
        error = nil
    }

    func setStatus(_ status: BrowserBridgeConnectionStatus) {
        self.status = status
    }

    func setAccountCounts(connected: Int, total: Int) {
        connectedAccountCount = connected
        accountCount = total
    }

    /// A roster refresh republishes the list while existing bridges stay connected, so an
    /// account that is still listed keeps its connection, error and sign-in state.
    func setAccounts(_ accounts: [BrowserBridgeVendorAccount]) {
        let rosterChanged =
            Set(accounts.map(\.id)) != Set(accountStates.map(\.id))
            || accounts.contains { account in
                accountStates.first { $0.id == account.id }?.label != account.label
            }
        let existing = Dictionary(uniqueKeysWithValues: accountStates.map { ($0.id, $0) })
        accountStates = accounts.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
            .map { account in
                var state =
                    existing[account.id]
                    ?? BrowserBridgeAccountState(
                        id: account.id, label: account.label, connection: .connecting, error: nil,
                        needsAuthentication: false, lastCompletedRunID: nil)
                state.label = account.label
                return state
            }
        if rosterChanged {
            let generation = syncPlanGeneration
            Task { [weak self] in
                guard let self, syncPlanGeneration == generation else { return }
                await refreshSyncPlan()
            }
        }
    }

    func setAccountStatus(_ status: BrowserBridgeConnectionStatus, accountID: String) {
        guard let index = accountStates.firstIndex(where: { $0.id == accountID }) else { return }
        accountStates[index].connection = status
    }

    func requireAuthentication(accountID: String, message: String) {
        guard let index = accountStates.firstIndex(where: { $0.id == accountID }) else { return }
        accountStates[index].needsAuthentication = true
        accountStates[index].error = message
    }

    func setAccountError(_ message: String?, accountID: String) {
        guard let index = accountStates.firstIndex(where: { $0.id == accountID }) else { return }
        accountStates[index].needsAuthentication = false
        accountStates[index].error = message
    }

    func setLastCommand(_ summary: String, accountID: String) {
        guard let index = accountStates.firstIndex(where: { $0.id == accountID }) else { return }
        accountStates[index].lastCommand = summary
    }

    func markRunCompleted(accountID: String, runID: String) {
        guard let index = accountStates.firstIndex(where: { $0.id == accountID }) else { return }
        accountStates[index].needsAuthentication = false
        accountStates[index].error = nil
        accountStates[index].lastCompletedRunID = runID
        lastCompletedAt = .now
    }

    func raiseAuthenticationWindow(accountID: String) {
        controller?.raiseAuthenticationWindow(for: accountID)
    }

    func appDidBecomeActive() {
        controller?.appDidBecomeActive()
    }

    func connectConfigured() async {
        guard let controller else { return }
        do {
            try await controller.connect(browser: Self.persistedBrowser)
            await refreshSyncPlan()
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "purchaseImport.browser.connect")
        }
    }

    func reconnect(browser: BrowserChoice) {
        guard let controller, !isSyncing else { return }
        error = nil
        Task { [weak self] in
            do {
                try await controller.connect(browser: browser)
                await self?.refreshSyncPlan()
            } catch {
                guard let self else { return }
                self.error = error.localizedDescription
                Diagnostics.report(error, context: "purchaseImport.browser.reconnect")
            }
        }
    }

    var syncableAccountCount: Int { syncPlans.filter { $0.disabledReason == nil }.count }

    func refreshSyncPlan() async {
        guard let controller else { return }
        let generation = UUID()
        syncPlanGeneration = generation
        do {
            let plans = try await controller.syncPlan().accounts
            guard syncPlanGeneration == generation else { return }
            // Account identity, not vendor name: one vendor may have multiple valid accounts.
            var seen = Set<String>()
            syncPlans = plans.filter { seen.insert($0.shortcode).inserted }
            syncPlanError = nil
        } catch {
            guard syncPlanGeneration == generation else { return }
            syncPlanError = error.localizedDescription
            Diagnostics.report(error, context: "purchaseImport.browser.syncPlan")
        }
    }

    func syncNow(
        browser: BrowserChoice, accountID: String? = nil, backfill: BrowserBridgeBackfillRange? = nil,
        onSubmitted: @escaping @MainActor ([StartSyncOutput]) -> Void = { _ in }
    ) {
        guard let controller, !isSyncing else { return }
        let generation = UUID()
        syncGeneration = generation
        isSyncing = true
        syncStartedAt = .now
        error = nil
        Task { [weak self] in
            do {
                let runs = try await controller.syncNow(
                    browser: browser, accountID: accountID, backfill: backfill)
                guard let self, syncGeneration == generation else { return }
                onSubmitted(runs)
                await refreshSyncPlan()
                guard syncGeneration == generation else { return }
                lastCompletedAt = .now
                isSyncing = false
                syncStartedAt = nil
            } catch {
                guard let self, syncGeneration == generation else { return }
                if let partial = error as? BrowserBridgeSyncFailure, !partial.submitted.isEmpty {
                    onSubmitted(partial.submitted)
                }
                await refreshSyncPlan()
                guard syncGeneration == generation else { return }
                self.error = error.localizedDescription
                isSyncing = false
                syncStartedAt = nil
                Diagnostics.report(error, context: "purchaseImport.browser.sync")
            }
        }
    }

    func disconnect() async {
        syncGeneration = UUID()
        isSyncing = false
        syncStartedAt = nil
        await controller?.disconnect()
        syncPlanGeneration = UUID()
        syncPlanError = nil
        status = .disconnected
        setAccountCounts(connected: 0, total: 0)
        accountStates = []
        syncPlans = []
    }

    var statusLabel: String {
        if isSyncing {
            return "Syncing"
        }
        switch status {
        case .disconnected: return isConfigured ? "Disconnected" : "Awaiting server support"
        case .connecting: return "Connecting"
        case .connected:
            return accountCount > 1 ? "Connected · \(connectedAccountCount) of \(accountCount)" : "Connected"
        case .waitingToReconnect: return "Waiting for network"
        case .failed: return "Needs attention"
        }
    }

    private static var persistedBrowser: BrowserChoice {
        UserDefaults.standard.string(forKey: "purchaseImport.browser").flatMap(BrowserChoice.init)
            ?? .chrome
    }
}
