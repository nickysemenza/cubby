import CubbyKit
import Foundation
import Observation

@MainActor
protocol BrowserBridgeControlling: AnyObject {
    func connect(browser: BrowserChoice, enhancedEvidence: Bool) async throws
    func syncNow(browser: BrowserChoice, enhancedEvidence: Bool) async throws
    func disconnect() async
    func raiseAuthenticationWindow(for accountID: String)
    func appDidBecomeActive()
}

@MainActor
struct BrowserBridgeAccountState: Identifiable, Equatable {
    let id: String
    let label: String
    var connection: BrowserBridgeConnectionStatus
    var error: String?
    var needsAuthentication: Bool
    var lastCompletedRunID: String?

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
    @ObservationIgnored private weak var controller: (any BrowserBridgeControlling)?

    var isConfigured: Bool { controller != nil }

    func install(controller: any BrowserBridgeControlling) {
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

    func setAccounts(_ accounts: [BrowserBridgeVendorAccount]) {
        accountStates = accounts.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
            .map {
                BrowserBridgeAccountState(
                    id: $0.id, label: $0.label, connection: .connecting, error: nil,
                    needsAuthentication: false, lastCompletedRunID: nil)
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
            try await controller.connect(
                browser: Self.persistedBrowser, enhancedEvidence: Self.persistedEnhancedEvidence)
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "purchaseImport.browser.connect")
        }
    }

    func reconnect(browser: BrowserChoice, enhancedEvidence: Bool) {
        guard let controller, !isSyncing else { return }
        error = nil
        Task { [weak self] in
            do {
                try await controller.connect(browser: browser, enhancedEvidence: enhancedEvidence)
            } catch {
                guard let self else { return }
                self.error = error.localizedDescription
                Diagnostics.report(error, context: "purchaseImport.browser.reconnect")
            }
        }
    }

    func syncNow(browser: BrowserChoice, enhancedEvidence: Bool) {
        guard let controller, !isSyncing else { return }
        isSyncing = true
        syncStartedAt = .now
        error = nil
        Task { [weak self] in
            do {
                try await controller.syncNow(browser: browser, enhancedEvidence: enhancedEvidence)
                guard let self else { return }
                lastCompletedAt = .now
                isSyncing = false
                syncStartedAt = nil
            } catch {
                guard let self else { return }
                self.error = error.localizedDescription
                isSyncing = false
                syncStartedAt = nil
                Diagnostics.report(error, context: "purchaseImport.browser.sync")
            }
        }
    }

    func disconnect() async {
        await controller?.disconnect()
        status = .disconnected
        setAccountCounts(connected: 0, total: 0)
        accountStates = []
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

    private static var persistedEnhancedEvidence: Bool {
        UserDefaults.standard.bool(forKey: "purchaseImport.enhancedEvidence")
    }
}
