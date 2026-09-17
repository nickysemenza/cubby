import CubbyKit
import Testing

@testable import Cubby

@MainActor
@Suite("Photo destination options")
struct PhotoDestinationOptionTests {
    @Test func rowsHaveUniqueIdentityAndSectionSpecificTitles() {
        let descriptor = EntityCatalog[.product]
        let create = PhotoDestinationOption(kind: .create, descriptor: descriptor)
        let existing = PhotoDestinationOption(kind: .existing, descriptor: descriptor)

        #expect(create.id != existing.id)
        #expect(create.title == "New Product")
        #expect(existing.title == "Products")
    }
}
