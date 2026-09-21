import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import CubbyKit

@Suite("CubbyAPIError decoding")
struct ErrorDecodingTests {
    /// 401 and 409 decode to different detail shapes; share the decode + fixture plumbing and
    /// keep each status's distinct assertions named under one case.
    private enum ExpectedError: Sendable {
        case unauthorized(code: String, reason: String, requestId: String)
        case staleInventory(reason: String)
    }

    @Test(
        "status-coded errors decode to the right category and detail",
        arguments: [
            (
                401, "resources.product.get", "error-unauthorized.json",
                ExpectedError.unauthorized(
                    code: "UNAUTHORIZED", reason: "invalid_session", requestId: "req_sample123")
            ),
            (
                409, "inventory.reconcileSession", "reconcile-stale.json",
                ExpectedError.staleInventory(reason: "INVENTORY_STALE")
            ),
        ]
    )
    private func statusCodedErrorsDecode(
        status: Int, operationID: String, fixture: String, expected: ExpectedError
    ) throws {
        let error = CubbyAPIError.decode(
            status: status, operationID: operationID, body: try Fixtures.data(named: fixture))
        switch expected {
        case .unauthorized(let code, let reason, let requestId):
            #expect(error.isUnauthorized)
            #expect(error.detail?.code == code)
            #expect(error.detail?.reason == reason)
            #expect(error.detail?.requestId == requestId)
        case .staleInventory(let reason):
            #expect(error.isStaleInventory)
            #expect(error.reason == reason)
            #expect(!error.isUnauthorized)
        }
    }

    @Test func staleInventoryRequiresADetailEvenAt409() {
        #expect(!CubbyAPIError(status: 409, operationID: "x", detail: nil).isStaleInventory)
    }

    @Test func status400DecodesValidationIssues() throws {
        let error = CubbyAPIError.decode(
            status: 400, operationID: "resources.product.create",
            body: try Fixtures.data(named: "error-validation.json")
        )
        #expect(error.detail?.code == "VALIDATION_ERROR")
        let issues = try #require(error.detail?.validationIssues)
        #expect(issues.count == 1)
        #expect(issues[0].code == "invalid_type")
        #expect(issues[0].path == ["name"])
        #expect(issues[0].message == "Sample field error")
    }

    @Test func diagnosticExtensionsPreserveCausesAndLinks() throws {
        let body = Data(
            #"{"code":"INTERNAL_SERVER_ERROR","message":"Connection limit exceeded","diagnostics":{"origin":"server","operation":"entity.list","stage":"run","causes":[{"name":"Error","message":"Connection limit exceeded","code":"53300"}],"sentryEventId":"sample-event","sentryUrl":"https://example.invalid/event","cfRayId":"sample-ray"}}"#
                .utf8)
        let error = CubbyAPIError.decode(status: 500, operationID: "entity.list", body: body)
        let detail = try #require(error.detail)
        #expect(detail.diagnostics?.causes.first?.code == "53300")
        #expect(detail.diagnostics?.sentryEventId == "sample-event")
        #expect(detail.diagnostics?.cfRayId == "sample-ray")
    }

    @Test func malformedOptionalDiagnosticsDoNotDiscardTheMessage() {
        let body = Data(
            #"{"code":"INTERNAL_SERVER_ERROR","message":"Operation failed","diagnostics":{"causes":42}}"#.utf8
        )
        let error = CubbyAPIError.decode(status: 500, operationID: "entity.list", body: body)
        #expect(error.detail?.message == "Operation failed")
        #expect(error.detail?.diagnostics == nil)
    }

    @Test func anHTMLBodyDecodesToANilDetail() throws {
        let error = CubbyAPIError.decode(
            status: 502, operationID: "resources.product.list",
            body: try Fixtures.data(named: "error-html-502.txt")
        )
        #expect(error.status == 502)
        #expect(error.detail == nil)
        #expect(!error.isUnauthorized)
    }

    @Test func localizedDescriptionUsesTheServerMessage() {
        let error = CubbyAPIError(
            status: 500, operationID: "photoImport.commit",
            detail: .init(
                code: "INTERNAL_SERVER_ERROR",
                message: "The photo batch could not be added.",
                requestId: "req_sample123")
        )

        #expect(error.localizedDescription == "The photo batch could not be added.")
        #expect(error.failureReason == "Request req_sample123")
        #expect(error.recoverySuggestion == "Try again. If this continues, contact support.")
    }

    @Test func bodylessErrorsStillHaveUsefulLocalizedText() {
        let error = CubbyAPIError(status: 503, operationID: "photoImport.commit", detail: nil)

        #expect(error.localizedDescription == "Cubby could not complete this request (HTTP 503).")
        #expect(error.failureReason == "photoImport.commit")
        #expect(error.recoverySuggestion == "Try again. If this continues, contact support.")
    }

    /// OpenAPIRuntime wraps every middleware throw in a `ClientError`, which would otherwise hide
    /// the `isUnauthorized`/`isStaleInventory` a caller switches on. `CubbyClient` always unwraps;
    /// this pins the unwrap itself for a caller (`CubbyDebugClient`, the CLI) that talks to a raw
    /// generated `Client` and middleware directly.
    @Test func unwrappingPullsTheCubbyAPIErrorOutOfAClientError() throws {
        let inner = CubbyAPIError(
            status: 409, operationID: "inventory.reconcileSession",
            detail: .init(code: "CONFLICT", message: "stale", reason: "INVENTORY_STALE")
        )
        let wrapped = ClientError(
            operationID: "inventory.reconcileSession", operationInput: (),
            causeDescription: "middleware threw", underlyingError: inner
        )
        let unwrapped = CubbyAPIError.unwrapping(wrapped)
        let apiError = try #require(unwrapped as? CubbyAPIError)
        #expect(apiError.isStaleInventory)
    }

    /// A transport failure that never reached `CubbyAuthMiddleware` (so never became a
    /// `CubbyAPIError`) still carries a status when the response was received; unwrapping turns
    /// that into a bodyless `CubbyAPIError` instead of leaking the raw `ClientError`.
    @Test func unwrappingATransportFailureWithAStatusBecomesABodylessError() throws {
        let wrapped = ClientError(
            operationID: "resources.product.get", operationInput: (),
            response: HTTPResponse(status: 503),
            causeDescription: "transport failure", underlyingError: URLError(.timedOut)
        )
        let unwrapped = CubbyAPIError.unwrapping(wrapped)
        let apiError = try #require(unwrapped as? CubbyAPIError)
        #expect(apiError.status == 503)
        #expect(apiError.detail == nil)
    }

    @Test func unwrappingLeavesAnUnrelatedErrorUntouched() {
        let error = URLError(.notConnectedToInternet)
        let unwrapped = CubbyAPIError.unwrapping(error)
        #expect((unwrapped as? URLError) == error)
    }
}
