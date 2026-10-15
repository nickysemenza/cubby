import Foundation
import Testing

@testable import CubbyKit

struct ProductVariantDecodingTests {
    @Test func retainsUnresolvedRelationsAndOriginalTitleEvidence() throws {
        let data = Data(
            """
            {"color":{"relation":"unknown"},"size":{"relation":"different"},
             "evidence":{"firstTitle":"Synthetic shirt, medium","secondTitle":"Synthetic shirt, large"}}
            """.utf8)
        let value = try JSONDecoder.cubby().decode(ProductVariantComparison.self, from: data)
        #expect(value.color.relation == .unknown)
        #expect(value.size.relation == .different)
        #expect(value.evidence.firstTitle == "Synthetic shirt, medium")
        #expect(value.evidence.secondTitle == "Synthetic shirt, large")
    }
}
