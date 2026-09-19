import CoreGraphics
import CubbyKit
import Foundation

@MainActor
final class MacBrowserBridgeController: BrowserBridgeControlling {
    enum Failure: LocalizedError {
        case bearerSessionRequired
        case noActiveAccounts

        var errorDescription: String? {
            switch self {
            case .bearerSessionRequired:
                "Sign in with your Cubby account before connecting the browser bridge."
            case .noActiveAccounts:
                "No eligible vendor accounts are available for browser import."
            }
        }
    }

    private let baseURL: URL
    private let client: CubbyClient
    private let accountClient: any BrowserBridgeVendorAccountListing
    private let credentials: CredentialProvider
    private let syncClient: any BrowserBridgeSyncRequesting
    private weak var settings: BrowserBridgeSettingsModel?
    private var bridges: [String: URLSessionBrowserBridge] = [:]
    private var accounts: [String: BrowserBridgeVendorAccount] = [:]
    private var statuses: [String: BrowserBridgeConnectionStatus] = [:]
    private var generation = UUID()

    init(
        baseURL: URL, client: CubbyClient, credentials: CredentialProvider,
        settings: BrowserBridgeSettingsModel
    ) {
        self.baseURL = baseURL
        self.client = client
        self.credentials = credentials
        accountClient = URLSessionBrowserBridgeVendorAccountClient(
            baseURL: baseURL, credentials: credentials)
        syncClient = URLSessionBrowserBridgeSyncClient(baseURL: baseURL, credentials: credentials)
        self.settings = settings
    }

    func connect(browser: BrowserChoice, enhancedEvidence: Bool) async throws {
        await replaceConnections(browser: browser, enhancedEvidence: enhancedEvidence)
    }

    func syncNow(browser: BrowserChoice, enhancedEvidence: Bool) async throws {
        // Refresh the roster and browser preference first so a newly added or paused account is
        // reflected in this manual run, then enqueue one server-owned run per eligible account.
        try await replaceConnections(browser: browser, enhancedEvidence: enhancedEvidence)
        var firstFailure: (any Error)?
        var submitted = 0
        for account in accounts.values.sorted(by: { $0.id < $1.id }) {
            do {
                _ = try await syncClient.requestSync(vendorAccountID: account.id)
                submitted += 1
            } catch {
                firstFailure = firstFailure ?? error
            }
        }
        if submitted == 0, let firstFailure { throw firstFailure }
    }

    func disconnect() async {
        await tearDown(reportStatus: true)
    }

    func retire() async {
        await tearDown(reportStatus: false)
    }

    private func tearDown(reportStatus: Bool) async {
        generation = UUID()
        let current = Array(bridges.values)
        bridges = [:]
        accounts = [:]
        statuses = [:]
        if reportStatus {
            settings?.setAccountCounts(connected: 0, total: 0)
            settings?.setStatus(.disconnected)
        }
        for bridge in current { await bridge.disconnect() }
    }

    private func replaceConnections(browser: BrowserChoice, enhancedEvidence: Bool) async throws {
        let old = Array(bridges.values)
        bridges = [:]
        statuses = [:]
        for bridge in old { await bridge.disconnect() }

        guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
            throw Failure.bearerSessionRequired
        }
        let listedAccounts = try await accountClient.browserBridgeVendorAccounts()
        guard !listedAccounts.isEmpty else {
            settings?.setAccountCounts(connected: 0, total: 0)
            settings?.setStatus(.disconnected)
            throw Failure.noActiveAccounts
        }

        let generation = UUID()
        self.generation = generation
        accounts = Dictionary(uniqueKeysWithValues: listedAccounts.map { ($0.id, $0) })
        settings?.setAccountCounts(connected: 0, total: listedAccounts.count)
        settings?.setStatus(.connecting)
        let uploader = CubbyBrowserEvidenceUploader(client: client)
        let capabilities = BrowserBridgeCapabilities(
            enhancedScreenshot: enhancedEvidence && CGPreflightScreenCaptureAccess(),
            renderedPDF: false)

        for account in listedAccounts {
            let executor = MacBrowserCommandExecutor(browser: browser, evidenceUploader: uploader)
            let replayStore = try FileBrowserBridgeReplayStore.applicationSupport(
                namespace: "\(CubbyBaseURL.host(of: baseURL))-\(account.id)")
            let bridge = URLSessionBrowserBridge(
                replayStore: replayStore, executor: executor
            ) { [weak self] status in
                Task { @MainActor [weak self] in
                    self?.didChangeStatus(
                        status, accountID: account.id, generation: generation)
                }
            }
            bridges[account.id] = bridge
            statuses[account.id] = .connecting
            let url = try BrowserBridgeEndpoint.socketURL(
                baseURL: baseURL, vendorAccountID: account.id)
            await bridge.connect(
                BrowserBridgeConnectionConfiguration(
                    url: url, deviceID: Self.deviceID, browser: browser,
                    capabilities: capabilities
                ) { [credentials] in
                    guard case .bearer(let token) = await credentials.current() else { return nil }
                    return token
                })
        }
        publishFleetStatus()
    }

    private func didChangeStatus(
        _ status: BrowserBridgeConnectionStatus, accountID: String, generation: UUID
    ) {
        guard generation == self.generation, bridges[accountID] != nil else { return }
        statuses[accountID] = status
        publishFleetStatus()
    }

    private func publishFleetStatus() {
        let connected = statuses.values.count { $0 == .connected }
        settings?.setAccountCounts(connected: connected, total: bridges.count)
        settings?.setStatus(BrowserBridgeFleetStatus.aggregate(statuses.values))
    }

    private static var deviceID: UUID {
        let key = "purchaseImport.browserBridge.deviceID"
        if let raw = UserDefaults.standard.string(forKey: key), let value = UUID(uuidString: raw) {
            return value
        }
        let value = UUID()
        UserDefaults.standard.set(value.uuidString, forKey: key)
        return value
    }
}
