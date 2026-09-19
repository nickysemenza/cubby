import CubbyKit
import Foundation
import Observation

@MainActor
protocol BrowserBridgeControlling: AnyObject {
    func connect(browser: BrowserChoice, enhancedEvidence: Bool) async throws
    func syncNow(browser: BrowserChoice, enhancedEvidence: Bool) async throws
    func disconnect() async
}

@MainActor
@Observable
final class BrowserBridgeSettingsModel {
    private(set) var status: BrowserBridgeConnectionStatus = .disconnected
    private(set) var isSyncing = false
    private(set) var lastCompletedAt: Date?
    private(set) var connectedAccountCount = 0
    private(set) var accountCount = 0
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
        error = nil
        Task { [weak self] in
            do {
                try await controller.syncNow(browser: browser, enhancedEvidence: enhancedEvidence)
                guard let self else { return }
                lastCompletedAt = .now
                isSyncing = false
            } catch {
                guard let self else { return }
                self.error = error.localizedDescription
                isSyncing = false
                Diagnostics.report(error, context: "purchaseImport.browser.sync")
            }
        }
    }

    func disconnect() async {
        await controller?.disconnect()
        status = .disconnected
        setAccountCounts(connected: 0, total: 0)
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
