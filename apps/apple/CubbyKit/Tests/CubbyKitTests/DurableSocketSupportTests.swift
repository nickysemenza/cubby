import Foundation
import Testing

@testable import CubbyKit

@Suite("Authenticated socket support")
struct DurableSocketSupportTests {
    @Test(
        "Expected URLSession disconnects remain reconnect-only",
        arguments: [
            URLError.Code.cancelled,
            .timedOut,
            .networkConnectionLost,
            .notConnectedToInternet,
        ])
    func expectedURLFailures(code: URLError.Code) {
        #expect(AuthenticatedSocketSupport.isExpectedReconnectFailure(URLError(code)))
    }

    @Test func socketNotConnectedRemainsReconnectOnly() {
        let error = NSError(
            domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.ENOTCONN.rawValue))

        #expect(AuthenticatedSocketSupport.isExpectedReconnectFailure(error))
    }

    @Test func wrappedSocketNotConnectedRemainsReconnectOnly() {
        let socketError = NSError(
            domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.ENOTCONN.rawValue))
        let wrapped = NSError(
            domain: "DurableSocketSupportTests.Wrapper", code: 1,
            userInfo: [NSUnderlyingErrorKey: socketError])

        #expect(AuthenticatedSocketSupport.isExpectedReconnectFailure(wrapped))
    }

    @Test(
        "Actionable failures remain reportable",
        arguments: [
            URLError.Code.userAuthenticationRequired,
            .badServerResponse,
            .cannotDecodeRawData,
            .cannotDecodeContentData,
            .cannotConnectToHost,
            .cannotFindHost,
        ])
    func actionableURLFailures(code: URLError.Code) {
        #expect(!AuthenticatedSocketSupport.isExpectedReconnectFailure(URLError(code)))
    }

    @Test func connectionRefusedRemainsReportable() {
        let error = NSError(
            domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.ECONNREFUSED.rawValue))

        #expect(!AuthenticatedSocketSupport.isExpectedReconnectFailure(error))
    }

    @Test func outboxFailureRemainsReportable() {
        let error = NSError(domain: "SyntheticOutbox", code: 1)

        #expect(!AuthenticatedSocketSupport.isExpectedReconnectFailure(error))
    }
}
