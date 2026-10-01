#if os(macOS)
    import Foundation

    public enum MacBrowserBridgeEvent: Sendable {
        case accounts([BrowserBridgeVendorAccount])
        case fleetStatus(BrowserBridgeConnectionStatus, connected: Int, total: Int)
        case accountStatus(accountID: String, status: BrowserBridgeConnectionStatus)
        case result(accountID: String, result: BrowserBridgeCommandResult)
        case authenticationRequired(accountID: String, runID: String)
        case runCompleted(accountID: String, completion: BrowserBridgeRunCompletion)
    }

    @MainActor
    public final class MacBrowserBridgeCoordinator {
        public enum Failure: LocalizedError {
            case bearerSessionRequired
            case noActiveAccounts

            public var errorDescription: String? {
                switch self {
                case .bearerSessionRequired:
                    "Sign in with your Cubby account before connecting the browser bridge."
                case .noActiveAccounts:
                    "No eligible vendor accounts are available for browser import."
                }
            }
        }

        private let baseURL: URL
        private let accountClient: any BrowserBridgeVendorAccountListing
        private let credentials: CredentialProvider
        private let syncClient: any BrowserBridgeSyncRequesting
        private let deviceID: UUID
        private let executorFactory: (BrowserChoice, String) throws -> MacBrowserCommandExecutor
        private let replayStoreFactory: (String) throws -> any BrowserBridgeReplayStoring
        private let capabilities: (Bool) -> BrowserBridgeCapabilities
        private let observer: (MacBrowserBridgeEvent) -> Void
        private var bridges: [String: URLSessionBrowserBridge] = [:]
        private var executors: [String: MacBrowserCommandExecutor] = [:]
        private var accounts: [String: BrowserBridgeVendorAccount] = [:]
        private var statuses: [String: BrowserBridgeConnectionStatus] = [:]
        private var generation = UUID()

        public init(
            baseURL: URL, credentials: CredentialProvider, deviceID: UUID,
            accountClient: any BrowserBridgeVendorAccountListing,
            syncClient: any BrowserBridgeSyncRequesting,
            executorFactory: @escaping (BrowserChoice, String) throws -> MacBrowserCommandExecutor,
            replayStoreFactory: @escaping (String) throws -> any BrowserBridgeReplayStoring,
            capabilities: @escaping (Bool) -> BrowserBridgeCapabilities,
            observer: @escaping (MacBrowserBridgeEvent) -> Void
        ) {
            self.baseURL = baseURL
            self.credentials = credentials
            self.deviceID = deviceID
            self.accountClient = accountClient
            self.syncClient = syncClient
            self.executorFactory = executorFactory
            self.replayStoreFactory = replayStoreFactory
            self.capabilities = capabilities
            self.observer = observer
        }

        public var vendorAccounts: [BrowserBridgeVendorAccount] {
            accounts.values.sorted { $0.id < $1.id }
        }

        public var currentStatus: BrowserBridgeConnectionStatus {
            BrowserBridgeFleetStatus.aggregate(statuses.values)
        }

        public func connect(browser: BrowserChoice, enhancedEvidence: Bool) async throws {
            BrowserBridgeDebugLog.emit(.connectRequested, browser: browser)
            try await replaceConnections(browser: browser, enhancedEvidence: enhancedEvidence)
        }

        public func syncNow(browser: BrowserChoice, enhancedEvidence: Bool) async throws
            -> [BrowserBridgeSyncResponse]
        {
            BrowserBridgeDebugLog.emit(.syncRequested, browser: browser)
            // Refresh the roster and browser preference first so a newly added or paused account is
            // reflected in this manual run, then enqueue one server-owned run per eligible account.
            try await replaceConnections(browser: browser, enhancedEvidence: enhancedEvidence)
            var firstFailure: (any Error)?
            var submitted: [BrowserBridgeSyncResponse] = []
            for account in accounts.values.sorted(by: { $0.id < $1.id }) {
                do {
                    submitted.append(try await syncClient.requestSync(vendorAccountID: account.id))
                } catch {
                    firstFailure = firstFailure ?? error
                }
            }
            if submitted.isEmpty, let firstFailure { throw firstFailure }
            return submitted
        }

        public func disconnect() async {
            await tearDown(reportStatus: true)
        }

        public func raiseAuthenticationWindow(for accountID: String) {
            executors[accountID]?.raiseAuthenticationWindow()
        }

        public func retire() async {
            await tearDown(reportStatus: false)
        }

        private func tearDown(reportStatus: Bool) async {
            generation = UUID()
            let current = Array(bridges.values)
            bridges = [:]
            executors = [:]
            accounts = [:]
            statuses = [:]
            if reportStatus {
                observer(.accounts([]))
                observer(.fleetStatus(.disconnected, connected: 0, total: 0))
            }
            for bridge in current { await bridge.disconnect() }
        }

        private func replaceConnections(browser: BrowserChoice, enhancedEvidence: Bool) async throws {
            let old = Array(bridges.values)
            bridges = [:]
            executors = [:]
            statuses = [:]
            for bridge in old { await bridge.disconnect() }

            guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
                throw Failure.bearerSessionRequired
            }
            let listedAccounts = try await accountClient.browserBridgeVendorAccounts()
            BrowserBridgeDebugLog.emit(.controllerRoster, browser: browser, count: listedAccounts.count)
            guard !listedAccounts.isEmpty else {
                observer(.accounts([]))
                observer(.fleetStatus(.disconnected, connected: 0, total: 0))
                throw Failure.noActiveAccounts
            }

            let generation = UUID()
            self.generation = generation
            accounts = Dictionary(uniqueKeysWithValues: listedAccounts.map { ($0.id, $0) })
            observer(.accounts(listedAccounts))
            observer(.fleetStatus(.connecting, connected: 0, total: listedAccounts.count))
            let capabilities = capabilities(enhancedEvidence)

            for account in listedAccounts {
                // There is exactly one executor for each account connection. Its owned window and
                // active tab are consequently never shared with another VendorAccount.
                let executor = try executorFactory(browser, account.id)
                let replayStore = try replayStoreFactory(account.id)
                let bridge = URLSessionBrowserBridge(
                    replayStore: replayStore, executor: executor
                ) { [weak self] status in
                    Task { @MainActor [weak self] in
                        self?.didChangeStatus(
                            status, accountID: account.id, generation: generation)
                    }
                } resultObserver: { [weak self] result in
                    Task { @MainActor [weak self] in
                        self?.didFinishResult(result, accountID: account.id, generation: generation)
                    }
                } authWindowObserver: { [weak self] runID in
                    Task { @MainActor [weak self] in
                        self?.didRequestAuthentication(
                            runID: runID, accountID: account.id, generation: generation)
                    }
                } runCompletionObserver: { [weak self] completion in
                    Task { @MainActor [weak self] in
                        self?.didCompleteRun(completion, accountID: account.id, generation: generation)
                    }
                }
                bridges[account.id] = bridge
                executors[account.id] = executor
                statuses[account.id] = .connecting
                BrowserBridgeDebugLog.emit(
                    .connectRequested, browser: browser, accountID: account.id)
                let url = try BrowserBridgeEndpoint.socketURL(
                    baseURL: baseURL, vendorAccountID: account.id)
                await bridge.connect(
                    BrowserBridgeConnectionConfiguration(
                        url: url, deviceID: deviceID, browser: browser,
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
            BrowserBridgeDebugLog.emit(
                .controllerStatus, accountID: accountID,
                messageType: Self.statusLabel(status))
            observer(.accountStatus(accountID: accountID, status: status))
            publishFleetStatus()
        }

        private func didFinishResult(
            _ result: BrowserBridgeCommandResult, accountID: String, generation: UUID
        ) {
            guard generation == self.generation, bridges[accountID] != nil else { return }
            if case .failed(let payload) = result.outcome, payload.code == .authenticationRequired {
                executors[accountID]?.raiseAuthenticationWindow()
            }
            observer(.result(accountID: accountID, result: result))
        }

        private func didRequestAuthentication(runID: String, accountID: String, generation: UUID) {
            guard generation == self.generation, bridges[accountID] != nil else { return }
            executors[accountID]?.raiseAuthenticationWindow()
            observer(.authenticationRequired(accountID: accountID, runID: runID))
        }

        private func didCompleteRun(
            _ completion: BrowserBridgeRunCompletion, accountID: String, generation: UUID
        ) {
            guard generation == self.generation, bridges[accountID] != nil else { return }
            if completion.isSuccessful {
                executors[accountID]?.minimizeOwnedWindow()
            }
            observer(.runCompleted(accountID: accountID, completion: completion))
        }

        private func publishFleetStatus() {
            let connected = statuses.values.count { $0 == .connected }
            observer(
                .fleetStatus(
                    BrowserBridgeFleetStatus.aggregate(statuses.values), connected: connected,
                    total: bridges.count))
        }

        private static func statusLabel(_ status: BrowserBridgeConnectionStatus) -> String {
            switch status {
            case .disconnected: "disconnected"
            case .connecting: "connecting"
            case .connected: "connected"
            case .waitingToReconnect(let attempt): "waiting_to_reconnect:\(attempt)"
            case .failed: "failed"
            }
        }
    }

#endif
