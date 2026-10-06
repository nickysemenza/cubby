import Foundation
import JavaScriptCore
import Testing

@testable import CubbyKit

@Suite("Purchase import browser bridge")
struct BrowserBridgeTests {
    @Test("Debug records encode only bounded transport metadata")
    func debugRecordEncoding() throws {
        let record = BrowserBridgeDebugRecord(
            id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            occurredAt: Date(timeIntervalSince1970: 100), event: .commandFinished,
            runID: "22222222-2222-4222-8222-222222222222",
            commandID: UUID(uuidString: "33333333-3333-4333-8333-333333333333"),
            operationID: "capture-001", operationKind: "capture",
            host: "orders.example.test", browser: "chrome", accountID: "VACCT-4K7M",
            attempt: nil, count: nil, outcome: "completed_with_capture",
            messageType: nil, errorType: nil, errorCode: nil, executor: nil)

        let data = try JSONEncoder().encode(record)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(object["runId"] as? String == "22222222-2222-4222-8222-222222222222")
        #expect(object["operationKind"] as? String == "capture")
        #expect(object["host"] as? String == "orders.example.test")
        #expect(object["url"] == nil)
        #expect(object["pageText"] == nil)
        #expect(object["evidence"] == nil)
    }

    @Test("A sync request without a backfill range encodes only the account")
    func syncRequestOmitsAbsentBackfill() throws {
        let data = try JSONEncoder().encode(BrowserBridgeSyncRequest(vendorAccount: "VACCT-4K7M"))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["vendorAccount"] as? String == "VACCT-4K7M")
        #expect(object["backfill"] == nil)
    }

    @Test("A sync request with a backfill range encodes inclusive ISO dates")
    func syncRequestEncodesBackfill() throws {
        let range = try #require(
            BrowserBridgeBackfillRange(
                from: Self.day(2025, 3, 9), to: Self.day(2026, 3, 9), calendar: Self.calendar))
        let data = try JSONEncoder().encode(
            BrowserBridgeSyncRequest(vendorAccount: "VACCT-4K7M", backfill: range))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let backfill = try #require(object["backfill"] as? [String: String])
        #expect(backfill == ["from": "2025-03-09", "to": "2026-03-09"])
    }

    @Test("A backfill range may be a single day but never inverted")
    func backfillRangeValidation() {
        let day = Self.day(2026, 1, 5)
        #expect(BrowserBridgeBackfillRange(from: day, to: day, calendar: Self.calendar) != nil)
        // A later time on the same day is still the same inclusive day.
        let evening = Self.calendar.date(byAdding: .hour, value: 20, to: day)!
        #expect(BrowserBridgeBackfillRange(from: evening, to: day, calendar: Self.calendar) != nil)
        #expect(
            BrowserBridgeBackfillRange(
                from: Self.day(2026, 1, 6), to: day, calendar: Self.calendar) == nil)
    }

    @Test("The default backfill range ends today and starts a year earlier")
    func defaultBackfillRange() {
        let today = Self.day(2026, 3, 1)
        let range = BrowserBridgeBackfillRange.defaultDates(today: today, calendar: Self.calendar)
        #expect(range.to == today)
        #expect(range.from == Self.day(2025, 3, 1))
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private static func day(_ year: Int, _ month: Int, _ day: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day))!
    }

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

    @Test("Capture navigation honors a new target without reloading the current target")
    func captureNavigationPolicy() throws {
        let history = try #require(URL(string: "https://orders.example.com/history"))
        let order = try #require(URL(string: "https://orders.example.com/order/1"))

        #expect(
            !BrowserCaptureNavigationPolicy.shouldNavigate(
                currentURL: history, targetURL: history))
        #expect(
            BrowserCaptureNavigationPolicy.shouldNavigate(
                currentURL: history, targetURL: order))
        #expect(
            BrowserCaptureNavigationPolicy.shouldNavigate(
                currentURL: nil, targetURL: order))
        #expect(
            !BrowserCaptureNavigationPolicy.shouldNavigate(
                currentURL: history, targetURL: nil))
    }

    @Test("Capture readiness rejects a complete stale document")
    func captureReadinessPolicy() throws {
        let current = try #require(URL(string: "https://orders.example.com/order/1"))
        let target = try #require(URL(string: "https://orders.example.com/order/2"))

        #expect(
            !BrowserCaptureNavigationPolicy.isReady(
                currentURL: current, targetURL: target, documentReadyState: "complete"))
        #expect(
            !BrowserCaptureNavigationPolicy.isReady(
                currentURL: target, targetURL: target, documentReadyState: "loading"))
        #expect(
            BrowserCaptureNavigationPolicy.isReady(
                currentURL: target, targetURL: target, documentReadyState: "complete"))
    }

    @Test("Capture metadata preserves variant identity and high-resolution image evidence")
    func captureMetadataContract() throws {
        let sourceURL = try #require(URL(string: "https://www.amazon.com/dp/B012345678"))
        let canonicalURL = try #require(URL(string: "https://www.amazon.com/dp/B012345678"))
        let imageURL = try #require(URL(string: "https://images.amazon.com/example.jpg"))
        let highResolutionURL = try #require(URL(string: "https://images.amazon.com/example-hires.jpg"))
        let image = BrowserCapturedImage(
            url: imageURL, alt: "Example", naturalWidth: 1200, naturalHeight: 900,
            highResolutionURL: highResolutionURL)
        let capture = BrowserPageCapture(
            sourceURL: sourceURL, title: "Example", capturedAt: .now, captureVersion: 1,
            readableText: "Example", links: [], images: [image], canonicalURL: canonicalURL,
            requestedAmazonASIN: "B012345678", servedAmazonASIN: "B012345678",
            variantMarkers: ["Blue", "Large"])

        #expect(capture.canonicalUrl == canonicalURL.absoluteString)
        #expect(capture.requestedAmazonAsin == "B012345678")
        #expect(capture.servedAmazonAsin == "B012345678")
        #expect(capture.variantMarkers == ["Blue", "Large"])
        #expect(capture.images == [image])
        #expect(capture.images[0].naturalWidth == 1200)
        #expect(capture.images[0].naturalHeight == 900)
        #expect(capture.images[0].highResolutionUrl == highResolutionURL.absoluteString)
    }

    @Test("Structured product identifiers ride the capture and stay optional for older payloads")
    func structuredProductsContract() throws {
        let sourceURL = try #require(URL(string: "https://www.forgewear.example.test/p/tee-black-m"))
        let structured = BrowserStructuredProducts(
            products: [
                BrowserStructuredProduct(
                    skus: ["FW-TEE-BLK-M"], mpns: ["TEE-100"], gtins: ["036000291452"], productIds: [])
            ], variantGroup: false)
        let capture = BrowserPageCapture(
            sourceURL: sourceURL, title: "Tee", capturedAt: .now, captureVersion: 2,
            readableText: "Tee", links: [], images: [], structuredProducts: structured)
        let encoded = try JSONEncoder().encode(capture)
        let decoded = try JSONDecoder().decode(BrowserPageCapture.self, from: encoded)
        #expect(decoded.structuredProducts == structured)

        var legacy = try #require(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        legacy.removeValue(forKey: "structuredProducts")
        let legacyData = try JSONSerialization.data(withJSONObject: legacy)
        let legacyCapture = try JSONDecoder().decode(BrowserPageCapture.self, from: legacyData)
        #expect(legacyCapture.structuredProducts == nil)
    }

    #if os(macOS)
        @Test("The fixed capture payload maps schema.org Product data and tolerates its absence")
        func fixedCapturePayloadStructuredProducts() throws {
            let base = """
                "url":"https://www.forgewear.example.test/p/tee","canonicalUrl":null,
                "servedAmazonAsin":null,"variantMarkers":[],"title":"Tee","text":"Tee",
                "links":[],"images":[],"authenticationRequired":false
                """
            let withData = """
                {\(base),"structuredProducts":{"variantGroup":true,"products":[
                {"skus":["A1"],"mpns":[],"gtins":["036000291452"],"productIds":["P1"]}]}}
                """
            let payload = try JSONDecoder().decode(
                MacBrowserCommandExecutor.FixedCapturePayload.self, from: Data(withData.utf8))
            let capture = try #require(payload.structuredProducts?.capture)
            #expect(capture.variantGroup)
            #expect(capture.products.first?.gtins == ["036000291452"])
            #expect(capture.products.first?.productIds == ["P1"])

            let without = try JSONDecoder().decode(
                MacBrowserCommandExecutor.FixedCapturePayload.self, from: Data("{\(base)}".utf8))
            #expect(without.structuredProducts == nil)
        }

        /// Runs the production ld+json walker in JavaScriptCore against a stub page.
        private func walkStructuredProducts(pageURL: String, blocks: [String]) throws
            -> BrowserStructuredProducts
        {
            let context = try #require(JSContext())
            context.setObject(pageURL, forKeyedSubscript: "pageURL" as NSString)
            context.setObject(blocks, forKeyedSubscript: "blocks" as NSString)
            let result = context.evaluateScript(
                """
                var location = { href: pageURL };
                var document = { querySelectorAll: () => blocks.map(text => ({ textContent: text })) };
                JSON.stringify((\(MacBrowserCommandExecutor.structuredProductsScript))());
                """)
            #expect(context.exception == nil, "\(String(describing: context.exception))")
            let json = try #require(result?.toString())
            return try JSONDecoder().decode(
                MacBrowserCommandExecutor.FixedCapturePayload.StructuredProducts.self,
                from: Data(json.utf8)
            ).capture
        }

        private static let shopifyTee = """
            {"@context":"https://schema.org","@type":"Product","name":"Forgewear Tee",
             "productID":"8800001","mpn":"TEE-100","sku":"FW-TEE-BLK-S","gtin13":"0036000291452",
             "offers":[
              {"@type":"Offer","sku":"FW-TEE-BLK-S","gtin13":"0036000291452","mpn":"TEE-100-S",
               "url":"https://shop.forgewear.example.test/products/tee?variant=41000000000111"},
              {"@type":"Offer","sku":"FW-TEE-BLK-M","gtin13":"0036000291469","mpn":"TEE-100-M",
               "url":"https://shop.forgewear.example.test/products/tee?variant=41000000000222"}]}
            """

        @Test("A Shopify Product's single Offer contributes its identifiers")
        func structuredProductsSingleOffer() throws {
            let block = """
                {"@context":"https://schema.org","@type":"Product","name":"Forgewear Mug","mpn":"MUG-1",
                 "offers":{"@type":"Offer","sku":"FW-MUG-1","gtin12":"036000291452",
                  "url":"https://shop.forgewear.example.test/products/mug?variant=41000000000333"}}
                """
            let captured = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/mug", blocks: [block])
            #expect(
                captured
                    == BrowserStructuredProducts(
                        products: [
                            BrowserStructuredProduct(
                                skus: ["FW-MUG-1"], mpns: ["MUG-1"], gtins: ["036000291452"],
                                productIds: [])
                        ], variantGroup: false))
        }

        @Test("Offers with identical identifiers merge into their Product")
        func structuredProductsIdenticalOffers() throws {
            let block = """
                {"@context":"https://schema.org","@type":"Product","name":"Forgewear Mug",
                 "offers":[
                  {"@type":"Offer","sku":"FW-MUG-1","gtin12":"036000291452","price":"12.00",
                   "url":"https://shop.forgewear.example.test/products/mug?variant=41000000000333"},
                  {"@type":"Offer","sku":"FW-MUG-1","gtin12":"036000291452","price":"10.00",
                   "url":"https://shop.forgewear.example.test/products/mug?variant=41000000000333"}]}
                """
            let captured = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/mug", blocks: [block])
            #expect(
                captured
                    == BrowserStructuredProducts(
                        products: [
                            BrowserStructuredProduct(
                                skus: ["FW-MUG-1"], mpns: [], gtins: ["036000291452"], productIds: [])
                        ], variantGroup: false))
        }

        @Test("The served ?variant= selects exactly one Offer and drops default-variant identifiers")
        func structuredProductsServedVariant() throws {
            let captured = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee?variant=41000000000222",
                blocks: [Self.shopifyTee])
            #expect(
                captured
                    == BrowserStructuredProducts(
                        products: [
                            BrowserStructuredProduct(
                                skus: ["FW-TEE-BLK-M"], mpns: ["TEE-100", "TEE-100-M"],
                                gtins: ["0036000291469"], productIds: ["8800001"])
                        ], variantGroup: false))
        }

        @Test("Differing Offers without a served variant are an ambiguous variant group")
        func structuredProductsAmbiguousOffers() throws {
            let captured = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee", blocks: [Self.shopifyTee])
            #expect(captured.variantGroup)
            let unmatched = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee?variant=41000000000999",
                blocks: [Self.shopifyTee])
            #expect(unmatched.variantGroup)
        }

        private static func offer(sku: String, variant: Int) -> String {
            """
            {"@type":"Offer","sku":"\(sku)",
             "url":"https://shop.forgewear.example.test/products/tee?variant=\(variant)"}
            """
        }

        @Test("An Offer beyond the offer cap fails closed instead of reading as exact")
        func structuredProductsOfferCap() throws {
            let offers =
                (0..<100).map { _ in Self.offer(sku: "FW-SAME", variant: 1) }
                + [Self.offer(sku: "FW-OTHER", variant: 2)]
            let block = """
                {"@context":"https://schema.org","@type":"Product","offers":[\(offers.joined(separator: ","))]}
                """
            let captured = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee", blocks: [block])
            #expect(captured.variantGroup)
        }

        @Test("Offers never starve the graph walk, and an exhausted walk fails closed")
        func structuredProductsNodeBudget() throws {
            let filler = Array(repeating: #"{"@type":"WebPage"}"#, count: 398)
            let offers = (0..<100).map { _ in Self.offer(sku: "FW-SAME", variant: 1) }
            let first = #"{"@type":"Product","offers":["# + offers.joined(separator: ",") + "]}"
            let second = #"{"@type":"Product","sku":"FW-SECOND"}"#
            let graph =
                #"{"@context":"https://schema.org","@graph":["#
                + (filler + [first, second]).joined(separator: ",") + "]}"
            let captured = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee", blocks: [graph])
            #expect(captured.products.count == 2)

            let overflow =
                #"{"@context":"https://schema.org","@graph":["#
                + (Array(repeating: #"{"@type":"WebPage"}"#, count: 600)
                + [#"{"@type":"ProductGroup"}"#, second]).joined(separator: ",") + "]}"
            let exhausted = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee", blocks: [overflow])
            #expect(exhausted.variantGroup)
        }

        @Test("A single Offer naming another variant never merges with the Product's default")
        func structuredProductsSingleConflictingOffer() throws {
            let block = """
                {"@context":"https://schema.org","@type":"Product","sku":"FW-DEFAULT-S",
                 "offers":\(Self.offer(sku: "FW-OTHER-M", variant: 222))}
                """
            let servedS = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee?variant=111", blocks: [block])
            #expect(servedS.variantGroup)
            let servedM = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee?variant=222", blocks: [block])
            #expect(!servedM.variantGroup)
            #expect(servedM.products.map(\.skus) == [["FW-OTHER-M"]])
        }

        @Test("Only the query's single decoded variant parameter selects an Offer")
        func structuredProductsVariantParsing() throws {
            let base = "https://shop.forgewear.example.test/products/tee"
            let fragment = try walkStructuredProducts(
                pageURL: base + "#?variant=41000000000222", blocks: [Self.shopifyTee])
            #expect(fragment.variantGroup)
            let duplicate = try walkStructuredProducts(
                pageURL: base + "?variant=41000000000111&variant=41000000000222",
                blocks: [Self.shopifyTee])
            #expect(duplicate.variantGroup)
            let encoded = try walkStructuredProducts(
                pageURL: base + "?vari%61nt=41000000000222#reviews", blocks: [Self.shopifyTee])
            #expect(!encoded.variantGroup)
            #expect(encoded.products.map(\.skus) == [["FW-TEE-BLK-M"]])
        }

        @Test("An identifier longer than the capture keeps fails closed instead of comparing a prefix")
        func structuredProductsOverlongIdentifier() throws {
            let prefix = String(repeating: "X", count: 100)
            let block = """
                {"@context":"https://schema.org","@type":"Product","sku":"\(prefix)S",
                 "gtin13":"0036000291452","offers":\(Self.offer(sku: prefix + "M", variant: 222))}
                """
            let capture = try walkStructuredProducts(
                pageURL: "https://shop.forgewear.example.test/products/tee?variant=222", blocks: [block])
            #expect(capture.variantGroup)
        }

        @Test("A repeated or undecodable served variant never takes the agreement shortcut")
        func structuredProductsInvalidServedVariant() throws {
            let block = """
                {"@context":"https://schema.org","@type":"Product","sku":"SYN-S",
                 "offers":\(Self.offer(sku: "SYN-S", variant: 111))}
                """
            let base = "https://shop.forgewear.example.test/products/tee"
            for query in ["?variant=111&variant=222", "?variant=%ZZ"] {
                let capture = try walkStructuredProducts(pageURL: base + query, blocks: [block])
                #expect(capture.variantGroup, "\(query)")
            }
            let absent = try walkStructuredProducts(pageURL: base, blocks: [block])
            #expect(!absent.variantGroup)
            #expect(absent.products.map(\.skus) == [["SYN-S"]])
        }
    #endif

    @Test("Completed results replay until acknowledged")
    func replayLifecycle() {
        let uuid = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        let id = uuid.uuidString.lowercased()
        let result = BrowserBridgeCommandResult(
            commandID: uuid, runID: "RUN-EXAMPLE", operationID: "operation-example",
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
        let id = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!.uuidString.lowercased()
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
        let uuid = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        let id = uuid.uuidString.lowercased()
        var ledger = BrowserBridgeReplayLedger()
        ledger.cancel(id)
        ledger.record(
            BrowserBridgeCommandResult(
                commandID: uuid, runID: "RUN-EXAMPLE", operationID: "operation-example",
                completedAt: .now, outcome: .completed(capture: nil)))

        #expect(ledger.cancelled.contains(id))
        #expect(ledger.replayResult(for: id) == nil)
    }

    @Test("A stale replay result can be discarded before a protocol rejection replaces it")
    func staleReplayResultIsFenced() {
        let uuid = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        let id = uuid.uuidString.lowercased()
        let cached = BrowserBridgeCommandResult(
            commandID: uuid, runID: "RUN-OLD", operationID: "operation-old", completedAt: .now,
            outcome: .completed(capture: nil))
        var ledger = BrowserBridgeReplayLedger()

        ledger.record(cached)
        ledger.discardReplayResult(for: id)
        #expect(ledger.replayResult(for: id) == nil)
        #expect(!ledger.cancelled.contains(id))
    }

    @Test("Socket URLs upgrade HTTPS and preserve only the account query")
    func socketEndpoint() throws {
        let production = try AuthenticatedSocketSupport.socketURL(
            baseURL: try #require(URL(string: "https://cubby.example/custom?old=value#fragment")),
            path: "/api/import/agent/socket", queryItems: Self.accountQuery)
        #expect(
            production.absoluteString
                == "wss://cubby.example/api/import/agent/socket?vendorAccount=VACCT-4K7M")

        let local = try AuthenticatedSocketSupport.socketURL(
            baseURL: try #require(URL(string: "http://localhost:3000")),
            path: "/api/import/agent/socket", queryItems: Self.accountQuery)
        #expect(local.scheme == "ws")
        #expect(local.port == 3000)
    }

    @Test("Socket URLs reject cleartext remote servers")
    func socketEndpointSecurity() throws {
        let url = try #require(URL(string: "http://cubby.example"))
        #expect(throws: URLError(.secureConnectionFailed)) {
            try AuthenticatedSocketSupport.socketURL(
                baseURL: url, path: "/api/import/agent/socket", queryItems: Self.accountQuery)
        }
    }

    private static let accountQuery = [URLQueryItem(name: "vendorAccount", value: "VACCT-4K7M")]

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
            runID: "RUN-EXAMPLE", terminalStatus: .completed, imported: 1, updated: 2,
            skipped: 3, findingCount: 4)
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
            runID: "RUN-EXAMPLE", terminalStatus: .completed, imported: 1, updated: 2,
            skipped: 3, findingCount: 4)
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
        .capture(
            allowedHosts: ["example.com"], enhancedEvidence: true,
            recoveryURL: URL(string: "https://orders.example.com/history")!),
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
