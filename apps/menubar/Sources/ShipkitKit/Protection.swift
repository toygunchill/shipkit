import Foundation

/// Which pull requests in the list are merging a shared branch somewhere.
///
/// A long-lived branch several people have been building on is a different thing from one
/// person's feature: it carries other people's work, it has usually been open for weeks,
/// and merging it moves all of that at once. The list is flat, so it looks like every other
/// row until you open it. The mark is there so it does not.
///
/// It is the **head** that decides — what is being merged, not where it is going. That took
/// two wrong turns to settle, so the reasoning is written down rather than left implied:
///
/// - The first version marked the head on no evidence.
/// - The second marked the base, because the live list was full of `feature/… →
///   protected/…` and that looked like the pattern. It is a pattern, but the ordinary one:
///   those are people adding work *to* a shared branch, which is routine and would have
///   marked half the list.
/// - The rows that want a second look are the other direction —
///   `protected/flyhigh/20104-brand-identity → develop` and `release/3.77.0 → main` —
///   where the shared branch is the thing being moved.
public enum Protection {
    /// Branch prefixes for work several people share, by this repository's convention.
    static let sharedPrefixes = ["protected/", "release/", "hotfix/"]

    /// Why this pull request is marked, or `nil` when it is ordinary.
    ///
    /// Names both branches: which shared branch, and where it is going. A mark whose
    /// meaning has to be guessed is a mark people learn to ignore.
    public static func reason(head: String?, base: String? = nil) -> String? {
        let head = head?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard sharedPrefixes.contains(where: head.hasPrefix) else { return nil }

        let base = base?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return base.isEmpty ? "Merging \(head), a shared branch" : "Merging \(head) into \(base)"
    }
}
