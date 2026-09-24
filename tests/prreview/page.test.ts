import { describe, expect, it } from "vitest";
import { applyKept, parseKept, renderPrPage, type PrPageInput } from "../../src/prreview/page.js";
import type { AcceptedRemark } from "../../src/prreview/validate.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@
 kept
-gone
+fresh
+extra
`;

const accepted: AcceptedRemark[] = [
  { placement: "line", ruleId: "ADR-012", path: "src/a.ts", line: 11, side: "RIGHT", body: "routed?" },
  { placement: "pull", ruleId: "ADR-004", body: "the whole change assumes an unowned store" },
];

const input: PrPageInput = {
  token: "t0ken",
  repository: "acme/widget",
  number: 12,
  title: "fix: something",
  author: "someone",
  mine: false,
  diff: DIFF,
  accepted,
  rejected: [{ remark: { ruleId: "ADR-999", body: "x" }, reason: "cites ADR-999, which does not exist" }],
};

describe("the pull-request editor page", () => {
  // The whole point of anchoring: a remark you have to match to a line yourself is one you
  // skim. It must be rendered inside the diff, after the line it belongs to.
  it("draws a line remark immediately after its own line", () => {
    const html = renderPrPage(input);
    const at = html.indexOf("routed?");
    const lineAt = html.indexOf("+fresh");

    expect(at).toBeGreaterThan(lineAt);
    expect(html.slice(lineAt, at)).not.toContain("+extra");
  });

  it("puts a remark about the whole change somewhere it cannot be mistaken for a line", () => {
    const html = renderPrPage(input);

    expect(html).toContain("not attached to any line");
    expect(html).toContain("unowned store");
  });

  // Nothing ticked on open. A review that arrives pre-approved is one a person scrolls past
  // and sends, which is the outcome the editor exists to prevent.
  it("ticks nothing by default and disables the send button", () => {
    const html = renderPrPage(input);

    expect(html).not.toContain('type="checkbox" name="keep" value="0" checked');
    expect(html).toContain('id="send" class="send" disabled');
  });

  // Publishing is immediate and public. A control labelled "Send" would be the wrong size
  // for what it does.
  it("says whose pull request is about to be commented on, on the button itself", () => {
    expect(renderPrPage(input)).toContain("Publish on someone's acme/widget#12");
  });

  // A login is text somebody else controls and it is interpolated into this page.
  it("escapes the author's name rather than trusting a login", () => {
    const html = renderPrPage({ ...input, author: "<img src=x onerror=alert(1)>" });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("says so plainly when the pull request is your own", () => {
    expect(renderPrPage({ ...input, mine: true })).toContain("Publish on your own");
  });

  // Refusals are shown rather than hidden: an agent that keeps inventing rule ids is
  // something the person should find out about.
  it("shows what was refused, and why", () => {
    const html = renderPrPage(input);

    expect(html).toContain("were refused");
    expect(html).toContain("ADR-999");
  });

  it("escapes a diff that contains markup, rather than rendering it", () => {
    const html = renderPrPage({ ...input, diff: `${DIFF}+<script>alert(1)</script>\n` });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("gives every remark its own body and note field", () => {
    const html = renderPrPage(input);

    expect((html.match(/textarea class="body"/g) ?? []).length).toBe(2);
    expect((html.match(/textarea class="note"/g) ?? []).length).toBe(2);
  });
});

describe("reading the answer back", () => {
  it("takes a selection of remarks the page offered", () => {
    const kept = parseKept('{"items":[{"index":0,"body":"routed?","note":"please"}]}', 2);

    expect(kept).toEqual([{ index: 0, body: "routed?", note: "please" }]);
  });

  it("reads an empty selection as publishing nothing", () => {
    expect(parseKept('{"items":[]}', 2)).toEqual([]);
  });

  // An index outside the list is a request to publish something that was never reviewed.
  // Clamping it would publish the wrong remark; refusing is the only safe answer.
  it("refuses an index that addresses no remark", () => {
    expect(parseKept('{"items":[{"index":9,"body":"x","note":""}]}', 2)).toBeUndefined();
    expect(parseKept('{"items":[{"index":-1,"body":"x","note":""}]}', 2)).toBeUndefined();
  });

  it("refuses a body that is not text", () => {
    expect(parseKept('{"items":[{"index":0,"body":3,"note":""}]}', 2)).toBeUndefined();
  });

  it("refuses something that is not a selection at all", () => {
    expect(parseKept("not json", 2)).toBeUndefined();
    expect(parseKept('{"x":1}', 2)).toBeUndefined();
  });
});

describe("applying what the person chose", () => {
  it("publishes only the remarks that were ticked", () => {
    const out = applyKept(accepted, [{ index: 1, body: "unowned store", note: "" }]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ placement: "pull", ruleId: "ADR-004" });
  });

  it("takes the body as the person left it, rewrites included", () => {
    const out = applyKept(accepted, [{ index: 0, body: "completely rewritten", note: "" }]);

    expect(out[0]?.body).toBe("completely rewritten");
  });

  // Keeping the two halves visibly apart is the reason a person was invited to add words at
  // all: a reader can tell which sentence a human wrote.
  it("appends the person's own words under the remark, separated", () => {
    const out = applyKept(accepted, [{ index: 0, body: "routed?", note: "worth a follow-up" }]);

    expect(out[0]?.body).toBe("routed?\n\nworth a follow-up");
  });

  it("adds nothing when the person wrote nothing", () => {
    expect(applyKept(accepted, [{ index: 0, body: "routed?", note: "   " }])[0]?.body).toBe("routed?");
  });

  it("keeps the anchor the remark was validated against", () => {
    const out = applyKept(accepted, [{ index: 0, body: "x", note: "" }]);

    expect(out[0]).toMatchObject({ placement: "line", path: "src/a.ts", line: 11, side: "RIGHT" });
  });
});
