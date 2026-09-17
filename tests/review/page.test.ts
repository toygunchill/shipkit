import { describe, expect, it } from "vitest";
import { escapeHtml, renderPage, type PageInput } from "../../src/review/page.js";
import type { ReviewItem } from "../../src/review/items.js";

const BASE: PageInput = {
  repo: "shipkit",
  branch: "bugfix/squadb/1-invoice",
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
    expect(html).toContain("bugfix/squadb/1-invoice");
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
    expect(html).toContain("0 of 2 selected");
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
