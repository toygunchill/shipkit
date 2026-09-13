import type { Inferred } from "./types.js";

export type JiraGuess = { baseUrl?: string; keyPattern?: string };

// A Jira browse link: an origin plus some path prefix (often "/jira"), then
// "/browse/<KEY>", where KEY is a project prefix followed by "-" and a number.
// The base URL is everything before "/browse/"; matched lazily so it stops at
// the first "/browse/" rather than swallowing one from later in the string.
const BROWSE_LINK = /(https?:\/\/[^\s]+?)\/browse\/([^\s/]+)/g;

// Split a browse key into its project prefix and issue number: the number is
// whatever digits trail the last hyphen, so a prefix containing its own
// hyphens (or, per the test fixtures, a stray ".") still separates cleanly.
const KEY_SHAPE = /^(.*)-(\d+)$/;

// Escape a project prefix before it goes into a pattern that configSchema
// will compile: an unescaped regex metacharacter in the prefix (a literal
// "." is a real Jira project key we've seen) would otherwise produce a
// pattern that is invalid or that matches keys it has no business matching.
function escapeForPattern(prefix: string): string {
  return prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inferJira(bodies: string[]): Inferred<JiraGuess> {
  const baseUrlCounts = new Map<string, number>();
  const prefixesByBaseUrl = new Map<string, Set<string>>();

  for (const body of bodies) {
    for (const match of body.matchAll(BROWSE_LINK)) {
      const baseUrl = match[1];
      const key = match[2];
      const shape = KEY_SHAPE.exec(key);
      if (!shape) continue;
      const prefix = shape[1];

      baseUrlCounts.set(baseUrl, (baseUrlCounts.get(baseUrl) ?? 0) + 1);
      const prefixes = prefixesByBaseUrl.get(baseUrl) ?? new Set<string>();
      prefixes.add(prefix);
      prefixesByBaseUrl.set(baseUrl, prefixes);
    }
  }

  if (baseUrlCounts.size === 0) {
    return {
      value: {},
      provenance: "observed",
      why: `no Jira browse links found in ${bodies.length} body(ies)`,
    };
  }

  // Take the base URL most bodies agree on, not the first one seen.
  const [winningBaseUrl, winningCount] = [...baseUrlCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0];

  const prefixes = [...(prefixesByBaseUrl.get(winningBaseUrl) ?? [])].sort();
  const escaped = prefixes.map(escapeForPattern);
  const keyPattern = escaped.length === 1 ? `${escaped[0]}-\\d+` : `(${escaped.join("|")})-\\d+`;

  const why =
    `${winningCount} link(s) to ${winningBaseUrl} observed across ${bodies.length} body(ies), ` +
    `covering ${prefixes.length} project prefix(es): ${prefixes.join(", ")}`;

  return {
    value: { baseUrl: winningBaseUrl, keyPattern },
    provenance: "observed",
    why,
  };
}
