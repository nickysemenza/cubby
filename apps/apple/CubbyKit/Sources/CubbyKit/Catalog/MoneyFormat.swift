import Foundation

/// The one US-dollar format: all money is `SUM(Expense.cost)` in USD. `Text(x, format: .usd)`,
/// `x.formatted(.usd)`, or `x.usd` for a plain string.
extension FormatStyle where Self == FloatingPointFormatStyle<Double>.Currency {
    public static var usd: Self { .currency(code: "USD") }
}

extension FormatStyle where Self == Decimal.FormatStyle.Currency {
    public static var usd: Self { .currency(code: "USD") }
}

extension Double {
    public var usd: String { formatted(.usd) }
}
