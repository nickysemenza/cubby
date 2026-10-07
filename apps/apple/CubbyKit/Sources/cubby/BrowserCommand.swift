#if os(macOS)
    import ArgumentParser
    import CubbyKit
    import Foundation

    /// Real macOS browser control: it requires an unlocked GUI session and the CLI's own Automation permission.
    struct BrowserCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "browser",
            abstract: "Connect the browser bridge or capture through the shared macOS executor.",
            discussion:
                "Connect/resume reuse the explicit device identity and replay directory. Lifecycle events and results are JSON lines. This command does not grant macOS permissions."
        )

        enum Action: String, ExpressibleByArgument { case connect, sync, resume, capture, execute }
        enum Screenshot: String, ExpressibleByArgument {
            case required, preferred, skip
            var value: BrowserScreenshotPolicy.Mode {
                switch self {
                case .required: .required
                case .preferred: .preferred
                case .skip: .skip
                }
            }
        }
        enum Choice: String, ExpressibleByArgument {
            case chrome, safari
            var value: BrowserChoice { self == .chrome ? .chrome : .safari }
        }

        @OptionGroup var global: GlobalOptions
        @Argument(help: "connect, sync/resume, capture, or execute a typed command file.") var action: Action
        @Option(help: "Installed browser to control.") var browser: Choice = .chrome
        @Option(
            name: .customLong("vendor-account"),
            help: "Limit the bridge roster or name the capture executor's account.") var accountID: String?
        @Option(
            name: .customLong("state-directory"),
            help: "Explicit CLI-only replay directory, separate from the app and other active CLI sessions.")
        var stateDirectory: String?
        @Option(
            name: .customLong("device-id"), help: "Stable UUID for this replay directory; reuse it on resume."
        ) var deviceIDString: String?
        @Option(help: "Maximum bridge lifetime in seconds (1–600).") var duration: Int = 60
        @Option(help: "Capture screenshot mode: required, preferred, or skip.") var screenshot: Screenshot =
            .preferred
        @Option(help: "HTTPS page to capture in a newly owned window.") var url: String?
        @Option(name: .customLong("allowed-host"), help: "Explicit allowed source host. Repeatable.")
        var allowedHosts: [String] = []
        @Option(name: .customLong("run-id"), help: "Existing Run that owns captured evidence.") var runID:
            String?
        @Option(name: .customLong("target-id"), help: "Existing Run target that owns captured evidence.")
        var targetID: String?
        @Option(name: .customLong("command-file"), help: "Typed BrowserBridgeRequest JSON to execute.")
        var commandFile: String?
        @Option(name: .customLong("browser-bundle"), help: "DEBUG-only isolated fixture browser bundle id.")
        var fixtureBundle: String?
        @Option(name: .customLong("browser-app-path"), help: "Exact signed fixture .app path.")
        var fixtureAppPath: String?
        @Option(name: .customLong("browser-pid"), help: "Exact running fixture browser process id.")
        var fixturePID: Int32?
        @Option(
            name: .customLong("browser-team-id"),
            help: "Expected public Apple signing team id for the fixture browser.") var fixtureTeamID: String?
        @Flag(
            name: .customLong("fixture-login"),
            help: "DEBUG-only loopback synthetic login using in-memory credentials.") var fixtureLogin = false

        @MainActor
        func run() async throws {
            try await CLI.run {
                guard (1...600).contains(duration) else {
                    throw CLIError.message("--duration must be 1–600 seconds.")
                }
                let baseURL = try global.resolvedBaseURL
                let target = try executionTarget(baseURL: baseURL)
                let context: CLIContext
                if fixtureLogin {
                    #if DEBUG
                        guard fixtureBundle != nil else {
                            throw CLIError.message(
                                "--fixture-login requires the signed isolated browser target.")
                        }
                        let credentials = CredentialProvider(
                            host: CubbyBaseURL.host(of: baseURL), store: InMemorySessionTokenStore())
                        let identity = ClientIdentity.currentApp(product: "cubby-cli", installationID: nil)
                        _ = try await AuthFlow(baseURL: baseURL, credentials: credentials, identity: identity)
                            .signIn(email: "sim@cubby.localhost", password: "cubby-sim-local-only")
                        context = CLIContext(
                            baseURL: baseURL, host: CubbyBaseURL.host(of: baseURL), credentials: credentials,
                            identity: identity,
                            client: CubbyClient(
                                baseURL: baseURL, credentials: credentials, identity: identity),
                            json: global.json)
                    #else
                        throw CLIError.message("Fixture login requires a DEBUG build.")
                    #endif
                } else {
                    context = try CLIContext.make(from: global)
                }
                let uploader = CubbyBrowserEvidenceUploader(client: context.client)
                switch action {
                case .capture, .execute:
                    guard let accountID, !accountID.isEmpty else {
                        throw CLIError.message("Capture/execute requires --vendor-account.")
                    }
                    let executor = try MacBrowserCommandExecutor(
                        target: target, accountID: accountID, evidenceUploader: uploader)
                    let command: BrowserBridgeCommand
                    if action == .execute {
                        guard let commandFile else {
                            throw CLIError.message("Execute requires --command-file.")
                        }
                        command = try JSONDecoder.cubby().decode(
                            BrowserBridgeCommand.self,
                            from: Data(contentsOf: URL(fileURLWithPath: commandFile)))
                    } else {
                        guard let url, let sourceURL = URL(string: url), !allowedHosts.isEmpty,
                            let runID, let targetID, !runID.isEmpty, !targetID.isEmpty
                        else {
                            throw CLIError.message(
                                "Capture requires --url, --allowed-host, --run-id and --target-id.")
                        }
                        let validated = try BrowserBridgeURLPolicy.validate(
                            sourceURL, allowedHosts: Set(allowedHosts))
                        command = BrowserBridgeCommand(
                            id: UUID(), runID: runID, operationID: UUID().uuidString.lowercased(),
                            deadline: Date.now.addingTimeInterval(Double(duration)),
                            operation: .capture(
                                .init(
                                    _type: .capture, allowedHosts: allowedHosts,
                                    screenshot: screenshot.value,
                                    recoveryURL: validated.absoluteString,
                                    evidenceScope: .init(runId: runID, targetId: targetID))))
                    }
                    let outcome = await executor.execute(command)
                    try printJSON(outcome)
                    if case .failed = outcome { throw ExitCode.failure }
                case .connect, .sync, .resume:
                    guard let stateDirectory, let deviceIDString,
                        let deviceID = UUID(uuidString: deviceIDString)
                    else {
                        throw CLIError.message("Bridge commands require --state-directory and --device-id.")
                    }
                    let directory = URL(fileURLWithPath: stateDirectory, isDirectory: true)
                        .standardizedFileURL
                    var completed: [String: BrowserBridgeRunCompletion] = [:]
                    let coordinator = MacBrowserBridgeCoordinator(
                        baseURL: baseURL, credentials: context.credentials, deviceID: deviceID,
                        accountClient: SelectedAccounts(
                            client: URLSessionBrowserBridgeVendorAccountClient(
                                baseURL: baseURL, credentials: context.credentials), accountID: accountID),
                        syncClient: BrowserBridgeSyncClient(client: context.client),
                        executorFactory: { _, accountID in
                            try MacBrowserCommandExecutor(
                                target: target, accountID: accountID, evidenceUploader: uploader)
                        },
                        replayStoreFactory: { accountID in
                            let accountPath = Data(accountID.utf8).base64EncodedString().replacingOccurrences(
                                of: "/", with: "_")
                            return FileBrowserBridgeReplayStore(
                                fileURL: directory.appending(path: accountPath).appending(path: "replay.json")
                            )
                        },
                        observer: { event in
                            do {
                                try printEvent(event)
                                if case .runCompleted(_, let completion) = event {
                                    completed[completion.runID] = completion
                                }
                            } catch { CLI.printError(error.localizedDescription) }
                        })
                    do {
                        let requests: [StartSyncOutput]
                        if action == .connect {
                            try await coordinator.connect(browser: target.browser)
                            requests = []
                        } else {
                            requests = try await coordinator.syncNow(
                                browser: target.browser, accountID: accountID)
                            for request in requests { try printJSON(request) }
                        }
                        let deadline = Date.now.addingTimeInterval(Double(duration))
                        while Date.now < deadline {
                            try await Task.sleep(for: .milliseconds(100))
                            if !requests.isEmpty, requests.allSatisfy({ completed[$0.runId] != nil }) {
                                break
                            }
                        }
                        let status = coordinator.currentStatus
                        await coordinator.disconnect()
                        if !requests.isEmpty {
                            guard requests.allSatisfy({ completed[$0.runId]?.isSuccessful == true }) else {
                                throw CLIError.message(
                                    "Requested browser runs did not all complete successfully within the bound; inspect the emitted review/authentication outcomes."
                                )
                            }
                        } else if status != .connected {
                            throw CLIError.message(
                                "No browser bridge remained connected within the requested bound.")
                        }
                    } catch {
                        await coordinator.disconnect()
                        throw error
                    }
                }
            }
        }

        @MainActor
        private func executionTarget(baseURL: URL) throws -> MacBrowserExecutionTarget {
            let provided = [
                fixtureBundle != nil, fixtureAppPath != nil, fixturePID != nil, fixtureTeamID != nil,
            ]
            guard provided.contains(true) else { return .installed(browser.value) }
            guard let fixtureBundle, let fixtureAppPath, let fixturePID, let fixtureTeamID else {
                throw CLIError.message(
                    "The isolated browser requires all four --browser-bundle/app-path/pid/team-id options.")
            }
            return try .fixtureChrome(
                baseURL: baseURL, bundleIdentifier: fixtureBundle,
                applicationURL: URL(fileURLWithPath: fixtureAppPath),
                processID: fixturePID, teamID: fixtureTeamID)
        }

        private func printJSON(_ value: some Encodable) throws {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            print(String(decoding: try encoder.encode(value), as: UTF8.self))
        }

        private func printEvent(_ event: MacBrowserBridgeEvent) throws {
            switch event {
            case .accounts(let accounts): try printJSON(accounts)
            case .result(_, let result, _): try printJSON(result)
            case .runCompleted(_, let completion): try printJSON(completion)
            case .fleetStatus(let status, let connected, let total):
                try printJSON(
                    JSONValue.object([
                        "event": "fleet_status", "status": .string(statusLabel(status)),
                        "connected": .number(Double(connected)), "total": .number(Double(total)),
                    ]))
            case .accountStatus(let accountID, let status):
                try printJSON(
                    JSONValue.object([
                        "event": "account_status", "accountId": .string(accountID),
                        "status": .string(statusLabel(status)),
                    ]))
            case .authenticationRequired(let accountID, let runID):
                try printJSON(
                    JSONValue.object([
                        "event": "authentication_required", "accountId": .string(accountID),
                        "runId": .string(runID),
                    ]))
            }
        }

        private func statusLabel(_ status: BrowserBridgeConnectionStatus) -> String {
            switch status {
            case .disconnected: "disconnected"
            case .connecting: "connecting"
            case .connected: "connected"
            case .waitingToReconnect(let attempt): "waiting_to_reconnect:\(attempt)"
            case .failed(let message): "failed:\(message)"
            }
        }

        private struct SelectedAccounts: BrowserBridgeVendorAccountListing {
            let client: any BrowserBridgeVendorAccountListing
            let accountID: String?
            func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount] {
                let accounts = try await client.browserBridgeVendorAccounts()
                guard let accountID else { return accounts }
                return accounts.filter { $0.id == accountID }
            }
        }
    }
#endif
