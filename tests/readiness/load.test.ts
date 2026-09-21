import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/load.js";
import { loadReadiness, loadReadinessFiles, readinessPath } from "../../src/readiness/load.js";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  // Through `realpathSync`, because macOS puts every temporary directory behind
  // /var -> /private/var: without it the expected path and the resolved one are two
  // spellings of the same directory and the assertion fails for the wrong reason.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const MINIMAL = `version: 1
rules:
  - id: only
    ask: "Is it ready?"
    severity: warn
`;

describe("loadReadiness", () => {
  it("reads the rules a well-formed file declares", () => {
    const dir = tempDir("shipkit-readiness-");
    writeFileSync(join(dir, "r.yml"), MINIMAL, "utf8");
    writeFileSync(join(dir, ".shipkit.yml"), "unused\n", "utf8");

    expect(loadReadiness(join(dir, ".shipkit.yml"), "./r.yml")).toEqual([
      { id: "only", ask: "Is it ready?", severity: "warn" },
    ]);
  });

  it("accepts the shipped example exactly as it is written", () => {
    // Not a fixture copy: the file the README tells people to read. A schema that drifts
    // from it — a severity the example uses and this does not admit, an `appliesTo`
    // spelling it rejects — is a broken example, and this is the only place that catches
    // it before a reader does.
    const rules = loadReadiness(
      resolve("docs/examples/example.shipkit.yml"),
      "./example.readiness.yml",
    );

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((rule) => rule.id)).toContain("tests-mean-something");
    // Both scoped and unscoped rules, because the two take different paths through
    // `applicable` and an example carrying only one kind would exercise only one.
    expect(rules.some((rule) => rule.appliesTo !== undefined)).toBe(true);
    expect(rules.some((rule) => rule.appliesTo === undefined)).toBe(true);
    // Every rule carries its reason; the loader must not be quietly dropping it.
    expect(rules.every((rule) => (rule.why ?? "").length > 0)).toBe(true);
  });

  it("is reachable through the example config's own readiness key", () => {
    const config = loadConfig("docs/examples/example.shipkit.yml");

    expect(config.readiness).toBe("./example.readiness.yml");
    expect(
      loadReadiness("docs/examples/example.shipkit.yml", config.readiness as string).length,
    ).toBeGreaterThan(0);
  });

  // The deployment model, built rather than described: the product repository's
  // `.shipkit.yml` is a symbolic link into a shared conventions repository, and the rules
  // sit beside the link's *target*. Resolved against the link's apparent location there is
  // no rules file at all, and the run refuses on every push.
  it("resolves the rules path against the realpath of the config, not its apparent location", () => {
    const root = tempDir("shipkit-symlink-");
    const conventions = join(root, "conventions");
    const product = join(root, "product");
    mkdirSync(conventions);
    mkdirSync(product);
    writeFileSync(join(conventions, "shipkit.yml"), "unused\n", "utf8");
    writeFileSync(join(conventions, "readiness.yml"), MINIMAL, "utf8");
    symlinkSync(join(conventions, "shipkit.yml"), join(product, ".shipkit.yml"));

    const link = join(product, ".shipkit.yml");
    expect(readinessPath(link, "./readiness.yml")).toBe(
      join(conventions, "readiness.yml"),
    );
    expect(loadReadiness(link, "./readiness.yml")).toHaveLength(1);

    // The discrimination: beside the link itself there is nothing, so a loader that used
    // the apparent location would have had to fail here rather than merely differ.
    expect(join(product, "readiness.yml")).not.toBe(join(conventions, "readiness.yml"));
    expect(() => loadReadiness(join(product, "absent.yml"), "./readiness.yml")).toThrow(
      ConfigError,
    );
  });

  it("takes an absolute path as given", () => {
    const dir = tempDir("shipkit-readiness-abs-");
    writeFileSync(join(dir, "r.yml"), MINIMAL, "utf8");
    expect(readinessPath("/anywhere/.shipkit.yml", join(dir, "r.yml"))).toBe(join(dir, "r.yml"));
  });

  describe("a configured-but-broken file is loud, never quietly unenforced", () => {
    function failing(contents: string): () => unknown {
      const dir = tempDir("shipkit-readiness-bad-");
      writeFileSync(join(dir, ".shipkit.yml"), "unused\n", "utf8");
      writeFileSync(join(dir, "r.yml"), contents, "utf8");
      return () => loadReadiness(join(dir, ".shipkit.yml"), "./r.yml");
    }

    it("refuses a missing file, naming where it looked", () => {
      const dir = tempDir("shipkit-readiness-missing-");
      writeFileSync(join(dir, ".shipkit.yml"), "unused\n", "utf8");
      expect(() => loadReadiness(join(dir, ".shipkit.yml"), "./nope.yml")).toThrow(ConfigError);
      expect(() => loadReadiness(join(dir, ".shipkit.yml"), "./nope.yml")).toThrow(
        /Cannot read readiness rules at .*nope\.yml/,
      );
    });

    it("refuses unparseable YAML", () => {
      expect(failing("version: 1\nrules: [\n")).toThrow(ConfigError);
    });

    it("refuses an unknown version", () => {
      expect(failing("version: 2\nrules:\n  - id: a\n    ask: b\n    severity: warn\n")).toThrow(
        /Invalid readiness rules/,
      );
    });

    it("refuses a rule with no severity, naming the field", () => {
      expect(failing("version: 1\nrules:\n  - id: a\n    ask: b\n")).toThrow(/rules\.0\.severity/);
    });

    it("refuses a severity the team did not define", () => {
      expect(failing("version: 1\nrules:\n  - id: a\n    ask: b\n    severity: fatal\n")).toThrow(
        /Invalid readiness rules/,
      );
    });

    it("refuses an empty id", () => {
      expect(failing('version: 1\nrules:\n  - id: ""\n    ask: b\n    severity: warn\n')).toThrow(
        /rules\.0\.id/,
      );
    });

    it("refuses two rules sharing an id, naming the id", () => {
      // The second would be unreachable: one answer would satisfy both, and naming each
      // once would read as a duplicate answer. Neither failure explains itself; this does.
      expect(
        failing(
          "version: 1\nrules:\n  - id: a\n    ask: one\n    severity: warn\n  - id: a\n    ask: two\n    severity: block\n",
        ),
      ).toThrow(/duplicate rule ids: a/);
    });

    it("refuses an empty rule list", () => {
      expect(failing("version: 1\nrules: []\n")).toThrow(/Invalid readiness rules/);
    });
  });
});

const TEAM = `version: 1
rules:
  - id: design-tokens
    ask: "Did you use the tokens?"
    severity: advise
`;
const PLATFORM = `version: 1
rules:
  - id: accessibility-ids
    ask: "Do the new views carry identifiers?"
    severity: advise
`;
const CLASH = `version: 1
rules:
  - id: design-tokens
    ask: "The same id, said differently."
    severity: warn
`;

describe("several rulesets read as one checklist", () => {
  // A team ruleset plus a platform ruleset is the case this exists for. shipkit is installed
  // once and pointed at many repositories; which checklist applies is a decision at the point
  // of use, not a property baked into one repository's config.
  it("keeps every rule, in the order the files were named", () => {
    const dir = tempDir("shipkit-multi-");
    writeFileSync(join(dir, "team.yml"), TEAM, "utf8");
    writeFileSync(join(dir, "platform.yml"), PLATFORM, "utf8");

    const rules = loadReadinessFiles([
      { path: join(dir, "team.yml"), named: "--rules team.yml" },
      { path: join(dir, "platform.yml"), named: "--rules platform.yml" },
    ]);

    expect(rules.map((rule) => rule.id)).toEqual(["design-tokens", "accessibility-ids"]);
  });

  // Already refused within one file, for a reason that does not weaken across files: one
  // answer satisfies both, so which rule applies would depend on the order they were listed.
  it("refuses an id defined in two files, naming both", () => {
    const dir = tempDir("shipkit-multi-");
    writeFileSync(join(dir, "team.yml"), TEAM, "utf8");
    writeFileSync(join(dir, "clash.yml"), CLASH, "utf8");

    let thrown: unknown;
    try {
      loadReadinessFiles([
        { path: join(dir, "team.yml"), named: "a" },
        { path: join(dir, "clash.yml"), named: "b" },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain(join(dir, "team.yml"));
    expect((thrown as Error).message).toContain(join(dir, "clash.yml"));
  });

  it("names how the path was asked for, so a person can find what to fix", () => {
    const dir = tempDir("shipkit-multi-");

    expect(() =>
      loadReadinessFiles([{ path: join(dir, "gone.yml"), named: "--rules ../rules/gone.yml" }]),
    ).toThrow("--rules ../rules/gone.yml");
  });

  it("takes a list under readiness:, resolved like a single path is", () => {
    const dir = tempDir("shipkit-multi-");
    writeFileSync(join(dir, "team.yml"), TEAM, "utf8");
    writeFileSync(join(dir, "platform.yml"), PLATFORM, "utf8");
    writeFileSync(join(dir, ".shipkit.yml"), "unused by this call\n", "utf8");

    const rules = loadReadiness(join(dir, ".shipkit.yml"), ["./team.yml", "./platform.yml"]);

    expect(rules.map((rule) => rule.id)).toEqual(["design-tokens", "accessibility-ids"]);
  });

  it("still takes a single path, exactly as before", () => {
    const dir = tempDir("shipkit-multi-");
    writeFileSync(join(dir, "r.yml"), MINIMAL, "utf8");
    writeFileSync(join(dir, ".shipkit.yml"), "unused by this call\n", "utf8");

    expect(loadReadiness(join(dir, ".shipkit.yml"), "./r.yml").map((rule) => rule.id)).toEqual(["only"]);
  });
});
