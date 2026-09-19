import Foundation
import Testing

@testable import CubbyKit

@Suite("Purchase import browser bridge")
struct BrowserBridgeTests {
    @Test("Every safe operation has a stable versioned round trip", arguments: operations)
    func protocolRoundTrip(operation: BrowserBridgeOperation) throws {
        let command = BrowserBridgeCommand(
            id: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!, runID: "RUN-EXAMPLE",
            deadline: Date(timeIntervalSince1970: 1_800_000_000), operation: operation)
        let message = BrowserBridgeServerMessage.command(command)

        let encoded = try JSONEncoder.browserBridge.encode(message)
        let decoded = try JSONDecoder.browserBridge.decode(
            BrowserBridgeServerMessage.self, from: encoded)

        #expect(decoded == message)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["version"] as? Int == BrowserBridgeProtocol.currentVersion)
    }

    @Test("A future protocol version is rejected")
    func futureProtocolVersion() throws {
        let data = Data(#"{"version":999,"type":"ping","timestamp":"2027-01-15T00:00:00Z"}"#.utf8)
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
            commandID: id, runID: "RUN-EXAMPLE", completedAt: Date(timeIntervalSince1970: 100),
            outcome: .completed(capture: nil))
        var ledger = BrowserBridgeReplayLedger()

        ledger.record(result)
        #expect(ledger.replayResult(for: id) == result)
        #expect(ledger.resultsForReplay == [result])

        ledger.acknowledge(id)
        #expect(ledger.replayResult(for: id) == nil)
        #expect(ledger.resultsForReplay.isEmpty)
    }

    @Test("Cancellation prevents a late command result from entering replay")
    func cancellationWinsRace() {
        let id = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        var ledger = BrowserBridgeReplayLedger()
        ledger.cancel(id)
        ledger.record(
            BrowserBridgeCommandResult(
                commandID: id, runID: "RUN-EXAMPLE", completedAt: .now,
                outcome: .completed(capture: nil)))

        #expect(ledger.cancelled.contains(id))
        #expect(ledger.replayResult(for: id) == nil)
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
        let commandID = UUID(uuidString: "44444444-4444-4444-4444-444444444444")!
        let data = Data(
            #"{"runId":"RUN-EXAMPLE","commandId":"44444444-4444-4444-4444-444444444444"}"#.utf8)
        let response = try JSONDecoder().decode(BrowserBridgeSyncResponse.self, from: data)

        #expect(response == BrowserBridgeSyncResponse(runID: "RUN-EXAMPLE", commandID: commandID))
        let encoded = try JSONEncoder().encode(response)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["runId"] as? String == "RUN-EXAMPLE")
        #expect(object["commandId"] as? String == commandID.uuidString)
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
