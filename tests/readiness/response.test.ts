import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadResponse, ResponseError } from "../../src/submit/response.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function responseFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-response-"));
  tempDirs.push(dir);
  const path = join(dir, "response.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

const BASE = {
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: { Summary: "s" },
};

describe("a response's readiness answers", () => {
  it("is absent from a response that carries none, exactly as before", () => {
    // Every response written before this feature existed is this shape, and it must parse
    // as it always did rather than acquiring an empty array it never asked for.
    const response = loadResponse(responseFile(BASE));
    expect(response.readiness).toBeUndefined();
    expect(Object.keys(response)).toEqual(["title", "commitMessage", "sections"]);
  });

  it("parses the three statuses and the note", () => {
    const response = loadResponse(
      responseFile({
        ...BASE,
        readiness: [
          { id: "design-tokens", status: "pass" },
          { id: "concurrency", status: "fail", note: "no in-flight flag yet" },
          { id: "localization-cms", status: "n/a", note: "no user-visible text" },
        ],
      }),
    );

    expect(response.readiness).toEqual([
      { id: "design-tokens", status: "pass" },
      { id: "concurrency", status: "fail", note: "no in-flight flag yet" },
      { id: "localization-cms", status: "n/a", note: "no user-visible text" },
    ]);
  });

  it("refuses a status the rules do not define", () => {
    expect(() =>
      loadResponse(responseFile({ ...BASE, readiness: [{ id: "a", status: "maybe" }] })),
    ).toThrow(ResponseError);
  });

  it("refuses an answer with no id", () => {
    expect(() => loadResponse(responseFile({ ...BASE, readiness: [{ status: "pass" }] }))).toThrow(
      /readiness\.0\.id/,
    );
  });

  it("refuses an empty id, which no rule can have either", () => {
    expect(() =>
      loadResponse(responseFile({ ...BASE, readiness: [{ id: "", status: "pass" }] })),
    ).toThrow(ResponseError);
  });

  it("refuses a note that is not a string", () => {
    expect(() =>
      loadResponse(responseFile({ ...BASE, readiness: [{ id: "a", status: "n/a", note: 7 }] })),
    ).toThrow(ResponseError);
  });

  it("refuses readiness that is not a list", () => {
    // A repaired shape is a guess, and a guess here satisfies a rule nobody answered.
    expect(() => loadResponse(responseFile({ ...BASE, readiness: "all good" }))).toThrow(
      ResponseError,
    );
  });
});
