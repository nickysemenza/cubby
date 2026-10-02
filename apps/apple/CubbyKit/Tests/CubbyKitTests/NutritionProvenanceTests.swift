import Foundation
import Testing

@testable import CubbyKit

@Suite("Nutrition provenance compatibility")
struct NutritionProvenanceTests {
    @Test func legacyEstimatesAndInferredZerosRemainDistinct() throws {
        let decoder = JSONDecoder()
        let legacy = try decoder.decode(
            MeasureEstimate.self,
            from: Data(
                #"{"status":"complete","lower":0,"upper":null,"coverage":{"covered":1,"total":1}}"#.utf8))
        let inferred = try decoder.decode(
            MeasureEstimate.self,
            from: Data(
                #"{"status":"complete","lower":0,"upper":null,"coverage":{"covered":1,"total":1,"inferredZero":1}}"#
                    .utf8))
        let optOut = try decoder.decode(
            MeasureEstimate.self, from: Data(#"{"status":"unavailable","reason":"not_applicable"}"#.utf8))
        #expect(legacy.inferredZeroCount == 0)
        #expect(inferred.inferredZeroCount == 1)
        #expect(!legacy.isNotApplicable)
        #expect(optOut.isNotApplicable)
    }
}
