import type { Inferred } from "./types.js";

export type JiraGuess = { baseUrl?: string; keyPattern?: string };

// A Jira browse link: an origin plus some path prefix (often "/jira"), then
// "/browse/<KEY>", where KEY is a project prefix followed by "-" and a number.
// The base URL is everything before "/browse/"; matched lazily so it stops at
// the first "/browse/" rather than swallowing one from later in the string.
//
// Both halves are bounded rather than running to the next space, because in a
// real pull-request body a link is almost never bare. It is wrapped —
// "[ABC-1](…/browse/ABC-1)", "<…/browse/ABC-1>", backticked — or it ends a
// sentence, or it carries "?focusedId=9". A key allowed to run to the next
// space swallows the closing bracket or the full stop and then no longer looks
// like a key at all, which is how the markdown form, the commonest citation
// shape there is, went unseen.
//
// So the issue number is matched inline, ending the key: whatever follows it is
// simply not part of the match. The prefix may hold "-" and "." because both
// occur in real project keys ("MY-PROJ-12", and a literal "." we have seen);
// the greedy prefix backtracks to the last "-<digits>", which is what separates
// them. The scheme is matched case-insensitively — a shouted "HTTPS://" is the
// same link.
const BROWSE_LINK =
  /(https?:\/\/[^\s<>"'`()[\]]+?)\/browse\/([\p{L}][\p{L}\p{N}_.-]*)-(\d+)/giu;

// Scheme and host are case-insensitive (RFC 3986 §3.1, §3.2.2); a path is not.
// Folding them keeps "HTTPS://Host/jira" and "https://host/jira" from splitting
// one instance's vote in two — and keeps whichever spelling won out of the file.
function normaliseOrigin(url: string): string {
  return url.replace(/^[^/]*\/\/[^/]*/, (origin) => origin.toLowerCase());
}

// Escape a project prefix before it goes into a pattern that configSchema
// will compile: an unescaped regex metacharacter in the prefix (a literal
// "." is a real Jira project key we've seen) would otherwise produce a
// pattern that is invalid or that matches keys it has no business matching.
function escapeForPattern(prefix: string): string {
  return prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inferJira(bodies: string[]): Inferred<JiraGuess> {
  // How many *bodies* cite each base URL, not how many links they hold. One
  // epic rollup listing thirty links to an archived instance is one person's
  // pull request; twenty ordinary ones citing the live instance are the
  // convention. Counting links lets the rollup outvote all twenty and hands
  // `check` a baseUrl that rejects every real ticket.
  const bodyCounts = new Map<string, number>();
  const prefixesByBaseUrl = new Map<string, Set<string>>();

  for (const body of bodies) {
    const countedHere = new Set<string>();
    for (const match of body.matchAll(BROWSE_LINK)) {
      const baseUrl = normaliseOrigin(match[1]);
      const prefix = match[2];

      if (!countedHere.has(baseUrl)) {
        countedHere.add(baseUrl);
        bodyCounts.set(baseUrl, (bodyCounts.get(baseUrl) ?? 0) + 1);
      }
      const prefixes = prefixesByBaseUrl.get(baseUrl) ?? new Set<string>();
      prefixes.add(prefix);
      prefixesByBaseUrl.set(baseUrl, prefixes);
    }
  }

  if (bodyCounts.size === 0) {
    return {
      value: {},
      provenance: "observed",
      why: `no Jira browse links found in ${bodies.length} body(ies)`,
    };
  }

  // Take the base URL most bodies agree on, not the first one seen. Ties go to
  // the one seen first, which Array.prototype.sort preserves.
  const [winningBaseUrl, winningCount] = [...bodyCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const prefixes = [...(prefixesByBaseUrl.get(winningBaseUrl) ?? [])].sort();
  const escaped = prefixes.map(escapeForPattern);
  const keyPattern = escaped.length === 1 ? `${escaped[0]}-\\d+` : `(${escaped.join("|")})-\\d+`;

  const why =
    `${winningCount} of ${bodies.length} body(ies) link ${winningBaseUrl}, ` +
    `covering ${prefixes.length} project prefix(es): ${prefixes.join(", ")}`;

  return {
    value: { baseUrl: winningBaseUrl, keyPattern },
    provenance: "observed",
    why,
  };
}
