import CubbyKit
import Foundation
import Testing

@testable import cubby

@Suite("CLI API error output")
struct APIErrorOutputTests {
    @Test func nonJSON406PreservesTheRejectionAndOperation() {
        let error = CubbyAPIError.decode(
            status: 406, operationID: "shippingRecord.record",
            body: Data("<html>Not Acceptable: synthetic edge rejection</html>".utf8))

        let output = CLI.apiErrorMessage(error)
        #expect(output.contains("HTTP 406 HTTP_ERROR"))
        #expect(output.contains("shippingRecord.record"))
        #expect(output.contains("Not Acceptable: synthetic edge rejection"))
    }

    @Test func structuredErrorsPreserveValidationAndDiagnosticExtensions() {
        let body = Data(
            #"{"code":"VALIDATION_ERROR","message":"Invalid shipment evidence","reason":"INVALID_INPUT","requestId":"req_synthetic","validationIssues":[{"code":"invalid_type","path":["items",0,"quantity"],"message":"Expected number"}],"diagnostics":{"origin":"server","operation":"shippingRecord.record","stage":"validate","causes":[{"name":"Error","message":"SQLSTATE 22003","code":"22003","stack":"Error: synthetic\n at synthetic"}],"cfRayId":"synthetic-ray","futureDiagnostic":"preserved"},"input":{"privateSource":"synthetic-request-payload"}}"#
                .utf8)
        let output = CLI.apiErrorMessage(
            .decode(status: 400, operationID: "shippingRecord.record", body: body))

        for expected in [
            "HTTP 400 VALIDATION_ERROR: Invalid shipment evidence", "INVALID_INPUT",
            "req_synthetic", "invalid_type", "quantity", "Expected number", "22003",
            "synthetic-ray", "futureDiagnostic", "preserved",
        ] {
            #expect(output.contains(expected))
        }
        #expect(!output.contains("synthetic-request-payload"))
    }

    @Test func rawJSONDiagnosticsSurviveAnUnknownOptionalShape() {
        let body = Data(
            #"{"code":"REFUSED","message":"Synthetic refusal","diagnostics":{"futureShape":["edge detail"]}}"#
                .utf8)
        let output = CLI.apiErrorMessage(
            .decode(status: 406, operationID: "shippingRecord.record", body: body))
        #expect(output.contains("edge detail"))
    }

    @Test func responseCredentialsAndEchoedRequestsAreRedacted() {
        let body = Data(
            #"{"code":"REFUSED","message":"Authorization: Bearer synthetic-bearer-secret","diagnostics":{"password":"synthetic-password","accessToken":"synthetic-access-token","request":{"input":"synthetic-private-request"},"cause":"https://synthetic-user:synthetic-pass@example.invalid/?token=synthetic-query-secret"}}"#
                .utf8)
        let output = CLI.apiErrorMessage(
            .decode(status: 406, operationID: "shippingRecord.record", body: body))
        for secret in [
            "synthetic-bearer-secret", "synthetic-password", "synthetic-access-token",
            "synthetic-private-request", "synthetic-user", "synthetic-pass", "synthetic-query-secret",
        ] {
            #expect(!output.contains(secret))
        }
        #expect(output.contains("[REDACTED]"))
    }

    @Test func plainTextCredentialsAreRedactedWithoutLosingDiagnosticTails() {
        let text = """
            Not Acceptable: synthetic rejection
            Authorization: missing; upstream response: invalid origin
            Authorization: Basic c3ludGhldGljOnNlY3JldA==
            Cookie: session=synthetic-cookie
            password=synthetic-password token=synthetic-token
            request body: synthetic-request-payload
            Basic Tee; Cookie: Chocolate Chip; Bearer of the synthetic parcel
            Secret: order; Token: delivered; password=$1
            \(String(repeating: "x", count: 4000)) SQLSTATE 53300
            """
        let output = CLI.apiErrorMessage(
            .decode(status: 406, operationID: "shippingRecord.record", body: Data(text.utf8)))
        for secret in [
            "c3ludGhldGljOnNlY3JldA==", "synthetic-cookie", "synthetic-password", "synthetic-token",
            "synthetic-request-payload",
        ] {
            #expect(!output.contains(secret))
        }
        #expect(output.contains("Not Acceptable: synthetic rejection"))
        #expect(output.contains("Authorization: missing; upstream response: invalid origin"))
        #expect(output.contains("SQLSTATE 53300"))
        #expect(output.contains("Basic Tee; Cookie: Chocolate Chip; Bearer of the synthetic parcel"))
        #expect(output.contains("Secret: order; Token: delivered; password=$1"))
    }

    @Test func bodylessAndConstructedErrorsKeepUsefulDetails() {
        let bodyless = CLI.apiErrorMessage(
            .init(status: 406, operationID: "shippingRecord.record", detail: nil))
        #expect(bodyless.contains("HTTP 406 HTTP_ERROR: Request failed"))
        #expect(bodyless.contains("shippingRecord.record"))

        let constructed = CLI.apiErrorMessage(
            .init(
                status: 409, operationID: "shippingRecord.record",
                detail: .init(
                    code: "CONFLICT", message: "Synthetic conflict", reason: "EVIDENCE_CONFLICT",
                    requestId: "req_synthetic",
                    validationIssues: [
                        .init(code: "custom", path: ["reference"], message: "Conflicting reference")
                    ])
            ))
        #expect(constructed.contains("EVIDENCE_CONFLICT"))
        #expect(constructed.contains("req_synthetic"))
        #expect(constructed.contains("Conflicting reference"))
    }

    @Test func signedURLsAndUnlabelledCredentialsAreScrubbedThroughEscapedStrings() throws {
        let vendorKeys = [
            "sk-" + String(repeating: "a", count: 24),
            "sk-ant-" + String(repeating: "b", count: 24),
            "rk_live_" + String(repeating: "c", count: 20),
            "ghp_" + String(repeating: "d", count: 32),
            "github_pat_" + String(repeating: "e", count: 32),
            "AKIA" + String(repeating: "F", count: 16),
            "AIza" + String(repeating: "g", count: 35),
            "xoxb-" + String(repeating: "h", count: 12),
            "eyJsyntheticHeader.eyJsyntheticPayload.syntheticSignature",
        ]
        let url =
            "https://example.invalid/object?X-Amz-Signature=synthetic-signature&X-Amz-Credential=synthetic-credential&nextPageToken=synthetic-page&cursor_token=synthetic-cursor"
        let nested = String(
            decoding: try JSONEncoder().encode(
                #"{"pass\u0077ord":"synthetic-escaped-secret","message":"nested diagnostic"}"#), as: UTF8.self
        )
        let text = ([url, "failure: \(nested)"] + vendorKeys).joined(separator: "\n")
        let json = try JSONSerialization.data(withJSONObject: ["code": "REFUSED", "message": text])
        for body in [Data(text.utf8), json] {
            let output = CLI.apiErrorMessage(
                .decode(status: 406, operationID: "shippingRecord.record", body: body))
            for secret in vendorKeys + [
                "synthetic-signature", "synthetic-credential", "synthetic-escaped-secret",
            ] {
                #expect(!output.contains(secret))
            }
            #expect(output.contains("nextPageToken=synthetic-page"))
            #expect(output.contains("cursor_token=synthetic-cursor"))
            #expect(output.contains("nested diagnostic"))
        }
    }

    @Test func upstreamResponseBodiesSurviveWhileRequestBodiesAreRedacted() throws {
        let responseText =
            String(repeating: "synthetic upstream response ", count: 100)
            + "SQLSTATE 22003 password=synthetic-upstream-secret"
        let body = try JSONSerialization.data(withJSONObject: [
            "code": "UPSTREAM_ERROR", "message": "Synthetic rejection",
            "diagnostics": [
                "http": [
                    "body": responseText,
                    "response": [
                        "body": [
                            "input": "upstream input diagnostic", "payload": "upstream payload diagnostic",
                        ]
                    ],
                    "request": [
                        "method": "POST", "content": ["body": "synthetic-private-body"],
                        "input": "synthetic-private-input",
                    ],
                ]
            ],
        ])
        let output = CLI.apiErrorMessage(
            .decode(status: 502, operationID: "shippingRecord.record", body: body))
        #expect(output.contains(String(repeating: "synthetic upstream response ", count: 100)))
        #expect(output.contains("SQLSTATE 22003"))
        #expect(output.contains("upstream input diagnostic"))
        #expect(output.contains("upstream payload diagnostic"))
        #expect(output.contains("POST"))
        #expect(!output.contains("synthetic-upstream-secret"))
        #expect(!output.contains("synthetic-private-body"))
        #expect(!output.contains("synthetic-private-input"))
    }
}
