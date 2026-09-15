import Foundation
import Testing

@testable import Cubby

@Suite("Entity fact formatting")
struct EntityFactsTests {
    @Test func dateOnlyValueKeepsItsCalendarDay() {
        let rendered = EntityFacts.formattedDate(
            "2039-05-10",
            locale: Locale(identifier: "en_US")
        )

        #expect(rendered == "May 10, 2039")
    }
}
