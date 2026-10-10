#if os(macOS)
    import CryptoKit
    import Foundation
    import Testing
    @testable import CubbyKit

    @Suite("ChatGPT local sign-in")
    struct ChatGptSignInTests {
        @Test("PKCE and registration survive the browser round trip")
        func registration() throws {
            let attempt = ChatGptAuthorizationAttempt(host: .init(hostId: "urn:uuid:example", clientId: nil))
            let redirect = URL(string: "http://127.0.0.1:12345/auth/callback")!
            let url = try attempt.authorizationURL(redirect: redirect)
            let query = Dictionary(
                uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map
                { ($0.name, $0.value!) })
            #expect(query["client_id"] == "dynamic_agent_client")
            #expect(
                query["code_challenge"]
                    == Data(SHA256.hash(data: Data(attempt.verifier.utf8))).chatGptBase64URL)
            #expect(query["resource"] == "https://api.openai.com/v1")
            let result = try attempt.authorization(
                callback: URL(
                    string: "\(redirect)?state=\(attempt.state)&code=example&client_id=oaiapp_example")!,
                redirect: redirect)
            #expect(result.clientId == "oaiapp_example")
            #expect(result.verifier == attempt.verifier)
            #expect(throws: ChatGptSignInError.self) {
                try attempt.authorization(
                    callback: URL(string: "\(redirect)?state=wrong&code=example&client_id=oaiapp_example")!,
                    redirect: redirect)
            }
            let returning = ChatGptAuthorizationAttempt(
                host: .init(hostId: "urn:uuid:example", clientId: "oaiapp_existing"))
            #expect(throws: ChatGptSignInError.self) {
                try returning.authorization(
                    callback: URL(
                        string: "\(redirect)?state=\(returning.state)&code=example&client_id=oaiapp_other")!,
                    redirect: redirect)
            }
        }

        @Test("Forged state cannot consume the real loopback callback")
        @MainActor func callback() async throws {
            let listener = try ChatGptLoopbackCallback(state: "expected")
            defer { listener.close() }
            let redirect = try await listener.start()
            let (_, invalid) = try await URLSession.shared.data(
                from: URL(string: "\(redirect)?state=wrong&code=forged")!)
            #expect((invalid as? HTTPURLResponse)?.statusCode == 400)
            async let callback = listener.receive()
            let (_, valid) = try await URLSession.shared.data(
                from: URL(string: "\(redirect)?state=expected&code=example")!)
            #expect((valid as? HTTPURLResponse)?.statusCode == 200)
            #expect(try await callback.query?.contains("code=example") == true)
        }

        @Test("An abandoned sign-in has a bounded lifetime")
        @MainActor func timeout() async throws {
            let listener = try ChatGptLoopbackCallback(state: "expected")
            defer { listener.close() }
            _ = try await listener.start()
            await #expect(throws: ChatGptSignInError.self) {
                // The sign-in's lifetime ends before any callback arrives.
                try await listener.receive(expiry: {})
            }
        }
    }
#endif
