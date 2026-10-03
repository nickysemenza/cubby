import Foundation

/// The one US-dollar format: all money is `SUM(Expense.cost)` in USD, written in en-US (the web's
/// `formatCurrency`) whatever the device locale. `Text(x, format: .usd)`, `x.formatted(.usd)`, or
/// `x.usd` for a plain string.
extension FormatStyle where Self == FloatingPointFormatStyle<Double>.Currency {
    public static var usd: Self { .currency(code: "USD").locale(Locale(identifier: "en_US")) }
}

extension FormatStyle where Self == Decimal.FormatStyle.Currency {
    public static var usd: Self { .currency(code: "USD").locale(Locale(identifier: "en_US")) }
}

extension Double {
    public var usd: String { formatted(.usd) }
}
