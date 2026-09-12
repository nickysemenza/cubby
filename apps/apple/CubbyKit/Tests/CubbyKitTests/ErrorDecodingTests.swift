import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import CubbyKit

@Suite("CubbyAPIError decoding")
struct ErrorDecodingTests {
    @Test func status401IsUnauthorized() throws {
        let error = CubbyAPIError.decode(
            status: 401, operationID: "resources.product.get",
            body: try Fixtures.data(named: "error-unauthorized.json")
        )
        #expect(error.isUnauthorized)
        #expect(error.detail?.code == "UNAUTHORIZED")
        #expect(error.detail?.reason == "invalid_session")
        #expect(error.detail?.requestId == "req_sample123")
    }

    @Test func status409WithInventoryStaleReasonIsStaleInventory() throws {
        let error = CubbyAPIError.decode(
            status: 409, operationID: "inventory.reconcileSession",
            body: try Fixtures.data(named: "reconcile-stale.json")
        )
        #expect(error.isStaleInventory)
        #expect(error.reason == "INVENTORY_STALE")
        #expect(!error.isUnauthorized)
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

    @Test func anHTMLBodyDecodesToANilDetail() throws {
        let error = CubbyAPIError.decode(
            status: 502, operationID: "resources.product.list",
            body: try Fixtures.data(named: "error-html-502.txt")
        )
        #expect(error.status == 502)
        #expect(error.detail == nil)
        #expect(!error.isUnauthorized)
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
