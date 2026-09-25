import Foundation

/// Which pull requests in the list want a second look before they are approved.
///
/// A reviewer works down a flat list, and a routine feature branch looks exactly like a
/// change going into something guarded until you open it. The mark exists so the ones with
/// more behind them are visible while scanning, not after clicking.
///
/// It is the **base** that decides, which is worth stating because the first version of
/// this had it backwards. Reading the real list settled it: nothing merges *out of* a
/// protected branch in ordinary work — the rows are `feature/… → protected/…` and
/// `release/… → main`. Where a change lands is what makes it consequential.
public enum Protection {
    /// Bases that are guarded because the branch itself is, by this convention.
    static let protectedBasePrefixes = ["protected/"]
    /// Bases where a mistake reaches users rather than another review.
    static let shippingBasePrefixes = ["release/", "hotfix/"]
    static let shippingBases = ["master", "main"]

    /// Why this pull request is marked, or `nil` when it is ordinary.
    ///
    /// One sentence, shown on hover, naming the branch. A mark whose meaning has to be
    /// guessed is a mark people learn to ignore, and the two reasons ask different things
    /// of whoever is reading the diff.
    public static func reason(base: String?) -> String? {
        let base = base?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if base.isEmpty { return nil }

        if protectedBasePrefixes.contains(where: base.hasPrefix) {
            return "Into \(base), a protected branch"
        }
        if shippingBasePrefixes.contains(where: base.hasPrefix) || shippingBases.contains(base) {
            return "Into \(base), where a mistake ships"
        }
        return nil
    }
}
