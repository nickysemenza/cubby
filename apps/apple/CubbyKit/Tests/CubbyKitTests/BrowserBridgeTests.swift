import Foundation
import Testing

@testable import CubbyKit

@Suite("Purchase import browser bridge")
struct BrowserBridgeTests {
    @Test("Every safe operation has a stable versioned round trip", arguments: operations)
    func protocolRoundTrip(operation: BrowserBridgeOperation) throws {
        let command = BrowserBridgeCommand(
            id: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!, runID: "RUN-EXAMPLE",
            operationID: "operation-example", deadline: Date(timeIntervalSince1970: 1_800_000_000),
            operation: operation)
        let message = BrowserBridgeServerMessage.command(command)

        let encoded = try JSONEncoder.browserBridge.encode(message)
        let decoded = try JSONDecoder.browserBridge.decode(
            BrowserBridgeServerMessage.self, from: encoded)

        #expect(decoded == message)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["protocolVersion"] as? Int == BrowserBridgeProtocol.currentProtocolVersion)
    }

    @Test("A future protocol version is rejected")
    func futureProtocolVersion() throws {
        let data = Data(
            #"{"protocolVersion":999,"type":"ping","timestamp":"2027-01-15T00:00:00Z"}"#.utf8)
        #expect(throws: DecodingError.self) {
            try JSONDecoder.browserBridge.decode(BrowserBridgeServerMessage.self, from: data)
        }
    }

    @Test(
        "Allowlist accepts HTTPS host boundaries",
        arguments: [
            "https://orders.example.com/order/1", "https://example.com/order/1",
        ])
    func acceptedURLs(rawURL: String) throws {
        let url = try #require(URL(string: rawURL))
        #expect(try BrowserBridgeURLPolicy.validate(url, allowedHosts: ["example.com"]) == url)
    }

    @Test(
        "Allowlist rejects scheme, credential, sibling, and fragment escapes",
        arguments: [
            "http://example.com/order/1", "https://user@example.com/order/1",
            "https://notexample.com/order/1", "https://example.com/order/1#javascript:alert(1)",
        ])
    func rejectedURLs(rawURL: String) throws {
        let url = try #require(URL(string: rawURL))
        #expect(throws: BrowserBridgeURLPolicy.Failure.self) {
            try BrowserBridgeURLPolicy.validate(url, allowedHosts: ["example.com"])
        }
    }

    @Test("Completed results replay until acknowledged")
    func replayLifecycle() {
        let id = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        let result = BrowserBridgeCommandResult(
            commandID: id, runID: "RUN-EXAMPLE", operationID: "operation-example",
            completedAt: Date(timeIntervalSince1970: 100), outcome: .completed(capture: nil))
        var ledger = BrowserBridgeReplayLedger()

        ledger.record(result)
        #expect(ledger.replayResult(for: id) == result)
        #expect(ledger.resultsForReplay == [result])

        ledger.acknowledge(id)
        #expect(ledger.replayResult(for: id) == nil)
        #expect(ledger.resultsForReplay.isEmpty)
    }

    @Test("Socket loss or a duplicate dispatch does not restart a browser side effect")
    func transientDisconnectKeepsInFlightCommand() {
        let id = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        var tasks = BrowserBridgeCommandTaskRegistry()

        let firstStart = tasks.claim(id)
        #expect(firstStart)
        tasks.attach(Task {}, to: id)
        tasks.transientDisconnect()
        let replayStart = tasks.claim(id)
        #expect(!replayStart)

        tasks.finish(id)
        let acknowledgedReplayStart = tasks.claim(id)
        #expect(!acknowledgedReplayStart)

        tasks.cancelAll()
    }

    @Test("Cancellation prevents a late command result from entering replay")
    func cancellationWinsRace() {
        let id = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        var ledger = BrowserBridgeReplayLedger()
        ledger.cancel(id)
        ledger.record(
            BrowserBridgeCommandResult(
                commandID: id, runID: "RUN-EXAMPLE", operationID: "operation-example",
                completedAt: .now, outcome: .completed(capture: nil)))

        #expect(ledger.cancelled.contains(id))
        #expect(ledger.replayResult(for: id) == nil)
    }

    @Test("A stale replay result can be discarded before a protocol rejection replaces it")
    func staleReplayResultIsFenced() {
        let id = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        let cached = BrowserBridgeCommandResult(
            commandID: id, runID: "RUN-OLD", operationID: "operation-old", completedAt: .now,
            outcome: .completed(capture: nil))
        var ledger = BrowserBridgeReplayLedger()

        ledger.record(cached)
        ledger.discardReplayResult(for: id)
        #expect(ledger.replayResult(for: id) == nil)
        #expect(!ledger.cancelled.contains(id))
    }

    @Test("Socket URLs upgrade HTTPS and preserve only the account query")
    func socketEndpoint() throws {
        let production = try BrowserBridgeEndpoint.socketURL(
            baseURL: try #require(URL(string: "https://cubby.example/custom?old=value#fragment")),
            vendorAccountID: "VACCT-4K7M")
        #expect(
            production.absoluteString
                == "wss://cubby.example/api/import/agent/socket?vendorAccount=VACCT-4K7M")

        let local = try BrowserBridgeEndpoint.socketURL(
            baseURL: try #require(URL(string: "http://localhost:3000")),
            vendorAccountID: "VACCT-4K7M")
        #expect(local.scheme == "ws")
        #expect(local.port == 3000)
    }

    @Test("Socket URLs reject cleartext remote servers")
    func socketEndpointSecurity() throws {
        let url = try #require(URL(string: "http://cubby.example"))
        #expect(throws: BrowserBridgeEndpoint.Failure.insecureRemoteServer) {
            try BrowserBridgeEndpoint.socketURL(baseURL: url, vendorAccountID: "VACCT-4K7M")
        }
    }

    @Test("Fleet status remains useful while account sockets reconnect independently")
    func fleetStatus() {
        #expect(
            BrowserBridgeFleetStatus.aggregate([
                .connected, .waitingToReconnect(attempt: 2),
            ]) == .connected)
        #expect(
            BrowserBridgeFleetStatus.aggregate([
                .waitingToReconnect(attempt: 2), .waitingToReconnect(attempt: 4),
            ]) == .waitingToReconnect(attempt: 4))
        #expect(
            BrowserBridgeFleetStatus.aggregate([] as [BrowserBridgeConnectionStatus])
                == .disconnected)
    }

    @Test("Only disabled vendor accounts are excluded from bridge connections")
    func activeVendorAccounts() {
        let active = EntityRow(
            id: "VACCT-4K7M", title: "Example store", subtitle: nil, imageURL: nil,
            raw: [
                "status": "active", "ledgerPartyId": "LPY-4K7M", "browser": "chrome",
            ])
        let disabled = EntityRow(
            id: "VACCT-8P2Q", title: "Old store", subtitle: nil, imageURL: nil,
            raw: [
                "status": "disabled", "ledgerPartyId": "LPY-4K7M", "browser": "safari",
            ])
        let pausedAuthentication = EntityRow(
            id: "VACCT-7R6T", title: "Needs sign-in", subtitle: nil, imageURL: nil,
            raw: [
                "status": "paused_auth", "ledgerPartyId": "LPY-4K7M", "browser": "safari",
            ])
        let pausedOffline = EntityRow(
            id: "VACCT-3D5F", title: "Mac was offline", subtitle: nil, imageURL: nil,
            raw: [
                "status": "paused_offline", "ledgerPartyId": "LPY-4K7M", "browser": "safari",
            ])

        #expect(BrowserBridgeVendorAccount(active)?.browser == .chrome)
        #expect(BrowserBridgeVendorAccount(pausedOffline)?.browser == .safari)
        #expect(BrowserBridgeVendorAccount(pausedAuthentication)?.browser == .safari)
        #expect(BrowserBridgeVendorAccount(disabled) == nil)
    }

    @Test("Manual sync response preserves server identifier spelling")
    func manualSyncResponse() throws {
        let data = Data(#"{"runId":"RUN-EXAMPLE","resumed":true}"#.utf8)
        let response = try JSONDecoder().decode(BrowserBridgeSyncResponse.self, from: data)

        #expect(response == BrowserBridgeSyncResponse(runID: "RUN-EXAMPLE", resumed: true))
        let encoded = try JSONEncoder().encode(response)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["runId"] as? String == "RUN-EXAMPLE")
        #expect(object["resumed"] as? Bool == true)
    }

    @Test("Nested command protocol versions are rejected even when the envelope is current")
    func staleNestedCommandProtocol() throws {
        let message = Data(
            #"""
            {"protocolVersion":2,"type":"command","command":{"protocolVersion":1,"id":"11111111-1111-1111-1111-111111111111","runID":"RUN-EXAMPLE","operationId":"operation-example","deadline":"2027-01-15T00:00:00Z","operation":{"type":"scroll","pageCount":1}}}
            """#.utf8)
        #expect(throws: DecodingError.self) {
            try JSONDecoder.browserBridge.decode(BrowserBridgeServerMessage.self, from: message)
        }
    }

    @Test("A run completion persists its acknowledgement and only creates one notification edge")
    func runCompletionReplayLifecycle() {
        let completion = BrowserBridgeRunCompletion(
            runID: "RUN-EXAMPLE", imported: 1, updated: 2, skipped: 3, findingCount: 4)
        var ledger = BrowserBridgeReplayLedger()

        let firstRecord = ledger.recordRunCompletion(completion)
        let replayRecord = ledger.recordRunCompletion(completion)
        #expect(firstRecord)
        #expect(!replayRecord)
        #expect(ledger.runCompletionsForAcknowledgement == [completion])
    }

    @Test("Result keeps the server's operationID spelling while commands use operationId")
    func operationIdentifiersMatchTheBridgeContract() throws {
        let command = BrowserBridgeCommand(
            id: UUID(uuidString: "55555555-5555-5555-5555-555555555555")!, runID: "RUN-EXAMPLE",
            operationID: "operation-example", deadline: .distantFuture, operation: .scroll(pageCount: 1))
        let commandData = try JSONEncoder.browserBridge.encode(command)
        let commandObject = try #require(JSONSerialization.jsonObject(with: commandData) as? [String: Any])
        #expect(commandObject["operationId"] as? String == "operation-example")

        let result = BrowserBridgeCommandResult(
            commandID: command.id, runID: command.runID, operationID: command.operationID,
            completedAt: .now, outcome: .completed(capture: nil))
        let resultData = try JSONEncoder.browserBridge.encode(result)
        let resultObject = try #require(JSONSerialization.jsonObject(with: resultData) as? [String: Any])
        #expect(resultObject["operationID"] as? String == "operation-example")
    }

    @Test("Run completion and authentication controls preserve their bounded payloads")
    func controlMessagesRoundTrip() throws {
        let completion = BrowserBridgeRunCompletion(
            runID: "RUN-EXAMPLE", imported: 1, updated: 2, skipped: 3, findingCount: 4)
        for message in [
            BrowserBridgeServerMessage.raiseAuthWindow(runID: "RUN-EXAMPLE"),
            BrowserBridgeServerMessage.runCompleted(completion),
        ] {
            let encoded = try JSONEncoder.browserBridge.encode(message)
            #expect(
                try JSONDecoder.browserBridge.decode(BrowserBridgeServerMessage.self, from: encoded)
                    == message)
        }
    }

    private static let operations: [BrowserBridgeOperation] = [
        .navigate(url: URL(string: "https://orders.example.com/order/1")!, allowedHosts: ["example.com"]),
        .followCapturedLink(linkID: "opaque-link", allowedHosts: ["example.com"]),
        .scroll(pageCount: 2),
        .capture(allowedHosts: ["example.com"], enhancedEvidence: true),
    ]
}

@Suite("Nearby receipt ranking")
struct NearbyReceiptRankingTests {
    @Test("Receipt, merchant, amount, and date evidence outrank a nearby generic photo")
    func evidenceRanking() throws {
        let date = try #require(Calendar.current.date(from: DateComponents(year: 2027, month: 1, day: 15)))
        let receipt = NearbyReceiptCandidateSignals(
            id: "receipt", capturedAt: date,
            classifications: [PhotoClassification(identifier: "receipt", confidence: 0.94)],
            recognizedText: [
                PhotoRecognizedText(text: "Example Hardware", confidence: 0.96),
                PhotoRecognizedText(text: "TOTAL $24.99", confidence: 0.99),
            ])
        let generic = NearbyReceiptCandidateSignals(
            id: "generic", capturedAt: date,
            classifications: [PhotoClassification(identifier: "outdoor", confidence: 0.99)],
            recognizedText: [])

        let ranked = NearbyReceiptRanker.rank(
            [generic, receipt],
            for: NearbyReceiptSearchContext(
                huntID: "HUNT-EXAMPLE", transactionDate: date, merchant: "Example Hardware",
                amountInCents: 2499))

        #expect(ranked.map(\.id) == ["receipt", "generic"])
        #expect(try #require(ranked.first).amountMatch > 0.9)
        #expect(try #require(ranked.first).merchantMatch > 0.9)
    }

    @Test("Candidates outside the explicit three-day window are excluded")
    func dateWindow() throws {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        let outside = try #require(Calendar.current.date(byAdding: .day, value: 4, to: date))
        let ranked = NearbyReceiptRanker.rank(
            [
                NearbyReceiptCandidateSignals(
                    id: "outside", capturedAt: outside,
                    classifications: [PhotoClassification(identifier: "receipt", confidence: 1)],
                    recognizedText: [])
            ],
            for: NearbyReceiptSearchContext(huntID: "HUNT-EXAMPLE", transactionDate: date))
        #expect(ranked.isEmpty)
    }
}
