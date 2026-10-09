#if os(macOS)
    @testable import CubbyKit
    import Foundation
    import Testing
    import WebKit

    /// Failure modes: cloned HTML loses live selection; credentials leak through input values;
    /// detached/replaced controls reuse a reference; navigation reuses an observation; duplicate
    /// delivery repeats a click; a page's old DOM attributes spoof native action references;
    /// a hidden login modal falsely pauses an otherwise usable product page for authentication.
    @Suite("Browser action observation", .serialized)
    @MainActor
    struct BrowserActionTests {
        @Test(
            "Hidden login controls cannot trigger authentication; visible controls remain credential-free",
            arguments: ["stylesheet", "visibility", "hidden", "aria"])
        func visibleAuthenticationControls(hiding: String) async throws {
            let page = try await makePage()
            _ = try await page.evaluateJavaScript(
                """
                const password = document.querySelector('input[type=password]');
                const modal = document.createElement('section');
                password.before(modal); modal.append(password);
                document.querySelector('select').selectedIndex = 1;
                """
            )
            let hide: String
            switch hiding {
            case "stylesheet":
                hide =
                    "const style=document.createElement('style'); style.textContent='.login-hidden{display:none}'; document.head.append(style); modal.className='login-hidden';"
            case "visibility": hide = "modal.style.visibility='hidden';"
            case "hidden": hide = "modal.hidden=true;"
            default: hide = "modal.setAttribute('aria-hidden','true');"
            }
            _ = try await page.evaluateJavaScript(hide)
            let hiddenRaw = try #require(
                try await page.evaluateJavaScript(MacBrowserCommandExecutor.snapshotScript) as? String)
            let hiddenSnapshot = try #require(
                JSONSerialization.jsonObject(with: Data(hiddenRaw.utf8)) as? [String: Any])
            let hiddenHTML = try #require(hiddenSnapshot["html"] as? String)
            #expect(!hiddenHTML.contains("type=\"password\""))
            #expect(!hiddenHTML.contains("synthetic-secret"))
            #expect(!hiddenHTML.contains("synthetic-query"))
            #expect(hiddenHTML.contains("data-cubby-selected=\"true\""))

            _ = try await page.evaluateJavaScript(
                "modal.className=''; modal.style.visibility=''; modal.hidden=false; modal.removeAttribute('aria-hidden');"
            )
            let visibleRaw = try #require(
                try await page.evaluateJavaScript(MacBrowserCommandExecutor.snapshotScript) as? String)
            let visibleSnapshot = try #require(
                JSONSerialization.jsonObject(with: Data(visibleRaw.utf8)) as? [String: Any])
            let visibleHTML = try #require(visibleSnapshot["html"] as? String)
            #expect(visibleHTML.contains("type=\"password\""))
            #expect(!visibleHTML.contains("synthetic-secret"))
            #expect(!visibleHTML.contains("synthetic-query"))
            #expect(visibleHTML.contains("data-cubby-selected=\"true\""))
        }

        @Test("A selected variant fragment survives capture and subsequent observed actions")
        func selectedVariantFragment() async throws {
            let page = try await makePage()
            _ = try await page.evaluateJavaScript(
                "document.querySelector('select').addEventListener('change', () => { location.hash = 'color=green'; }); document.body.insertAdjacentHTML('beforeend', '<a href=\"#color=blue\">Blue details</a>');"
            )
            let originalID = "11111111-1111-4111-8111-111111111111"
            let originalRaw = try #require(
                try await page.evaluateJavaScript(BrowserActionScript.observation(id: originalID)) as? String)
            let original = try #require(
                JSONSerialization.jsonObject(with: Data(originalRaw.utf8)) as? [String: Any])
            let originalControls = try #require(original["actions"] as? [[String: Any]])
            let select = try #require(originalControls.first { $0["kind"] as? String == "select" })
            let green = try #require(
                originalControls.first {
                    $0["kind"] as? String == "option" && $0["label"] as? String == "Green"
                })
            _ = try await page.evaluateJavaScript(
                BrowserActionScript.perform(
                    kind: "select", observationId: originalID, ref: try #require(select["ref"] as? String),
                    allowedHosts: ["shop.example.test"], optionRef: try #require(green["ref"] as? String)))
            let servedText = try #require(try await page.evaluateJavaScript("location.href") as? String)
            let servedURL = try #require(URL(string: servedText))
            #expect(servedURL.fragment == "color=green")
            #expect(
                try BrowserBridgeURLPolicy.validate(servedURL, allowedHosts: ["shop.example.test"])
                    == servedURL)
            let currentID = "22222222-2222-4222-8222-222222222222"
            let currentRaw = try #require(
                try await page.evaluateJavaScript(BrowserActionScript.observation(id: currentID)) as? String)
            let current = try #require(
                JSONSerialization.jsonObject(with: Data(currentRaw.utf8)) as? [String: Any])
            #expect(current["url"] as? String == servedURL.absoluteString)
            let controls = try #require(current["actions"] as? [[String: Any]])
            let link = try #require(controls.first { $0["kind"] as? String == "link" })
            #expect(link["navigationURL"] as? String == "https://shop.example.test/products#color=blue")
            #expect(
                controls.contains { $0["label"] as? String == "Green" && $0["selected"] as? Bool == true })
            let button = try #require(
                controls.first { $0["kind"] as? String == "button" && $0["label"] as? String == "Choose" })
            let buttonRef = try #require(button["ref"] as? String)
            let clicked = try #require(
                try await page.evaluateJavaScript(
                    BrowserActionScript.perform(
                        kind: "click", observationId: currentID, ref: buttonRef,
                        allowedHosts: ["shop.example.test"])) as? String)
            #expect(clicked == "{\"status\":\"completed\"}")
            let buttonText =
                try await page.evaluateJavaScript("document.querySelector('button').textContent") as? String
            #expect(buttonText == "Clicked")
            let credentialURL = try #require(
                URL(string: "https://user@shop.example.test/products#color=green"))
            let foreignURL = try #require(URL(string: "https://other.example.test/products#color=green"))
            #expect(throws: BrowserBridgeURLPolicy.Failure.self) {
                try BrowserBridgeURLPolicy.validate(
                    credentialURL,
                    allowedHosts: ["shop.example.test"])
            }
            #expect(throws: BrowserBridgeURLPolicy.Failure.self) {
                try BrowserBridgeURLPolicy.validate(
                    foreignURL,
                    allowedHosts: ["shop.example.test"])
            }
        }

        @Test("Observed links and search controls advertise their exact navigation destination")
        func advertisedNavigation() async throws {
            let page = try await makePage()
            _ = try await page.evaluateJavaScript(
                "document.querySelector('form').action='https://search.example.test/find'; document.body.insertAdjacentHTML('beforeend', '<a href=\"https://catalog.example.test/item\">External product</a>');"
            )
            let raw = try #require(
                try await page.evaluateJavaScript(MacBrowserCommandExecutor.snapshotScript) as? String)
            let snapshot = try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
            let actions = try #require(snapshot["actions"] as? [[String: Any]])
            let link = try #require(actions.first { $0["kind"] as? String == "link" })
            let search = try #require(actions.first { $0["kind"] as? String == "searchbox" })
            #expect(link["navigationURL"] as? String == "https://catalog.example.test/item")
            #expect(search["navigationURL"] as? String == "https://search.example.test/find")
        }

        @Test("The fixed native scroll command can move an observed page upward")
        func upwardScroll() async throws {
            let page = try await makePage()
            _ = try await page.evaluateJavaScript(
                "document.body.style.height = '4000px'; window.scrollTo(0, 1200);")
            let before = try #require(try await page.evaluateJavaScript("window.scrollY") as? Double)
            #expect(before > 0)
            _ = try await page.evaluateJavaScript(MacBrowserCommandExecutor.scrollScript(pageCount: -1))
            let after = try #require(try await page.evaluateJavaScript("window.scrollY") as? Double)
            #expect(after < before)
        }

        @Test("A replay result cannot be overwritten by work with the same command identifier")
        func replayOwnership() {
            let result = BrowserBridgeCommandResult(
                commandID: "11111111-1111-4111-8111-111111111111", runID: "RUN-EXAMPLE",
                operationID: "choose-variant", completedAt: .now,
                outcome: .completed(snapshot: nil, observation: .unobserved)
            )
            var ledger = BrowserBridgeReplayLedger()
            ledger.record(result)
            let rebound = BrowserBridgeCommandResult(
                commandID: result.commandID, runID: "RUN-OTHER", operationID: "choose-other",
                completedAt: .now, outcome: .completed(snapshot: nil, observation: .unobserved)
            )
            ledger.record(rebound)
            #expect(ledger.replayResult(for: result.commandID) == result)
        }

        @Test("An interrupted interactive command survives relaunch as uncertain work")
        func interruptedAction() throws {
            let command = try BrowserBridgeCommand(
                id: #require(UUID(uuidString: "11111111-1111-4111-8111-111111111111")), runID: "RUN-EXAMPLE",
                operationID: "choose-variant", deadline: .distantFuture,
                operation: .click(
                    .init(
                        _type: .click, observationId: "22222222-2222-4222-8222-222222222222",
                        ref: "control-1", allowedHosts: ["shop.example.test"]
                    )
                )
            )
            var ledger = BrowserBridgeReplayLedger()
            ledger.beginInteractive(command)
            let persisted = try JSONEncoder.browserBridge.encode(ledger)
            let recovered = try JSONDecoder.browserBridge.decode(
                BrowserBridgeReplayLedger.self, from: persisted
            )
            let uncertain = try #require(recovered.interruptedResult(for: command.id))
            guard case let .failed(failure) = uncertain.outcome else {
                Issue.record("Interrupted work must require observation recovery.")
                return
            }
            #expect(failure.code == .actionOutcomeUnknown)
            #expect(!failure.retryable)
            #expect(uncertain.runID == command.runID)
            #expect(uncertain.operationID == command.operationID)
        }

        @Test("Observation retains live selected variants and removes private form values")
        func selectedVariantObservation() async throws {
            let page = try await makePage()
            _ = try await page.evaluateJavaScript(
                "document.querySelector('select').selectedIndex = 1; document.querySelector('#large').checked = true;"
            )
            let raw = try #require(
                try await page.evaluateJavaScript(MacBrowserCommandExecutor.snapshotScript) as? String
            )
            let observation = try #require(
                JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
            )
            let html = try #require(observation["html"] as? String)
            #expect(html.contains("data-cubby-selected=\"true\""))
            #expect(html.contains("data-cubby-checked=\"true\""))
            #expect(!html.contains("synthetic-secret"))
            #expect(!html.contains("synthetic-query"))
            #expect(observation["observationId"] as? String != nil)
            #expect((observation["actions"] as? [[String: Any]])?.isEmpty == false)
        }

        @Test("Action refuses an observation after its control was replaced")
        func staleControl() async throws {
            let page = try await makePage()
            let id = "11111111-1111-4111-8111-111111111111"
            let raw = try #require(
                try await page.evaluateJavaScript(BrowserActionScript.observation(id: id)) as? String
            )
            let snapshot = try #require(
                JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
            )
            let controls = try #require(snapshot["actions"] as? [[String: Any]])
            let button = try #require(controls.first { $0["kind"] as? String == "button" })
            let ref = try #require(button["ref"] as? String)
            _ = try await page.evaluateJavaScript(
                "document.querySelector('button').outerHTML='<button>Replacement</button>';"
            )
            let result = try #require(
                try await page.evaluateJavaScript(
                    BrowserActionScript.perform(
                        kind: "click", observationId: id, ref: ref,
                        allowedHosts: ["shop.example.test"]
                    )
                ) as? String
            )
            #expect(result.contains("stale_observation"))
            #expect(
                try await page.evaluateJavaScript("document.querySelector('button').textContent") as? String
                    == "Replacement"
            )
        }

        private func makePage() async throws -> WKWebView {
            let page = WKWebView(frame: .init(x: 0, y: 0, width: 800, height: 600))
            page.loadHTMLString(
                """
                <html><body><form><label>Find products<input type="search" value="synthetic-query"></label>
                <input type="password" value="synthetic-secret">
                <label>Color<select><option>Blue</option><option>Green</option></select></label>
                <label><input id="large" type="radio" name="size">Large</label>
                <button type="button" onclick="this.textContent='Clicked'">Choose</button>
                </form></body></html>
                """, baseURL: URL(string: "https://shop.example.test/products")
            )
            for _ in 0..<100 {
                if (try? await page.evaluateJavaScript(
                    "document.readyState === 'complete' && document.querySelector('select') !== null"
                ))
                    as? Bool == true
                {
                    return page
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw ExecutionFailure.pageUnreadable
        }
    }
#endif
