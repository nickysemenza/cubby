import Testing

@testable import CubbyKit

/// Delayed inference/Apply must remain bound to the request and mounted editor that requested it.
@Suite("Field suggestion review scope")
struct FieldSuggestionReviewScopeTests {
    @Test func newerRequestRevokesEarlierResponseEvenWithSameCandidate() {
        var scope = FieldSuggestionReviewScope()
        let first = scope.beginRequest()
        let second = scope.beginRequest()
        #expect(!scope.accepts(first))
        #expect(scope.accepts(second))
    }

    @Test func dismissedOrDifferentEditorRejectsInFlightAcceptance() {
        var firstEditor = FieldSuggestionReviewScope()
        let request = firstEditor.beginRequest()
        let secondEditor = FieldSuggestionReviewScope()
        #expect(!secondEditor.accepts(request))
        firstEditor.invalidate()
        #expect(!firstEditor.accepts(request))
        #expect(!firstEditor.accepts(firstEditor.beginRequest()))
    }
}
