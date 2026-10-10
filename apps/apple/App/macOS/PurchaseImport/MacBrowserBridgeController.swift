import AppKit
import CubbyKit
import Foundation

/// Settings and notification projection; the shared coordinator owns sockets, replay and browser windows.
@MainActor
final class MacBrowserBridgeController: BrowserBridgeControlling {
    private let baseURL: URL
    private let client: CubbyClient
    private let credentials: CredentialProvider
    private weak var settings: BrowserBridgeSettingsModel?
    private let notifier = MacBrowserBridgeNotifier()
    private var statuses: [String: BrowserBridgeConnectionStatus] = [:]

    private lazy var coordinator = MacBrowserBridgeCoordinator(
        baseURL: baseURL, credentials: credentials, deviceID: AppInstallationID.current,
        accountClient: URLSessionBrowserBridgeVendorAccountClient(baseURL: baseURL, credentials: credentials),
        syncClient: BrowserBridgeSyncClient(client: client),
        executorFactory: { [baseURL, client] browser, accountID in
            try MacBrowserCommandExecutor(
                target: Self.executionTarget(browser: browser, baseURL: baseURL),
                accountID: accountID, evidenceUploader: CubbyBrowserEvidenceUploader(client: client),
                captureStore: .caches(namespace: "\(CubbyBaseURL.host(of: baseURL))-\(accountID)"))
        },
        replayStoreFactory: { [baseURL] accountID in
            try FileBrowserBridgeReplayStore.applicationSupport(
                namespace: "\(CubbyBaseURL.host(of: baseURL))-\(accountID)")
        },
        observer: { [weak self] event in self?.project(event) })

    init(
        baseURL: URL, client: CubbyClient, credentials: CredentialProvider,
        settings: BrowserBridgeSettingsModel
    ) {
        self.baseURL = baseURL
        self.client = client
        self.credentials = credentials
        self.settings = settings
        #if DEBUG
            let reporter = URLSessionBrowserBridgeDebugReporter(
                baseURL: baseURL, credentials: credentials,
                executor: ActivityExecutor(
                    kind: .device, deviceId: AppInstallationID.current.uuidString.lowercased(),
                    name: ProcessInfo.processInfo.hostName, platform: .macos,
                    appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
                        as? String,
                    osVersion: ProcessInfo.processInfo.operatingSystemVersionString))
            Task { await BrowserBridgeDebugLog.installRemoteReporter(reporter) }
        #endif
    }

    func connect(browser: BrowserChoice) async throws {
        do {
            try await coordinator.connect(browser: browser)
        } catch MacBrowserBridgeCoordinator.Failure.noActiveAccounts {
            // Not an error: Settings shows the empty roster and the coordinator's periodic refresh
            // connects an account once the member enables browser sync for it.
        }
    }

    func syncPlan() async throws -> SyncPlanOutput {
        try await coordinator.syncPlan()
    }

    func syncNow(
        browser: BrowserChoice, accountID: String?, backfill: BrowserBridgeBackfillRange?
    ) async throws -> [StartSyncOutput] {
        try await coordinator.syncNow(browser: browser, accountID: accountID, backfill: backfill)
    }

    func disconnect() async {
        await coordinator.disconnect()
    }

    func retire() async {
        await coordinator.retire()
    }

    func raiseAuthenticationWindow(for accountID: String) {
        coordinator.raiseAuthenticationWindow(for: accountID)
    }

    func appDidBecomeActive() {
        for (accountID, status) in statuses where status == .connected {
            Task { [notifier] in await notifier.notifyDelayedOfflineIfNeeded(accountID: accountID) }
        }
        Task { [coordinator] in
            do {
                try await coordinator.refreshRoster()
            } catch {
                Diagnostics.report(error, context: "purchaseImport.browser.refreshRoster")
            }
        }
    }

    func project(_ event: MacBrowserBridgeEvent) {
        // Rebinding precedes asynchronous retirement; queued old-host events must not restore activity.
        guard settings?.isInstalled(self) == true else { return }
        switch event {
        case .accounts(let accounts):
            let listed = Set(accounts.map(\.id))
            statuses = statuses.filter { listed.contains($0.key) }
            settings?.setAccounts(accounts)
        case .fleetStatus(let status, let connected, let total):
            settings?.setAccountCounts(connected: connected, total: total)
            settings?.setStatus(status)
        case .accountStatus(let accountID, let status):
            statuses[accountID] = status
            settings?.setAccountStatus(status, accountID: accountID)
            if case .waitingToReconnect = status { notifier.noteOffline(accountID: accountID) }
            if status == .connected {
                Task { [notifier] in await notifier.notifyDelayedOfflineIfNeeded(accountID: accountID) }
            }
        case .executingRuns(let accountID, let runIDs):
            settings?.setExecutingRuns(runIDs, accountID: accountID)
        case .result(let accountID, let result, let operation):
            settings?.setLastCommand(
                BrowserBridgeCommandSummary.line(operation: operation, outcome: result.outcome),
                runID: result.runID, accountID: accountID)
            switch result.outcome {
            case .completed(let completion):
                settings?.setAccountError(nil, accountID: accountID)
                if let snapshot = completion.snapshot {
                    var resolved = ["browser_permission_denied", "javascript_disabled"]
                    if !snapshot.authenticationRequired { resolved.append("sign_in") }
                    if completion.observation.screenRecording == .granted {
                        resolved.append("screen_recording_denied")
                    }
                    for reason in resolved {
                        notifier.resolveAttentionEdge(
                            accountID: accountID, runID: result.runID, reason: reason)
                    }
                }
            case .failed(let failure):
                settings?.setAccountError(failure.message, accountID: accountID)
                let attention: (reason: String, body: String)?
                if failure.screenshotGap == .screenRecordingDenied {
                    attention = (
                        "screen_recording_denied",
                        "Allow Cubby in System Settings > Privacy & Security > Screen & System Audio Recording."
                    )
                } else if failure.code == .browserPermissionDenied {
                    attention = (
                        "browser_permission_denied",
                        "Allow Cubby to control this browser in System Settings > Privacy & Security > Automation."
                    )
                } else if failure.code == .javascriptDisabled {
                    attention = (
                        "javascript_disabled",
                        "In Chrome, enable View > Developer > Allow JavaScript from Apple Events."
                    )
                } else {
                    attention = nil
                }
                if let attention {
                    notifyAttention(
                        accountID: accountID, runID: result.runID, reason: attention.reason,
                        body: "\(attention.body)\n\(failure.message)", raiseWindow: true)
                }
            }
        case .authenticationRequired(let accountID, let runID):
            settings?.requireAuthentication(
                accountID: accountID, message: "Finish signing in for run \(runID) in Cubby's browser window."
            )
            notifyAttention(
                accountID: accountID, runID: runID, reason: "sign_in",
                body: "Finish signing in in Cubby's owned browser window, then resume the Run.",
                raiseWindow: false)
        case .runCompleted(let accountID, let completion):
            settings?.markRunCompleted(accountID: accountID, runID: completion.runID)
            Task { [notifier] in await notifier.notifyRunCompleted(completion) }
        }
    }

    private func notifyAttention(
        accountID: String, runID: String, reason: String, body: String, raiseWindow: Bool
    ) {
        let label = settings?.accountStates.first { $0.id == accountID }?.label ?? "Browser research"
        Task { [weak self, notifier] in
            let fresh = await notifier.notifyMemberAttention(
                accountID: accountID, runID: runID,
                reason: reason, title: "\(label) needs your attention", body: body)
            guard fresh, raiseWindow, let self, settings?.isInstalled(self) == true else { return }
            coordinator.raiseAuthenticationWindow(for: accountID)
        }
    }

    private static func executionTarget(browser: BrowserChoice, baseURL: URL) throws
        -> MacBrowserExecutionTarget
    {
        #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            if let index = arguments.firstIndex(of: "--cubby-e2e-browser-bundle") {
                guard arguments.indices.contains(index + 1),
                    let serverIndex = arguments.firstIndex(of: "--cubby-e2e-server"),
                    arguments.indices.contains(serverIndex + 1),
                    URL(string: arguments[serverIndex + 1]) == baseURL,
                    Bundle.main.bundleIdentifier == "com.nickysemenza.cubby.e2e"
                        || Bundle.main.bundleIdentifier?.hasPrefix("com.nickysemenza.cubby.e2e.") == true
                else { throw MacBrowserExecutionTarget.Failure.invalidFixtureConfiguration }
                let bundleIdentifier = arguments[index + 1]
                let applications = NSRunningApplication.runningApplications(
                    withBundleIdentifier: bundleIdentifier)
                guard applications.count == 1, let application = applications.first,
                    let applicationURL = application.bundleURL
                else { throw MacBrowserExecutionTarget.Failure.ownershipChanged }
                return try .fixtureChrome(
                    baseURL: baseURL, bundleIdentifier: bundleIdentifier, applicationURL: applicationURL,
                    processID: application.processIdentifier,
                    teamID: MacBrowserExecutionTarget.signingTeam(of: Bundle.main.bundleURL))
            }
        #endif
        return .installed(browser)
    }
}
