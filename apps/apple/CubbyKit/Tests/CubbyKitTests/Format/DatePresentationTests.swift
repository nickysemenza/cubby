import Foundation
import Testing

@testable import CubbyKit

/// Failure modes: date-only values shifting through UTC; elapsed-hour comparisons crossing DST;
/// future values losing their sign; minutes and months sharing an ambiguous abbreviation.
@Suite("DatePresentation")
struct DatePresentationTests {
    private func instant(_ value: String) -> Date { DatePresentation.parse(value)! }

    @Test func calendarDaysRemainHouseholdDaysAcrossDST() {
        let now = instant("2026-03-09T06:30:00Z")
        let today = DatePresentation.plainDate("2026-03-08", now: now)!
        #expect(today.absolute == "Mar 8, 2026")
        #expect(today.relative == "today")
        #expect(DatePresentation.plainDate("2026-03-07", now: now)?.relative == "yesterday")
        #expect(DatePresentation.plainDate("2026-03-09", now: now)?.relative == "tomorrow")
        #expect(DatePresentation.plainDate("2026-03-01", now: now)?.relative == "7 days ago")
    }

    @Test func instantsUseHouseholdZoneAndFutureDirection() {
        let now = instant("2026-10-13T18:52:00Z")
        let value = DatePresentation.timestamp(instant("2026-10-13T18:50:00Z"), now: now)
        #expect(value.absolute == "Oct 13, 2026, 11:50 AM")
        #expect(value.relative == "2 minutes ago")
        #expect(
            DatePresentation.timestamp(now.addingTimeInterval(-8 * 86400), now: now).relative == "8 days ago")
        #expect(DatePresentation.timestamp(now, now: now, compact: true).absolute == "Oct 13")
        #expect(
            DatePresentation.timestamp(now.addingTimeInterval(180), now: now, compact: true).relative
                == "in 3 min")
        #expect(
            DatePresentation.timestamp(now.addingTimeInterval(-180), now: now, compact: true).relative
                == "3 min ago")
        #expect(DatePresentation.timestamp(now.addingTimeInterval(1), now: now).relative == "now")
    }

    @Test func compactMonthsAndOtherYearsRemainUnambiguous() {
        let now = instant("2026-10-13T18:52:00Z")
        #expect(
            DatePresentation.timestamp(now.addingTimeInterval(-90 * 86400), now: now, compact: true).relative
                == "3 mo ago")
        #expect(DatePresentation.plainDate("2025-10-13", now: now, compact: true)?.absolute == "Oct 13, 2025")
        #expect(DatePresentation.plainDate("2026-10-13", now: now, compact: true)?.absolute == "Oct 13")
        #expect(DatePresentation.plainDate("2026-02-30", now: now) == nil)
    }
    // The capture offset must reconstruct the camera's local day and clock, rather than
    // label a household-zone clock with a different offset. Half-hour zones retain minutes.
    @Test func captureProvenanceUsesRecordedOffset() {
        let date = instant("2026-10-13T23:50:24Z")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: 120)
                == "Oct 14, 2026, 1:50:24 AM (+02:00)")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: -210)
                == "Oct 13, 2026, 8:20:24 PM (-03:30)")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: 0)
                == "Oct 13, 2026, 11:50:24 PM (+00:00)")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: nil)
                == DatePresentation.timestamp(date).exact)
    }

}
