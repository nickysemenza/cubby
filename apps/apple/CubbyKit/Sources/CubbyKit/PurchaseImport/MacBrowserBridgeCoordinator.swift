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

        /// The browser preference of the last `connect`/`syncNow`; roster refreshes reuse it.
        private struct Connection: Equatable {
            let browser: BrowserChoice
            let enhancedEvidence: Bool
        }

        private let baseURL: URL
        private let accountClient: any BrowserBridgeVendorAccountListing
        private let credentials: CredentialProvider
        private let syncClient: any BrowserBridgeSyncRequesting
        private let deviceID: UUID
        private let executorFactory: (BrowserChoice, String) throws -> MacBrowserCommandExecutor
        private let replayStoreFactory: (String) throws -> any BrowserBridgeReplayStoring
        private let capabilities: (Bool) -> BrowserBridgeCapabilities
        private let rosterRefreshTick: @Sendable () async throws -> Void
        private let observer: (MacBrowserBridgeEvent) -> Void
        private var bridges: [String: URLSessionBrowserBridge] = [:]
        private var executors: [String: MacBrowserCommandExecutor] = [:]
        private var accounts: [String: BrowserBridgeVendorAccount] = [:]
        private var statuses: [String: BrowserBridgeConnectionStatus] = [:]
        /// One token per opened bridge: a callback from a bridge that was since closed (or replaced
        /// by a later bridge for the same account) never reaches the current projection.
        private var bridgeTokens: [String: UUID] = [:]
        /// Bumped whenever the whole fleet is replaced or torn down; a roster refresh that
        /// straddles one discards its listing.
        private var generation = UUID()
        private var connection: Connection?
        private var rosterRefreshLoop: Task<Void, Never>?
        private var rosterRefreshInFlight: Task<Void, any Error>?
        private var fleetOperation: Task<Void, Never>?
        private var teardowns = 0

        public init(
            baseURL: URL, credentials: CredentialProvider, deviceID: UUID,
            accountClient: any BrowserBridgeVendorAccountListing,
            syncClient: any BrowserBridgeSyncRequesting,
            executorFactory: @escaping (BrowserChoice, String) throws -> MacBrowserCommandExecutor,
            replayStoreFactory: @escaping (String) throws -> any BrowserBridgeReplayStoring,
            capabilities: @escaping (Bool) -> BrowserBridgeCapabilities,
            rosterRefreshTick: @escaping @Sendable () async throws -> Void = {
                try await Task.sleep(for: .seconds(600))
            },
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
            self.rosterRefreshTick = rosterRefreshTick
            self.observer = observer
        }

        public var vendorAccounts: [BrowserBridgeVendorAccount] {
            accounts.values.sorted { $0.id < $1.id }
        }

        public var currentStatus: BrowserBridgeConnectionStatus {
            BrowserBridgeFleetStatus.aggregate(statuses.values)
        }

        /// Throws `noActiveAccounts` when nothing is listed, but stays configured: the periodic
        /// roster refresh connects an account the member enables for browser sync later.
        public func connect(browser: BrowserChoice, enhancedEvidence: Bool) async throws {
            BrowserBridgeDebugLog.emit(.connectRequested, browser: browser)
            try await serialized {
                try await self.replaceConnections(browser: browser, enhancedEvidence: enhancedEvidence)
            }
        }

        public func syncNow(
            browser: BrowserChoice, enhancedEvidence: Bool,
            backfill: BrowserBridgeBackfillRange? = nil
        ) async throws -> [BrowserBridgeSyncResponse] {
            BrowserBridgeDebugLog.emit(.syncRequested, browser: browser)
            // Refresh the roster and browser preference first so a newly added or paused account is
            // reflected in this manual run, then enqueue one server-owned run per eligible account.
            try await serialized {
                try await self.replaceConnections(browser: browser, enhancedEvidence: enhancedEvidence)
            }
            var failures: [String] = []
            var submitted: [BrowserBridgeSyncResponse] = []
            for account in accounts.values.sorted(by: { $0.id < $1.id }) {
                do {
                    submitted.append(
                        try await syncClient.requestSync(vendorAccountID: account.id, backfill: backfill))
                } catch {
                    failures.append("\(account.id): \(error.localizedDescription)")
                }
            }
            if !failures.isEmpty {
                throw SyncFailure(
                    message: "Browser Sync submitted \(submitted.count) requests; failed accounts: "
                        + failures.joined(separator: "; "))
            }
            return submitted
        }

        /// Re-lists browser-sync accounts and reconciles incrementally: a newly listed account gets
        /// a bridge, an unlisted one loses its bridge, and every other bridge keeps its socket.
        /// A no-op until `connect` or `syncNow` has configured the fleet; concurrent calls share
        /// one listing, and a refresh queued behind a disconnect does nothing.
        public func refreshRoster() async throws {
            if let rosterRefreshInFlight { return try await rosterRefreshInFlight.value }
            let refresh = Task { try await serialized { try await self.reconcileRoster() } }
            rosterRefreshInFlight = refresh
            defer { rosterRefreshInFlight = nil }
            do {
                try await refresh.value
            } catch is CancellationError {}
        }

        /// Full replacements and roster reconciliations run one at a time in call order: two that
        /// overlap would each list the roster and open a bridge for the same account. An
        /// operation still queued when the fleet is torn down is dropped, so a disconnect is
        /// never undone by work requested before it.
        private func serialized(
            _ operation: @escaping @MainActor @Sendable () async throws -> Void
        ) async throws {
            let previous = fleetOperation
            let teardowns = self.teardowns
            let current = Task {
                await previous?.value
                guard teardowns == self.teardowns else { throw CancellationError() }
                try await operation()
            }
            fleetOperation = Task { _ = try? await current.value }
            try await current.value
        }

        private struct SyncFailure: LocalizedError {
            let message: String
            var errorDescription: String? { message }
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
            teardowns += 1
            generation = UUID()
            connection = nil
            rosterRefreshLoop?.cancel()
            rosterRefreshLoop = nil
            let current = Array(bridges.values)
            bridges = [:]
            executors = [:]
            accounts = [:]
            statuses = [:]
            bridgeTokens = [:]
            if reportStatus {
                observer(.accounts([]))
                observer(.fleetStatus(.disconnected, connected: 0, total: 0))
            }
            for bridge in current { await bridge.disconnect() }
        }

        private func replaceConnections(browser: BrowserChoice, enhancedEvidence: Bool) async throws {
            generation = UUID()
            let generation = self.generation
            let old = Array(bridges.values)
            bridges = [:]
            executors = [:]
            statuses = [:]
            bridgeTokens = [:]
            for bridge in old { await bridge.disconnect() }

            guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
                throw Failure.bearerSessionRequired
            }
            guard generation == self.generation else { return }
            let connection = Connection(browser: browser, enhancedEvidence: enhancedEvidence)
            self.connection = connection
            startRosterRefreshLoop()
            let listedAccounts = try await accountClient.browserBridgeVendorAccounts()
            guard generation == self.generation else { return }
            BrowserBridgeDebugLog.emit(.controllerRoster, browser: browser, count: listedAccounts.count)
            accounts = Dictionary(uniqueKeysWithValues: listedAccounts.map { ($0.id, $0) })
            guard !listedAccounts.isEmpty else {
                observer(.accounts([]))
                observer(.fleetStatus(.disconnected, connected: 0, total: 0))
                throw Failure.noActiveAccounts
            }

            observer(.accounts(listedAccounts))
            observer(.fleetStatus(.connecting, connected: 0, total: listedAccounts.count))
            for account in listedAccounts {
                try await openBridge(for: account, connection: connection)
                guard generation == self.generation else { return }
            }
            publishFleetStatus()
        }

        private func reconcileRoster() async throws {
            guard let connection else { return }
            let generation = self.generation
            guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
                throw Failure.bearerSessionRequired
            }
            let listedAccounts = try await accountClient.browserBridgeVendorAccounts()
            // A connect, disconnect or retire while listing owns the fleet now.
            guard generation == self.generation, connection == self.connection else { return }
            BrowserBridgeDebugLog.emit(
                .controllerRoster, browser: connection.browser, count: listedAccounts.count)

            let listed = Dictionary(uniqueKeysWithValues: listedAccounts.map { ($0.id, $0) })
            let removed = bridges.filter { listed[$0.key] == nil }
            for accountID in removed.keys {
                bridges[accountID] = nil
                executors[accountID] = nil
                statuses[accountID] = nil
                bridgeTokens[accountID] = nil
            }
            let rosterChanged = listed != accounts
            accounts = listed
            if rosterChanged { observer(.accounts(vendorAccounts)) }
            for bridge in removed.values { await bridge.disconnect() }
            for account in vendorAccounts where bridges[account.id] == nil {
                guard generation == self.generation else { return }
                try await openBridge(for: account, connection: connection)
            }
            guard generation == self.generation else { return }
            publishFleetStatus()
        }

        private func openBridge(
            for account: BrowserBridgeVendorAccount, connection: Connection
        ) async throws {
            // There is exactly one executor for each account connection. Its owned window and
            // active tab are consequently never shared with another VendorAccount.
            let executor = try executorFactory(connection.browser, account.id)
            let replayStore = try replayStoreFactory(account.id)
            let url = try AuthenticatedSocketSupport.socketURL(
                baseURL: baseURL, path: "/api/import/agent/socket",
                queryItems: [URLQueryItem(name: "vendorAccount", value: account.id)])
            let token = UUID()
            let bridge = URLSessionBrowserBridge(
                replayStore: replayStore, executor: executor
            ) { [weak self] status in
                Task { @MainActor [weak self] in
                    self?.didChangeStatus(status, accountID: account.id, token: token)
                }
            } resultObserver: { [weak self] result in
                Task { @MainActor [weak self] in
                    self?.didFinishResult(result, accountID: account.id, token: token)
                }
            } authWindowObserver: { [weak self] runID in
                Task { @MainActor [weak self] in
                    self?.didRequestAuthentication(runID: runID, accountID: account.id, token: token)
                }
            } runCompletionObserver: { [weak self] completion in
                Task { @MainActor [weak self] in
                    self?.didCompleteRun(completion, accountID: account.id, token: token)
                }
            }
            // Opening is idempotent: a bridge this replaces is closed, never left running unowned.
            let replaced = bridges[account.id]
            bridges[account.id] = bridge
            executors[account.id] = executor
            statuses[account.id] = .connecting
            bridgeTokens[account.id] = token
            if let replaced { await replaced.disconnect() }
            BrowserBridgeDebugLog.emit(
                .connectRequested, browser: connection.browser, accountID: account.id)
            await bridge.connect(
                BrowserBridgeConnectionConfiguration(
                    url: url, deviceID: deviceID, browser: connection.browser,
                    capabilities: capabilities(connection.enhancedEvidence)
                ) { [credentials] in
                    guard case .bearer(let token) = await credentials.current() else { return nil }
                    return token
                })
            // Torn down or replaced while the socket was opening: never leave it running unowned.
            if bridgeTokens[account.id] != token { await bridge.disconnect() }
        }

        private func startRosterRefreshLoop() {
            guard rosterRefreshLoop == nil else { return }
            rosterRefreshLoop = Task { [weak self, rosterRefreshTick] in
                while true {
                    do { try await rosterRefreshTick() } catch { return }
                    guard let self else { return }
                    // A failed listing (offline, signed out) is retried on the next tick.
                    try? await self.refreshRoster()
                }
            }
        }

        private func didChangeStatus(
            _ status: BrowserBridgeConnectionStatus, accountID: String, token: UUID
        ) {
            guard bridgeTokens[accountID] == token else { return }
            statuses[accountID] = status
            BrowserBridgeDebugLog.emit(
                .controllerStatus, accountID: accountID,
                messageType: Self.statusLabel(status))
            observer(.accountStatus(accountID: accountID, status: status))
            publishFleetStatus()
        }

        private func didFinishResult(
            _ result: BrowserBridgeCommandResult, accountID: String, token: UUID
        ) {
            guard bridgeTokens[accountID] == token else { return }
            if case .failed(let payload) = result.outcome, payload.code == .authenticationRequired {
                executors[accountID]?.raiseAuthenticationWindow()
            }
            observer(.result(accountID: accountID, result: result))
        }

        private func didRequestAuthentication(runID: String, accountID: String, token: UUID) {
            guard bridgeTokens[accountID] == token else { return }
            executors[accountID]?.raiseAuthenticationWindow()
            observer(.authenticationRequired(accountID: accountID, runID: runID))
        }

        private func didCompleteRun(
            _ completion: BrowserBridgeRunCompletion, accountID: String, token: UUID
        ) {
            guard bridgeTokens[accountID] == token else { return }
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
