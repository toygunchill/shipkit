import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  archiveFixRequest,
  FixRequestError,
  fixRequestExclusions,
  parseFixRequest,
  readFixRequest,
  writeFixRequest,
  type FixRequest,
} from "../../src/review/fixrequest.js";
import { stagingPathspec } from "../../src/vcs/mutate.js";

const REQUEST: FixRequest = {
  version: 1,
  createdAt: "2026-09-17T10:00:00.000Z",
  base: "develop",
  branch: "bugfix/squadb/1-invoice",
  items: [{ kind: "warning", id: "untracked-files", message: "m", note: "delete it" }],
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-fixreq-")));
  tempDirs.push(root);
  return root;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A real repository on a real branch. Nothing here touches a network or a remote. */
function repo(): string {
  const root = scratch();
  git(["init", "-b", "develop", "."], root);
  git(["config", "user.email", "t@example.com"], root);
  git(["config", "user.name", "Test"], root);
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n", "utf8");
  git(["add", "--all"], root);
  git(["commit", "-m", "init"], root);
  return root;
}

describe("the selection file on disk", () => {
  it("writes it where brief will look, creating .shipkit on the first review", () => {
    const root = scratch();

    const path = writeFixRequest(root, REQUEST);

    expect(path).toBe(join(root, ".shipkit/fix-request.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(REQUEST);
    expect(readFixRequest(root)).toEqual(REQUEST);
  });

  it("answers undefined when no review has happened", () => {
    expect(readFixRequest(scratch())).toBeUndefined();
  });

  // Silently treating an unreadable selection as "they chose nothing" is the one failure
  // this feature must not have: a person did choose, and the run would proceed as though
  // they had not.
  it("refuses a selection it cannot parse rather than shrugging", () => {
    const root = scratch();
    mkdirSync(join(root, ".shipkit"), { recursive: true });
    writeFileSync(join(root, ".shipkit/fix-request.json"), "{not json", "utf8");

    expect(() => readFixRequest(root)).toThrow(FixRequestError);
  });

  it("refuses a selection written by a shipkit that spells version 2", () => {
    expect(() => parseFixRequest(JSON.stringify({ ...REQUEST, version: 2 }), "x")).toThrow(
      FixRequestError,
    );
  });

  it("refuses an item with a kind no channel produces", () => {
    const bad = { ...REQUEST, items: [{ kind: "opinion", id: "a", message: "m", note: "" }] };
    expect(() => parseFixRequest(JSON.stringify(bad), "x")).toThrow(FixRequestError);
  });
});

describe("keeping the selection out of the commit", () => {
  it("names the live selection as an exclusion", () => {
    const root = scratch();
    writeFixRequest(root, REQUEST);

    expect(fixRequestExclusions(root)).toEqual([".shipkit/fix-request.json"]);
  });

  it("names nothing at all in a repository nobody has reviewed", () => {
    expect(fixRequestExclusions(scratch())).toEqual([]);
  });

  // One entry, always — not a list that grows with every review. The exclusion is passed to
  // `git add --all` and to four scratch-index reads, so a branch reviewed a hundred times
  // used to carry a hundred pathspec arguments toward ARG_MAX. Archives live outside the
  // repository now, so there is nothing else in here to name.
  it("names the live selection and nothing else, however much sits beside it", () => {
    const root = scratch();
    writeFixRequest(root, REQUEST);
    writeFileSync(join(root, ".shipkit/fix-request-2026-01-01T00-00-00-000Z.json"), "{}", "utf8");
    writeFileSync(join(root, ".shipkit/notes.md"), "mine", "utf8");

    expect(fixRequestExclusions(root)).toEqual([".shipkit/fix-request.json"]);
  });

  // The whole point of the exclusion, asserted against real git rather than against an argv.
  it("cannot be staged by git add --all", () => {
    const root = repo();
    writeFixRequest(root, REQUEST);
    writeFileSync(join(root, "notes.md"), "mine\n", "utf8");

    git(["add", "--all", ...stagingPathspec(fixRequestExclusions(root))], root);

    const staged = git(["diff", "--cached", "--name-only"], root).split("\n").filter(Boolean);
    expect(staged).toContain("notes.md");
    expect(staged).not.toContain(".shipkit/fix-request.json");
  });

  // The archive used to be the leak's second act: written beside the live file, it was
  // staged on the next run. It is written outside the repository now, so the repository has
  // nothing left to leak — asserted against real git, not against an argv.
  it("leaves nothing behind in the repository once it has been archived", () => {
    const root = repo();
    const elsewhere = join(scratch(), "archives");
    writeFixRequest(root, REQUEST);
    const archived = archiveFixRequest(root, new Date("2026-09-17T10:00:00.000Z"), elsewhere);

    expect(archived?.startsWith(root)).toBe(false);
    git(["add", "--all", ...stagingPathspec(fixRequestExclusions(root))], root);
    const staged = git(["diff", "--cached", "--name-only"], root).split("\n").filter(Boolean);
    expect(staged.filter((path) => path.startsWith(".shipkit/"))).toEqual([]);
  });
});

describe("archiving a consumed selection", () => {
  it("moves it aside under a timestamp, leaving nothing at the live path", () => {
    const root = scratch();
    writeFixRequest(root, REQUEST);

    const elsewhere = join(scratch(), "archives");
    const archived = archiveFixRequest(root, new Date("2026-09-17T10:00:00.000Z"), elsewhere);

    expect(archived).toBe(join(elsewhere, "fix-request-2026-09-17T10-00-00-000Z.json"));
    expect(readFixRequest(root)).toBeUndefined();
    expect(JSON.parse(readFileSync(archived as string, "utf8"))).toEqual(REQUEST);
  });

  it("says nothing was moved when nobody reviewed anything", () => {
    expect(archiveFixRequest(scratch(), new Date())).toBeUndefined();
  });
});
