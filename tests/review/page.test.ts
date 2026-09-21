import { describe, expect, it } from "vitest";
import { escapeHtml, renderPage, type PageInput } from "../../src/review/page.js";
import type { ReviewItem } from "../../src/review/items.js";

const BASE: PageInput = {
  repo: "shipkit",
  branch: "bugfix/squad/1-invoice",
  base: "develop",
  commitMessage: "fix(invoice): stop double-charging",
  diffstat: " app.ts | 2 +-\n 1 file changed",
  items: [],
  files: [],
  answered: true,
  notes: [],
  token: "a".repeat(64),
  waitMinutes: 10,
};

function page(over: Partial<PageInput> = {}): string {
  return renderPage({ ...BASE, ...over });
}

const ITEM = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  kind: "warning",
  id: "untracked-files",
  message: "Staging will sweep in .env.local",
  severity: "warns",
  ...over,
});

describe("the page says what shipkit found", () => {
  it("carries the header facts a person needs to know what they are looking at", () => {
    const html = page();

    expect(html).toContain("shipkit");
    expect(html).toContain("bugfix/squad/1-invoice");
    expect(html).toContain("develop");
    expect(html).toContain("fix(invoice): stop double-charging");
    expect(html).toContain("1 file changed");
  });

  it("renders every finding with its kind, its id and its message", () => {
    const html = page({
      items: [
        ITEM({ kind: "finding", id: "title-pattern", message: "The title does not match", severity: "refuses" }),
        ITEM(),
        ITEM({ kind: "advice", id: "uikit-to-swiftui", message: "This looks like a conversion", severity: "informs" }),
      ],
    });

    expect(html).toContain("title-pattern");
    expect(html).toContain("The title does not match");
    expect(html).toContain("untracked-files");
    expect(html).toContain("uikit-to-swiftui");
    expect(html).toContain("This looks like a conversion");
  });

  // Refusals, warnings and advice are not the same thing, and a page that drew them
  // identically would be lying about what happens next.
  it("gives each severity its own class rather than one card style for all three", () => {
    const html = page({
      items: [
        ITEM({ severity: "refuses" }),
        ITEM({ severity: "warns" }),
        ITEM({ severity: "informs" }),
      ],
    });

    expect(html).toContain('class="card refuses"');
    expect(html).toContain('class="card warns"');
    expect(html).toContain('class="card informs"');
  });

  it("gives every item a checkbox and a note field, and counts them in the footer", () => {
    const html = page({ items: [ITEM(), ITEM({ id: "base-mismatch" })] });

    expect(html).toContain('data-pick="0"');
    expect(html).toContain('data-pick="1"');
    expect(html).toContain('data-note="0"');
    expect(html).toContain('data-note="1"');
    // The footer's opening words, before the script has counted anything. It used to read
    // "0 of 2 selected", which describes a selection nobody has made yet.
    expect(html).toContain("Nothing selected");
  });

  it("says so when nobody has answered the readiness questions yet", () => {
    expect(page({ answered: false })).toContain("Readiness answers are absent");
    expect(page({ answered: true })).not.toContain("Readiness answers are absent");
  });

  it("says so when review was run without an agent's answer", () => {
    expect(page({ commitMessage: undefined })).toContain("No commit message");
  });

  it("repeats anything shipkit could not do", () => {
    expect(page({ notes: ["The forge could not be consulted"] })).toContain(
      "The forge could not be consulted",
    );
  });

  it("says how long it will wait", () => {
    expect(page({ waitMinutes: 10 })).toContain("up to 10 minutes");
  });
});

describe("the page cannot be broken out of", () => {
  // A warning message is repository text: a branch name, a file path, a person's note in a
  // readiness answer. Any of them can contain markup, and a page that pasted it through
  // would be executing whatever the change happened to contain.
  it("escapes a message containing a script tag rather than emitting one", () => {
    const html = page({
      items: [ITEM({ message: "<script>alert(1)</script> and </textarea> too" })],
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("</textarea> too");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a quote in an id, which lands inside an attribute", () => {
    const html = page({ files: [{ path: 'a" onclick="x', status: "modified", patch: "", line: 1 }] });

    expect(html).not.toContain('data-open="a" onclick="x"');
    expect(html).toContain("&quot;");
  });

  // The items travel to the script as a JSON attribute. A message containing a quote or an
  // angle bracket has to survive that trip without ending the attribute.
  it("escapes the JSON payload the script reads the items back out of", () => {
    const html = page({ items: [ITEM({ message: 'he said "no" <b>' })] });

    const match = /data-items="([^"]*)"/.exec(html);
    expect(match).not.toBeNull();
    expect(JSON.parse((match as RegExpExecArray)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'"))).toEqual([
      { kind: "warning", id: "untracked-files", message: 'he said "no" <b>' },
    ]);
  });

  it("escapes the diff itself, which is arbitrary repository text", () => {
    const html = page({
      files: [{ path: "a.html", status: "modified", patch: "+<img src=x onerror=1>", line: 3 }],
    });

    expect(html).not.toContain("<img src=x onerror=1>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });
});

describe("the page cannot submit without the token", () => {
  it("carries the token, and sends it on both endpoints it calls", () => {
    const html = page({ token: "deadbeef" });

    expect(html).toContain('data-token="deadbeef"');
    expect(html).toContain('"/submit?token=" + encodeURIComponent(token)');
    expect(html).toContain('"/open?token=" + encodeURIComponent(token)');
  });

  // The token is the only thing between another process on this machine and the page, so it
  // must never be somewhere a page in another tab could read it out of the URL bar's history
  // by accident — it is generated per run and never written into the markup twice.
  it("names no other origin at all", () => {
    const html = page({ files: [{ path: "a.ts", status: "modified", patch: "+x", line: 1 }] });

    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });
});

describe("escapeHtml", () => {
  it("escapes the ampersand first, so an escape is never escaped twice", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("covers both quote characters, because attributes are interpolated too", () => {
    expect(escapeHtml(`a"b'c`)).toBe("a&quot;b&#39;c");
  });
});

describe("the file headers", () => {
  it("offers the editor command with the first line the change touches", () => {
    const html = page({
      files: [{ path: "Sources/Screen.swift", status: "modified", patch: "@@ -1 +12,3 @@", line: 12 }],
    });

    expect(html).toContain("xed --line 12 Sources/Screen.swift");
    expect(html).toContain('data-open="Sources/Screen.swift"');
    expect(html).toContain('data-line="12"');
  });

  it("says plainly when there is no textual diff instead of drawing an empty box", () => {
    expect(page({ files: [{ path: "icon.png", status: "added", patch: "", line: 1 }] })).toContain(
      "No textual diff",
    );
  });
});

describe("a file too large to draw", () => {
  // The buffer that reads the patch was raised so a large change can be reviewed at all.
  // Rendering one `<span>` per line for a patch that size would have moved the failure from
  // "exits 2" to "serves a page that locks the tab", which is not a fix.
  it("names the size and keeps the file's row and its Open button", () => {
    const patch = `@@ -1 +1 @@\n${Array.from({ length: 40_000 }, (_u, i) => `+line ${i}`).join("\n")}`;
    const html = page({ files: [{ path: "Generated.swift", status: "added", patch, line: 1 }] });

    expect(html).toContain("too much to");
    expect(html).toContain("40,001 lines of diff");
    expect(html).toContain('data-open="Generated.swift"');
    expect(html).not.toContain("+line 39999");
    expect(html.length).toBeLessThan(200_000);
  });

  it("still draws a patch that a person could actually read", () => {
    const patch = `@@ -1 +1 @@\n${Array.from({ length: 200 }, (_u, i) => `+line ${i}`).join("\n")}`;
    const html = page({ files: [{ path: "Small.swift", status: "added", patch, line: 1 }] });

    expect(html).toContain("+line 199");
    expect(html).not.toContain("too much to");
  });
});

describe("commenting on a line", () => {
  const patch = [
    "@@ -1,2 +1,3 @@",
    " import SwiftUI",
    "-let old = 1",
    "+let fresh = 2",
    "+let alsoFresh = 3",
  ].join("\n");

  // The line number comes from the hunk header: `@@ -1,2 +1,3 @@` means the next
  // added-or-context line is line 1 of the file after the change.
  it("numbers each line from the hunk header, counting the new file", () => {
    const html = page({ files: [{ path: "A.swift", status: "modified", patch, line: 1 }] });

    expect(html).toContain('data-path="A.swift" data-line="1"');
    expect(html).toContain('data-path="A.swift" data-line="2"');
    expect(html).toContain('data-path="A.swift" data-line="3"');
  });

  // A removed line is not in the file any more, so a note anchored to it could not be found
  // by anyone — agent or person. It gets no number and no checkbox, which is the same rule
  // GitHub applies for the same reason.
  it("offers no tick on a removed line", () => {
    const html = page({ files: [{ path: "A.swift", status: "modified", patch, line: 1 }] });
    const rows = html.split('<div class="row"');
    const removed = rows.find((row) => row.includes("let old = 1"));

    expect(removed).toBeDefined();
    expect(removed).not.toContain("data-line=");
    expect(removed).not.toContain('class="tick"');
  });

  it("puts a checkbox on every commentable line, not behind a hover", () => {
    const html = page({ files: [{ path: "A.swift", status: "modified", patch, line: 1 }] });

    // Three commentable lines: one context and two additions.
    expect(html.split('class="tick"')).toHaveLength(4);
  });

  it("offers Nothing to fix as its own button, never as the default's other meaning", () => {
    const html = page();

    expect(html).toContain('id="nothing"');
    expect(html).toContain('id="send"');
  });

  // A path carrying markup reaches an attribute, so it goes through the same escaping as
  // everything else. `data-line` is a number this file computed and needs none.
  it("escapes a path with markup in it before it becomes an attribute", () => {
    const html = page({
      files: [{ path: '"><img src=x onerror=alert(1)>.swift', status: "added", patch, line: 1 }],
    });

    expect(html).not.toContain("<img src=x");
  });
});

describe("where shipkit's own remarks are drawn", () => {
  const files = [
    { path: "A.swift", status: "modified" as const, patch: "@@ -1 +1 @@\n+let a = 1", line: 1 },
    { path: "B.swift", status: "added" as const, patch: "@@ -0,0 +1 @@\n+let b = 2", line: 1 },
  ];

  // A remark about A.swift sitting above A.swift is one a person answers; the same remark in
  // a list above the diff is one they scroll past.
  it("puts an item that names a file on that file, not in the list above", () => {
    const html = page({
      files,
      items: [ITEM({ id: "readiness-design-tokens", where: ["B.swift"] })],
    });
    // Asserted on the rendered cards, not on the whole document: the body also carries every
    // item as JSON in `data-items`, which the script reads, and which would match everything.
    const sections = html.split('<section class="file">');
    const cardsIn = (part: string | undefined): string[] =>
      [...(part ?? "").matchAll(/class="id">([^<]+)/g)].map((match) => match[1] as string);

    expect(cardsIn(sections.find((s2) => s2.includes('class="path">B.swift')))).toContain(
      "readiness-design-tokens",
    );
    expect(cardsIn(sections.find((s2) => s2.includes('class="path">A.swift')))).toEqual([]);
    expect(cardsIn(html.split("<h2>The change")[0])).toEqual([]);
  });

  // Two copies of one item are two checkboxes with two independent states for one question,
  // and a person who ticks it on the first file has no way to tell, meeting it again on the
  // second, whether they have answered it.
  it("draws an item naming several files once, and names the others on the card", () => {
    const html = page({
      files,
      items: [ITEM({ id: "untracked-files", where: ["A.swift", "B.swift"] })],
    });

    // One card, so one checkbox. Two would be two independent states for one question.
    expect(html.split('id="pick-0"')).toHaveLength(2);
    expect([...html.matchAll(/class="id">untracked-files/g)]).toHaveLength(1);
    expect(html).toContain("also about");
    expect(html).toContain("<code>B.swift</code>");
  });

  it("keeps an item about the whole change above the diff, where it belongs", () => {
    const html = page({ files, items: [ITEM({ id: "title-pattern" })] });

    expect(html.split("<h2>The change")[0]).toContain('class="id">title-pattern');
  });

  // The file may be one `exclude` kept out of the push. An item nobody is shown is an item
  // nobody can answer, so it goes back to being about the change rather than disappearing.
  it("keeps an item naming a file the diff does not carry", () => {
    const html = page({ files, items: [ITEM({ id: "readiness-x", where: ["Gone.swift"] })] });

    expect(html.split("<h2>The change")[0]).toContain('class="id">readiness-x');
  });
});
