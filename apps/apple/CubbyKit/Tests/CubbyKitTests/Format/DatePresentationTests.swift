import Foundation
import Testing

@testable import CubbyKit

/// Failure modes: date-only values shifting through UTC; elapsed-hour comparisons crossing DST;
/// future values losing their sign; minutes and months sharing an ambiguous abbreviation;
/// display text ignoring the person's locale or 24-hour clock.
@Suite("DatePresentation")
struct DatePresentationTests {
    private static let english = Locale(identifier: "en_US")
    private func instant(_ value: String) -> Date { DatePresentation.parse(value)! }

    @Test func calendarDaysRemainHouseholdDaysAcrossDST() {
        let now = instant("2026-03-09T06:30:00Z")
        let today = DatePresentation.plainDate("2026-03-08", now: now, locale: Self.english)!
        #expect(today.absolute == "Mar 8, 2026")
        #expect(today.relative == "today")
        #expect(DatePresentation.plainDate("2026-03-07", now: now)?.relative == "yesterday")
        #expect(DatePresentation.plainDate("2026-03-09", now: now)?.relative == "tomorrow")
        #expect(DatePresentation.plainDate("2026-03-01", now: now)?.relative == "7 days ago")
    }

    @Test func instantsUseHouseholdZoneAndFutureDirection() {
        let now = instant("2026-10-13T18:52:00Z")
        let value = DatePresentation.timestamp(
            instant("2026-10-13T18:50:00Z"), now: now, locale: Self.english)
        #expect(value.absolute == "Oct 13, 2026 at 11:50\u{202F}AM")
        #expect(value.relative == "2 minutes ago")
        #expect(
            DatePresentation.timestamp(now.addingTimeInterval(-8 * 86400), now: now).relative == "8 days ago")
        #expect(
            DatePresentation.timestamp(now, now: now, compact: true, locale: Self.english).absolute
                == "Oct 13")
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
        #expect(
            DatePresentation.plainDate("2025-10-13", now: now, compact: true, locale: Self.english)?.absolute
                == "Oct 13, 2025")
        #expect(
            DatePresentation.plainDate("2026-10-13", now: now, compact: true, locale: Self.english)?.absolute
                == "Oct 13")
        #expect(DatePresentation.plainDate("2026-02-30", now: now) == nil)
    }
    // The capture offset must reconstruct the camera's local day and clock, rather than
    // label a household-zone clock with a different offset. Half-hour zones retain minutes.
    @Test func captureProvenanceUsesRecordedOffset() {
        let date = instant("2026-10-13T23:50:24Z")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: 120, locale: Self.english)
                == "Oct 14, 2026 at 1:50:24\u{202F}AM (+02:00)")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: -210, locale: Self.english)
                == "Oct 13, 2026 at 8:20:24\u{202F}PM (-03:30)")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: 0, locale: Self.english)
                == "Oct 13, 2026 at 11:50:24\u{202F}PM (+00:00)")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: nil, locale: Self.english)
                == DatePresentation.timestamp(date, locale: Self.english).exact)
    }

    // Display text follows the person's locale and clock; only the household zone is fixed.
    @Test func displayFollowsLocaleAndHourCycle() {
        let now = instant("2026-10-13T18:52:00Z")
        let date = instant("2026-10-13T18:50:24Z")
        var components = Locale.Components(identifier: "en_US")
        components.hourCycle = .zeroToTwentyThree
        let twentyFourHour = Locale(components: components)
        #expect(DatePresentation.absolute(date, now: now, locale: twentyFourHour) == "Oct 13, 2026 at 11:50")
        let british = Locale(identifier: "en_GB")
        #expect(DatePresentation.absolute(date, now: now, compact: true, locale: british) == "13 Oct")
        #expect(
            DatePresentation.plainDate("2026-10-13", now: now, locale: british)?.absolute == "13 Oct 2026")
        #expect(
            DatePresentation.captureTimestamp(date, offsetMinutes: 120, locale: twentyFourHour)
                == "Oct 13, 2026 at 20:50:24 (+02:00)")
    }
}
