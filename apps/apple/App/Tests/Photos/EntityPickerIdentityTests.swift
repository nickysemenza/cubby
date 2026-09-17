import Testing

@testable import Cubby

@MainActor
@Suite("Entity picker identities")
struct EntityPickerIdentityTests {
    @Test func selectedAndResultRowsAreDistinctForTheSameRecord() {
        let pick = EntityPick(id: "PRD-TEST", title: "Example")

        #expect(pick.selectedRowIdentity != pick.resultRowIdentity)
        #expect(pick.resultRowIdentity == .result("PRD-TEST"))
    }
}
