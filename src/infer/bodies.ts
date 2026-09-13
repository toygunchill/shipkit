import type { Inferred, SectionSkeleton } from "./types.js";

// A line made of nothing but a bullet marker or stray punctuation (e.g. "-", "---", "* ")
// recurs in every template for structural reasons, not because anyone typed it.
const PUNCTUATION_ONLY = /^[-*+>~`_.,;:!?|=]+$/;

function candidateLines(body: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue; // a heading recurring is structure, not boilerplate
    if (PUNCTUATION_ONLY.test(line)) continue;
    lines.add(line);
  }
  return lines;
}

export function boilerplateLines(bodies: string[], atLeast: number): Inferred<string[]> {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    // A Set per body so a line repeated within one body still counts once — ten
    // repeats in a single PR is not ten pieces of evidence that it's a template.
    for (const line of candidateLines(body)) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  const value = [...counts.entries()]
    .filter(([, count]) => count >= atLeast)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([line]) => line);

  const topCount = value.length > 0 ? counts.get(value[0])! : 0;
  const why = `appears verbatim in ${topCount} of ${bodies.length} bodies`;

  return { value, provenance: "observed", why };
}

function headingsOf(body: string): string[] {
  const headings: string[] = [];
  for (const raw of body.split("\n")) {
    const match = /^##\s+(.+)$/.exec(raw.trim());
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

function median(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function sectionSkeleton(bodies: string[]): Inferred<SectionSkeleton[]> {
  if (bodies.length === 0) {
    return { value: [], provenance: "observed", why: "no bodies to infer a skeleton from" };
  }

  const counts = new Map<string, number>();
  const firstAppearances = new Map<string, number[]>();

  for (const body of bodies) {
    const headings = headingsOf(body);
    const seen = new Set<string>();
    headings.forEach((name, index) => {
      if (seen.has(name)) return;
      seen.add(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const positions = firstAppearances.get(name) ?? [];
      positions.push(index);
      firstAppearances.set(name, positions);
    });
  }

  const names = [...counts.keys()].sort(
    (a, b) => median(firstAppearances.get(a)!) - median(firstAppearances.get(b)!),
  );

  const value: SectionSkeleton[] = names.map((name) => ({
    name,
    required: counts.get(name)! / bodies.length >= 0.8,
  }));

  const why = `${value.length} heading(s) observed across ${bodies.length} bodies`;

  return { value, provenance: "observed", why };
}
