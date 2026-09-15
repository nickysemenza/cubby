import Foundation

/// The text being edited in an inventory adjustment. Parsing stays derived from the current
/// text so Save can never commit a value left over from an earlier valid draft.
struct AdjustmentQuantityDraft {
    var text: String
    let locale: Locale

    init(value: Double, locale: Locale = .current) {
        self.locale = locale
        text = Self.format(value, locale: locale)
    }

    init(text: String, locale: Locale = .current) {
        self.text = text
        self.locale = locale
    }

    var value: Double? {
        let candidate = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty, let number = Self.formatter(locale: locale).number(from: candidate) else {
            return nil
        }
        let value = number.doubleValue
        return value.isFinite && value > 0 ? value : nil
    }

    private static func format(_ value: Double, locale: Locale) -> String {
        formatter(locale: locale).string(from: NSNumber(value: value)) ?? String(value)
    }

    private static func formatter(locale: Locale) -> NumberFormatter {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.isLenient = false
        // `NSDecimalNumber.doubleValue` can land on a neighboring binary Double even when the
        // decimal text is the exact shortest representation. NSNumber parsing round-trips that
        // representation while NumberFormatter still enforces the locale and consumes all input.
        formatter.generatesDecimalNumbers = false
        formatter.usesGroupingSeparator = false
        formatter.usesSignificantDigits = true
        formatter.maximumSignificantDigits = 17
        return formatter
    }
}
