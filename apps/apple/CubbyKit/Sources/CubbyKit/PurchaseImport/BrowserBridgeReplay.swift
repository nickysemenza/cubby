import Foundation

public struct BrowserBridgeReplayLedger: Codable, Equatable, Sendable {
    public private(set) var completed: [String: BrowserBridgeCommandResult]
    public private(set) var cancelled: Set<String>
    /// Completion acknowledgements are durable too. The server may close after persisting a
    /// completion but before it observes the acknowledgement; replaying this idempotent ack is
    /// safer than notifying the person twice or starting a successor run.
    public private(set) var completedRuns: [String: BrowserBridgeRunCompletion]
    /// Identity-only uncertain results are durable before an interactive side effect begins.
    /// The ledger never stores the action's typed text or other form input.
    public private(set) var startedActions: [String: BrowserBridgeCommandResult]
    /// Identity-only fences and acknowledgements survive reconnects and cold launches.
    public private(set) var retiredRuns: [String: Set<String>]

    public init(
        completed: [String: BrowserBridgeCommandResult] = [:], cancelled: Set<String> = [],
        completedRuns: [String: BrowserBridgeRunCompletion] = [:],
        startedActions: [String: BrowserBridgeCommandResult] = [:],
        retiredRuns: [String: Set<String>] = [:]
    ) {
        self.completed = completed
        self.cancelled = cancelled
        self.completedRuns = completedRuns
        self.startedActions = startedActions
        self.retiredRuns = retiredRuns
    }

    private enum CodingKeys: String, CodingKey {
        case completed, cancelled, completedRuns, startedActions, retiredRuns
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            completed: try values.decodeIfPresent(
                [String: BrowserBridgeCommandResult].self, forKey: .completed) ?? [:],
            cancelled: try values.decodeIfPresent(Set<String>.self, forKey: .cancelled) ?? [],
            completedRuns: try values.decodeIfPresent(
                [String: BrowserBridgeRunCompletion].self, forKey: .completedRuns) ?? [:],
            startedActions: try values.decodeIfPresent(
                [String: BrowserBridgeCommandResult].self, forKey: .startedActions) ?? [:],
            retiredRuns: try values.decodeIfPresent(
                [String: Set<String>].self, forKey: .retiredRuns) ?? [:])
    }

    public mutating func forget(runID: String, retirementID: String) {
        retiredRuns[runID, default: []].insert(retirementID)
        completed = completed.filter { $0.value.runID != runID }
        startedActions = startedActions.filter { $0.value.runID != runID }
        completedRuns.removeValue(forKey: runID)
    }

    public mutating func record(_ result: BrowserBridgeCommandResult) {
        guard retiredRuns[result.runID] == nil, !cancelled.contains(result.commandID),
            completed[result.commandID] == nil
        else { return }
        startedActions.removeValue(forKey: result.commandID)
        completed[result.commandID] = result
    }

    public mutating func beginInteractive(_ command: BrowserBridgeCommand) {
        guard retiredRuns[command.runID] == nil, startedActions[command.id] == nil,
            completed[command.id] == nil,
            !cancelled.contains(command.id)
        else { return }
        startedActions[command.id] = BrowserBridgeCommandResult(
            commandID: command.id, runID: command.runID, operationID: command.operationID,
            completedAt: .now,
            outcome: .failed(
                code: .actionOutcomeUnknown,
                message:
                    "The browser action started without a durable completion. Read and reconcile the page before acting again.",
                retryable: false, observation: .unobserved))
    }

    public func interruptedResult(for commandID: String) -> BrowserBridgeCommandResult? {
        startedActions[commandID]
    }

    /// Only after relaunch: a live command keeps executing through transient socket disconnects.
    public mutating func recoverInterruptedActions() {
        for result in startedActions.values { record(result) }
    }

    public mutating func acknowledge(_ commandID: String) {
        completed.removeValue(forKey: commandID)
        cancelled.remove(commandID)
        startedActions.removeValue(forKey: commandID)
    }

    public mutating func cancel(_ commandID: String) {
        completed.removeValue(forKey: commandID)
        cancelled.insert(commandID)
        startedActions.removeValue(forKey: commandID)
    }

    public func replayResult(for commandID: String) -> BrowserBridgeCommandResult? {
        completed[commandID]
    }

    /// Returns whether this Mac has not seen the terminal run event before. The caller can use
    /// that edge to create a local notification exactly once while acknowledgements continue to
    /// replay across reconnects.
    public mutating func recordRunCompletion(_ completion: BrowserBridgeRunCompletion) -> Bool {
        guard retiredRuns[completion.runID] == nil else { return false }
        let isNew = completedRuns[completion.runID] == nil
        completedRuns[completion.runID] = completion
        return isNew
    }

    public var resultsForReplay: [BrowserBridgeCommandResult] {
        completed.values.sorted {
            if $0.completedAt != $1.completedAt { return $0.completedAt < $1.completedAt }
            return $0.commandID < $1.commandID
        }
    }

    public var runCompletionsForAcknowledgement: [BrowserBridgeRunCompletion] {
        completedRuns.values.sorted { $0.runID < $1.runID }
    }

    /// Every reconnect repeats erasure before persisting the fence used to acknowledge disposal.
    func prepareForReplay(
        store: any BrowserBridgeReplayStoring, executor: any BrowserCommandExecuting
    ) async throws {
        for runID in retiredRuns.keys.sorted() {
            try await executor.forget(runID: runID)
        }
        try await store.save(self)
    }
}

public protocol BrowserBridgeReplayStoring: Sendable {
    func load() async throws -> BrowserBridgeReplayLedger
    func save(_ ledger: BrowserBridgeReplayLedger) async throws
}

public actor FileBrowserBridgeReplayStore: BrowserBridgeReplayStoring {
    private let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public static func applicationSupport(namespace: String = "default") throws
        -> FileBrowserBridgeReplayStore
    {
        let fileURL = try AtomicCodableReplayFile.applicationSupportURL(
            directory: "BrowserBridge", namespace: namespace, fileName: "replay.json")
        return FileBrowserBridgeReplayStore(fileURL: fileURL)
    }

    public func load() throws -> BrowserBridgeReplayLedger {
        var ledger =
            try AtomicCodableReplayFile.load(
                BrowserBridgeReplayLedger.self, from: fileURL, decoder: .browserBridge)
            ?? BrowserBridgeReplayLedger()
        ledger.recoverInterruptedActions()
        return ledger
    }

    public func save(_ ledger: BrowserBridgeReplayLedger) throws {
        try AtomicCodableReplayFile.save(ledger, to: fileURL, encoder: .browserBridge)
    }
}

extension JSONEncoder {
    static var browserBridge: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var browserBridge: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
