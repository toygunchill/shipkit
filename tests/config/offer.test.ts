import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { offerSetup, type OfferDeps } from "../../src/config/offer.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = `
pr:
  titlePattern: '^(feat|fix): .+'
  sections:
    - name: Summary
      required: true
branch:
  pattern: '^feature/.+'
jira:
  baseUrl: https://jira.example.com
  keyPattern: 'ABC-\\d+'
`;

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "shipkit-offer-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  }
  return root;
}

function deps(over: Partial<OfferDeps> = {}) {
  const asked: string[] = [];
  const errs: string[] = [];
  let inits = 0;
  const base: OfferDeps = {
    isInteractive: () => true,
    ask: (question) => {
      asked.push(question);
      return Promise.resolve("y");
    },
    runInit: () => {
      inits += 1;
      return Promise.resolve(0);
    },
    err: (line) => void errs.push(line),
    ...over,
  };
  return { deps: base, asked, errs, inits: () => inits };
}

describe("offering to set a repository up", () => {
  it("asks nothing when a config is already there", async () => {
    const h = deps();

    expect(await offerSetup(repo({ ".shipkit.yml": CONFIG }), h.deps)).toBe("ready");
    expect(h.asked).toEqual([]);
    expect(h.inits()).toBe(0);
  });

  it("asks, and sets up, when there is none", async () => {
    const h = deps();

    expect(await offerSetup(repo(), h.deps)).toBe("ready");
    expect(h.asked).toHaveLength(1);
    expect(h.inits()).toBe(1);
  });

  // Pressing return at a prompt whose default is spelled out is an answer.
  it("takes an empty answer as the spelled-out default", async () => {
    const h = deps({ ask: () => Promise.resolve("\n") });

    expect(await offerSetup(repo(), h.deps)).toBe("ready");
    expect(h.inits()).toBe(1);
  });

  it("creates nothing when the answer is no", async () => {
    const h = deps({ ask: () => Promise.resolve("n") });

    expect(await offerSetup(repo(), h.deps)).toBe("declined");
    expect(h.inits()).toBe(0);
    expect(h.errs.join("\n")).toContain("Nothing was created");
  });

  // An agent and a CI job both reach this code. A prompt there is a process that hangs
  // until something kills it, so the offer is not made at all.
  it("never asks without a terminal, and explains instead", async () => {
    const h = deps({ isInteractive: () => false });

    expect(await offerSetup(repo(), h.deps)).toBe("not-interactive");
    expect(h.asked).toEqual([]);
    expect(h.inits()).toBe(0);
    expect(h.errs.join("\n")).toContain("shipkit init");
  });

  // Two configs is not something a sixth file fixes.
  it("does not offer to create anything when the problem is ambiguity", async () => {
    const h = deps();
    const root = repo({ "a.yml": CONFIG, "config/b.yml": CONFIG });

    expect(await offerSetup(root, h.deps)).toBe("ambiguous");
    expect(h.asked).toEqual([]);
    expect(h.inits()).toBe(0);
    expect(h.errs.join("\n")).toContain("--config");
  });

  it("reports a setup that failed rather than carrying on as if ready", async () => {
    const h = deps({ runInit: () => Promise.resolve(2) });

    expect(await offerSetup(repo(), h.deps)).toBe("declined");
  });
});
