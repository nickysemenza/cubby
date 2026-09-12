import Testing

@testable import CubbyKit

@Suite("CubbyKitInfo")
struct CubbyKitInfoTests {
    @Test("version is set")
    func versionIsSet() {
        #expect(!CubbyKitInfo.version.isEmpty)
    }
}
