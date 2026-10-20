import CubbyAPISupport
import Foundation
import Testing

@testable import CubbyKit

struct MutationResultTests {
    // Both generated response names must use the shared carrier, retain required keys,
    // and tolerate response additions from a newer server.
    @Test func generatedResultsShareCarrierAndKeepResponseContract() throws {
        let data = Data(#"{"items":[],"sideEffects":{},"future":true}"#.utf8)
        let task: MutationResult<TaskOut, MutationSideEffects> = try JSONDecoder().decode(
            TaskBulkMutationOut.self, from: data)
        let inventory: MutationResult<InventoryWithLocationAndProductOut, MutationSideEffects> =
            try JSONDecoder().decode(InventoryWithLocationAndProductListAndSideEffectsOut.self, from: data)
        #expect(task.items.isEmpty)
        #expect(inventory.items.isEmpty)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(TaskBulkMutationOut.self, from: Data(#"{"items":[]}"#.utf8))
        }
    }
}
