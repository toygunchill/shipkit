import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema, type ShipkitConfig } from "../../src/config/schema.js";
import { runInit, schemaFailure, type InitDeps, type MergedPullRequest } from "../../src/init/run.js";
import { renderConfig, type InitDraft } from "../../src/infer/render.js";
import { validate } from "../../src/validate/rules.js";

/** Bodies written by people — the sample `init` is meant to learn a house style from. */
function byPeople(bodies: string[]): MergedPullRequest[] {
  return bodies.map((body, index) => ({ body, author: `person-${index}`, authorIsBot: false }));
}

function deps(over: Partial<InitDeps> = {}) {
  const written: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const base: InitDeps = {
    sources: {
      rulesets: () => [],
      mergeGateWorkflow: () => undefined,
      mergedPullRequests: () =>
        byPeople(["## Summary\nreal work\n## Issues Addressed\nhttps://x.example.com/jira/browse/ABC-1"]),
    },
    exists: () => false,
    write: (_p, text) => void written.push(text),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    ...over,
  };
  return { deps: base, written, out, err };
}

const OPTIONS = { config: ".shipkit.yml", force: false, limit: 50 };

/** Reads back what was written, through the schema — the shape a loader will see. */
function wroteConfig(sources: Partial<InitDeps["sources"]> = {}): ShipkitConfig {
  const { deps: d, written } = deps({
    sources: {
      rulesets: () => [],
      mergeGateWorkflow: () => undefined,
      mergedPullRequests: () => [],
      ...sources,
    },
  });
  runInit(OPTIONS, d);
  return configSchema.parse(parse(written[0]));
}

const TEMPLATE = "Briefly describe what this PR does.";

describe("runInit", () => {
  it("writes a config the loader accepts, even with no forge access at all", () => {
    const { deps: d, written } = deps({
      sources: {
        rulesets: () => { throw new Error("no remote"); },
        mergeGateWorkflow: () => { throw new Error("no remote"); },
        mergedPullRequests: () => { throw new Error("no remote"); },
      },
    });
    const result = runInit(OPTIONS, d);
    expect(result.code).toBe(0);
    expect(result.wrote).toBe(true);
    expect(() => configSchema.parse(parse(written[0]))).not.toThrow();
  });

  it("names what it could not determine, rather than quietly inventing it", () => {
    const { deps: d } = deps({
      sources: {
        rulesets: () => { throw new Error("no remote"); },
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => [],
      },
    });
    expect(runInit(OPTIONS, d).unresolved).toContain("branch.pattern");
  });

  it("refuses to overwrite an existing config", () => {
    const { deps: d, written } = deps({ exists: () => true });
    const result = runInit(OPTIONS, d);
    expect(result.code).toBe(2);
    expect(result.wrote).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("overwrites when told to explicitly", () => {
    const { deps: d, written } = deps({ exists: () => true });
    expect(runInit({ ...OPTIONS, force: true }, d).wrote).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("reports what it actually received when a payload makes no sense", () => {
    const { deps: d, err } = deps({ sources: { rulesets: () => ({ nope: true }), mergeGateWorkflow: () => undefined, mergedPullRequests: () => [] } });
    runInit(OPTIONS, d);
    expect(err.join("\n")).toMatch(/ruleset/i);
  });

  it("says what the payload actually was, not only that nothing came of it", () => {
    const { deps: d, err } = deps({
      sources: {
        rulesets: () => ({ nope: true }),
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => [],
      },
    });
    runInit(OPTIONS, d);
    expect(err.join("\n")).toContain("nope");
  });

  it("floors What to Test at three items even when the sections were observed", () => {
    // sectionSkeleton observes names and required-ness only, so an observed
    // skeleton carries no minItems at all — and this is the section agents
    // reduce to one vague line. Observing the past faithfully would drop the
    // check that exists to correct it.
    const bodies = ["## Summary\na\n## What to Test\nb", "## Summary\nc\n## What to Test\nd"];
    const config = wroteConfig({ mergedPullRequests: () => byPeople(bodies) });
    const observed = config.pr.sections.find((s) => s.name === "What to Test");
    expect(observed?.minItems).toBe(3);
    // ...and the note must not claim the forge or the past proved it.
    expect(config.pr.sections.map((s) => s.name)).toEqual(["Summary", "What to Test"]);
  });

  it("drops a heading one body in a large sample carries, and keeps one a quarter carry", () => {
    const bodies = Array.from({ length: 12 }, () => "## Summary\na");
    bodies[0] += "\n## Someone's personal note\nx";
    for (let i = 0; i < 3; i++) bodies[i] += "\n## Analysis JIRA Issue\ny";
    const names = wroteConfig({ mergedPullRequests: () => byPeople(bodies) }).pr.sections.map((s) => s.name);
    expect(names).not.toContain("Someone's personal note");
    expect(names).toContain("Analysis JIRA Issue");
  });

  it("keeps every heading when the sample is too small for a tenth to mean anything", () => {
    const bodies = ["## Summary\na\n## Analysis JIRA Issue\nx", "## Summary\na", "## Summary\na", "## Summary\na"];
    const names = wroteConfig({ mergedPullRequests: () => byPeople(bodies) }).pr.sections.map((s) => s.name);
    expect(names).toContain("Analysis JIRA Issue");
  });

  it("judges boilerplate by a share of what it read, not a fixed count", () => {
    // Six bodies. A line four of them share is template text; a line three share
    // is prose that happened to repeat. Two thirds of six is four, so the line in
    // three falls below — where a fixed count of two or three would have let it in.
    const bodies = Array.from({ length: 6 }, (_, i) =>
      [`## Summary\nchange ${i}`, i < 4 ? TEMPLATE : "", i >= 3 ? "Bumped the version." : ""]
        .filter((line) => line !== "")
        .join("\n"),
    );
    const forbidden = wroteConfig({ mergedPullRequests: () => byPeople(bodies) }).pr.forbidden;
    expect(forbidden).toContain(TEMPLATE);
    expect(forbidden).not.toContain("Bumped the version.");
  });

  // Two floors used to disagree about how small a sample is too small: a section
  // needs three bodies before a share of them is evidence of a convention, but a
  // substring ban fired on two — and a forbidden entry is the more dangerous of
  // the two settings by a distance. The bot filter makes two an everyday sample:
  // forty-eight dependabot merges and two human ones.
  it("will not ban a line on a sample too small to make a section required", () => {
    const body = `## Summary\nx\n${TEMPLATE}`;
    const config = wroteConfig({ mergedPullRequests: () => byPeople([body, body]) });
    expect(config.pr.sections.some((s) => s.required)).toBe(false);
    expect(config.pr.forbidden).toEqual([]);
  });

  it("says the sample was too small rather than reporting arithmetic nobody can check", () => {
    const body = `## Summary\nx\n${TEMPLATE}`;
    const { deps: d, written } = deps({
      sources: {
        rulesets: () => [],
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => byPeople([body, body]),
      },
    });
    runInit(OPTIONS, d);
    expect(written[0]).toContain("2 bodies cannot show a convention");
    expect(written[0]).not.toMatch(/counted as template text at 2 of 2/);
  });

  it("bans the same line as soon as the sample is big enough for a required section", () => {
    const body = `## Summary\nx\n${TEMPLATE}`;
    const config = wroteConfig({ mergedPullRequests: () => byPeople([body, body, body]) });
    expect(config.pr.forbidden).toEqual([TEMPLATE]);
    expect(config.pr.sections.some((s) => s.required)).toBe(true);
  });

  // The finding end to end: six bodies whose checklist everybody ticked, whose
  // template comment and italic instruction nobody deleted. `forbidden` used to
  // come out holding the two ticked items — so the next correctly-filled pull
  // request was rejected — and holding neither the comment nor the instruction.
  it("bans what nobody filled in and not what everybody did", () => {
    const COMMENT = "<!-- Describe your change -->";
    const ITALIC =
      "*Delete this whole section if your change does not need any screenshots or recordings at all*";
    const TICKED = ["- [x] I have run the test suite locally", "- [x] I have updated the changelog"];
    const bodies = Array.from({ length: 6 }, (_, i) =>
      [
        "## Summary",
        COMMENT,
        `Fixes the retry loop that hung on a 500, take ${i}.`,
        "## Screenshots / Screen Recordings",
        ITALIC,
        "N/A",
        "## Issues Addressed",
        `https://x.example.com/jira/browse/DCP-${100 + i}`,
        "## Checklist",
        ...TICKED,
      ].join("\n"),
    );

    const config = wroteConfig({ mergedPullRequests: () => byPeople(bodies) });
    expect(config.pr.forbidden).toEqual(expect.arrayContaining([COMMENT, ITALIC]));
    for (const ticked of TICKED) expect(config.pr.forbidden).not.toContain(ticked);

    const filled = [
      "## Summary",
      "Adds a retry budget so a flapping upstream cannot wedge the queue.",
      "## Screenshots / Screen Recordings",
      "N/A",
      "## Issues Addressed",
      "https://x.example.com/jira/browse/ABC-999",
      "## Checklist",
      ...TICKED,
    ].join("\n");
    expect(validate({ title: "fix(retry): stop hanging on a 500", body: filled, config }).findings).toEqual([]);
  });

  it("proposes a skeleton, not an empty section list, when no body could be read", () => {
    // configSchema requires at least one section: an empty list is a file that
    // cannot load, which is the one failure this command must not produce.
    const config = wroteConfig();
    expect(config.pr.sections.length).toBeGreaterThan(0);
    expect(config.pr.sections.map((s) => s.name)).toContain("What to Test");
  });
});

// A ruleset over refs/heads/release/* says how release branches are named. It does
// not say how branches are named. Written into branch.pattern as a fact, it fails
// every feature branch on the first check anybody runs.
describe("runInit against a ref-scoped ruleset", () => {
  const RELEASE_ONLY = [
    {
      id: 30,
      name: "release branches",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } },
      rules: [
        {
          type: "branch_name_pattern",
          parameters: { operator: "regex", pattern: "^release/[0-9]+\\.[0-9]+$", negate: false },
        },
      ],
    },
  ];

  it("does not hold every branch to the release refs' pattern", () => {
    const config = wroteConfig({ rulesets: () => RELEASE_ONLY });
    expect(config.branch.pattern).not.toContain("release");
    expect(new RegExp(config.branch.pattern).test("feature/toygun/1234-thing")).toBe(true);
  });

  it("says in the file why it could not read a branch convention, and names it unresolved", () => {
    const { deps: d, written, err } = deps({
      sources: {
        rulesets: () => RELEASE_ONLY,
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => [],
      },
    });
    const result = runInit(OPTIONS, d);
    expect(result.unresolved).toContain("branch.pattern");
    expect(written[0]).toContain("subset of refs");
    expect(written[0]).toContain("refs/heads/release/*");
    expect(written[0]).not.toContain("read: branch_name_pattern");
    expect(err.join("\n")).toContain("refs/heads/release/*");
  });

  it("keeps a ruleset that governs every branch a person creates", () => {
    // include ~ALL / exclude ~DEFAULT_BRANCH is what a branch-naming ruleset
    // looks like in practice. Discarded, it cost branch.pattern entirely.
    const canonical = [
      {
        id: 32,
        name: "branch naming",
        enforcement: "active",
        conditions: { ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH"] } },
        rules: [
          {
            type: "branch_name_pattern",
            parameters: { operator: "regex", pattern: "^(feature|bugfix)/.+$", negate: false },
          },
        ],
      },
    ];
    const { deps: d, written } = deps({
      sources: {
        rulesets: () => canonical,
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => [],
      },
    });
    const result = runInit(OPTIONS, d);
    expect(result.unresolved).not.toContain("branch.pattern");
    expect(configSchema.parse(parse(written[0])).branch.pattern).toBe("^(feature|bugfix)/.+$");
    expect(written[0]).toContain("read: branch_name_pattern");
  });

  it("still prefers a ruleset that governs every ref, wherever it sits in the list", () => {
    const all = {
      id: 31,
      name: "branch naming",
      enforcement: "active",
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      rules: [
        {
          type: "branch_name_pattern",
          parameters: { operator: "regex", pattern: "^feature/.+$", negate: false },
        },
      ],
    };
    const config = wroteConfig({ rulesets: () => [...RELEASE_ONLY, all] });
    expect(config.branch.pattern).toBe("^feature/.+$");
  });
});

describe("runInit writes only what loads", () => {
  // Both of these compile as regular expressions. "" fails the schema's min(1) and
  // "   " loads while matching no branch anybody's is called — under a comment
  // saying the forge proved it.
  it.each(["", "   "])("refuses a blank ruleset pattern (%j) at the source", (pattern) => {
    const { deps: d, written } = deps({
      sources: {
        rulesets: () => [
          {
            name: "blank",
            enforcement: "active",
            rules: [{ type: "branch_name_pattern", parameters: { operator: "regex", pattern } }],
          },
        ],
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => [],
      },
    });
    const result = runInit(OPTIONS, d);
    expect(result.code).toBe(0);
    expect(result.unresolved).toContain("branch.pattern");
    const config = configSchema.parse(parse(written[0]));
    expect(config.branch.pattern).toBe("^.+$");
  });

  // A host lifted out of prose is not necessarily a URL, and `z.string().url()`
  // rejects all of these — a config holding one is a config `check` cannot load.
  //
  // Two defences catch them and they catch different inputs, which is why the
  // cases are split. The link pattern refuses to lift a host containing a
  // character a URL cannot hold at all, so `a<b` and `[bad` never become a
  // candidate; the ones it does lift are then checked against the schema before
  // anything is written. Both paths end at the same place — the placeholder
  // host, and `jira.baseUrl` named as needing a human — so what separates them
  // is only whether `init` had to say it rejected something.
  it.each(["a<b", "[bad"])(
    "never adopts a host the link pattern will not lift (%s)",
    (host) => {
      const body = `## Summary\nx\n## Issues Addressed\nhttps://${host}/browse/ABC-1`;
      const { deps: d, written } = deps({
        sources: {
          rulesets: () => [],
          mergeGateWorkflow: () => undefined,
          mergedPullRequests: () => byPeople([body, body]),
        },
      });
      const result = runInit(OPTIONS, d);
      expect(result.code).toBe(0);
      expect(result.unresolved).toContain("jira.baseUrl");
      expect(configSchema.parse(parse(written[0])).jira.baseUrl).toBe("https://jira.example.com");
    },
  );

  it.each(["a|b", "a%20b", "ex.com:notaport"])(
    "refuses an observed Jira host that is lifted but is not a URL (%s)",
    (host) => {
      const body = `## Summary\nx\n## Issues Addressed\nhttps://${host}/browse/ABC-1`;
      const { deps: d, written, out } = deps({
        sources: {
          rulesets: () => [],
          mergeGateWorkflow: () => undefined,
          mergedPullRequests: () => byPeople([body, body]),
        },
      });
      const result = runInit(OPTIONS, d);
      expect(result.code).toBe(0);
      expect(result.unresolved).toContain("jira.baseUrl");
      expect(() => configSchema.parse(parse(written[0]))).not.toThrow();
      expect(configSchema.parse(parse(written[0])).jira.baseUrl).toBe("https://jira.example.com");
      expect(out.join("\n")).toContain("is not a URL this config can hold");
    },
  );

  it("keeps a Jira host that is a URL", () => {
    const body = "## Summary\nx\n## Issues Addressed\nhttps://x.example.com/jira/browse/ABC-1";
    const config = wroteConfig({ mergedPullRequests: () => byPeople([body, body]) });
    expect(config.jira.baseUrl).toBe("https://x.example.com/jira");
  });

  // The last gate: whatever is inferred in future, a file `check` cannot read is
  // worse than a refusal that names the field.
  it("names the offending field rather than letting an unloadable config through", () => {
    const draft: InitDraft = {
      titlePattern: { value: "^x$", provenance: "proposed", why: "w" },
      branchPattern: { value: "", provenance: "read", why: "w" },
      forbidden: { value: [], provenance: "proposed", why: "w" },
      blockingLabels: { value: [], provenance: "proposed", why: "w" },
      sections: { value: [{ name: "Summary", required: true }], provenance: "observed", why: "w" },
      jira: { value: { baseUrl: "https://a<b" }, provenance: "observed", why: "w" },
      jiraSection: { value: "Summary", provenance: "observed", why: "w" },
    };
    const failure = schemaFailure(renderConfig(draft));
    expect(failure).toContain("branch.pattern");
    expect(failure).toContain("jira.baseUrl");
  });

  it("says nothing is wrong with a config that loads", () => {
    const { written } = (() => {
      const d = deps();
      runInit(OPTIONS, d.deps);
      return d;
    })();
    expect(schemaFailure(written[0])).toBeUndefined();
  });
});

// Most merged pull requests in many repositories are bot merges, and their bodies
// are the most uniform text in the repository — which is exactly what every "most
// bodies agree" rule in here mistakes for a house style.
describe("runInit against a bot-dominated sample", () => {
  const DEPENDABOT = [
    "Bumps lodash from 4.17.20 to 4.17.21.",
    "## Release notes",
    "sourced from lodash's releases.",
    "## Commits",
    "- deadbee chore: release 4.17.21",
    "Dependabot will resolve any conflicts with this PR as long as you don't alter it yourself.",
  ].join("\n");

  const HUMAN = [
    "## Summary",
    "Fixes the retry loop that hung on a 500.",
    "## What to Test",
    "- open the page",
    "- force a 500",
    "- watch it retry three times",
    "## Issues Addressed",
    "https://x.example.com/jira/browse/ABC-1",
  ].join("\n");

  function sample(): MergedPullRequest[] {
    const bots: MergedPullRequest[] = Array.from({ length: 10 }, () => ({
      body: DEPENDABOT,
      author: "app/dependabot",
      authorIsBot: true,
    }));
    return [...bots, { body: HUMAN, author: "toyguncil", authorIsBot: false }];
  }

  it("does not make dependabot's sections mandatory", () => {
    const config = wroteConfig({ mergedPullRequests: () => sample() });
    const names = config.pr.sections.map((s) => s.name);
    expect(names).not.toContain("Release notes");
    expect(names).not.toContain("Commits");
    expect(names).toContain("Summary");
  });

  it("does not put dependabot's boilerplate in forbidden", () => {
    const config = wroteConfig({ mergedPullRequests: () => sample() });
    expect(config.pr.forbidden.join("\n")).not.toContain("Dependabot will resolve");
  });

  // The sharpest form of the finding: the human pull request that was in the
  // sample used to fail the config inferred from it.
  it("writes a config the human pull request in the sample passes", () => {
    const config = wroteConfig({ mergedPullRequests: () => sample() });
    const result = validate({ title: "fix(retry): stop hanging on a 500", body: HUMAN, config });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("says how many it read and how many it skipped", () => {
    const { deps: d, written, err } = deps({
      sources: {
        rulesets: () => [],
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => sample(),
      },
    });
    runInit(OPTIONS, d);
    expect(written[0]).toContain("1 of 11 merged pull request(s) read");
    expect(written[0]).toContain("10 skipped as bot-authored");
    expect(err.join("\n")).toContain("10 bot-authored pull request(s)");
  });

  it.each(["dependabot[bot]", "app/dependabot", "renovate[bot]", "github-actions"])(
    "recognises %s as a bot even when the forge does not flag it",
    (author) => {
      const pulls: MergedPullRequest[] = [
        ...Array.from({ length: 10 }, () => ({ body: DEPENDABOT, author })),
        { body: HUMAN, author: "toyguncil" },
      ];
      const names = wroteConfig({ mergedPullRequests: () => pulls }).pr.sections.map((s) => s.name);
      expect(names).not.toContain("Release notes");
    },
  );

  it("leaves a pull request with no author at all in the sample", () => {
    const names = wroteConfig({
      mergedPullRequests: () => [{ body: HUMAN }, { body: HUMAN }],
    }).pr.sections.map((s) => s.name);
    expect(names).toContain("Summary");
  });
});

describe("runInit provenance", () => {
  // `validate` only checks the issue key when the section jira.section names is
  // present. Hardcoding "Issues Addressed" over sections called Summary/Ticket is
  // not a strict rule, it is a rule that never runs, and nothing said so.
  it("points jira.section at a section that exists", () => {
    const body = "## Summary\nx\n## Ticket\nhttps://x.example.com/jira/browse/ABC-1";
    const config = wroteConfig({ mergedPullRequests: () => byPeople([body, body]) });
    expect(config.pr.sections.map((s) => s.name)).toEqual(["Summary", "Ticket"]);
    expect(config.jira.section).toBe("Ticket");
    expect(
      validate({
        title: "feat(x): y",
        body: "## Summary\nx\n## Ticket\nno key here",
        config,
      }).findings.map((f) => f.rule),
    ).toContain("issue-key-missing");
  });

  // The section's *name* is observed; which of them holds issue keys is a guess
  // shipkit makes with a regex over the word "Ticket". Borrowing the section
  // list's label put shipkit's own guess in the one column of the file a reader
  // is meant to be able to trust.
  it("labels jira.section with its own provenance, not the section list's", () => {
    const body = "## Summary\nx\n## Ticket\nhttps://x.example.com/jira/browse/ABC-1";
    const { deps: d, written, out } = deps({
      sources: {
        rulesets: () => [],
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => byPeople([body, body, body]),
      },
    });
    runInit(OPTIONS, d);
    expect(configSchema.parse(parse(written[0])).jira.section).toBe("Ticket");
    // The sections it was drawn from are still observed — only the choice is not.
    expect(out.join("\n")).toContain("pr.sections: observed");
    expect(out.join("\n")).toContain("jira.section: proposed");

    const lines = written[0].split("\n");
    const at = lines.findIndex((line) => line.startsWith("  section:"));
    expect(lines[at - 1].trim()).toMatch(/^# proposed:/);
    expect(lines[at - 1]).toContain("the name is observed");
  });

  it("names jira.section unresolved when no section reads as where issues are cited", () => {
    const body = "## Summary\nx\n## Notes\ny";
    const { deps: d, written } = deps({
      sources: {
        rulesets: () => [],
        mergeGateWorkflow: () => undefined,
        mergedPullRequests: () => byPeople([body, body]),
      },
    });
    const result = runInit(OPTIONS, d);
    expect(result.unresolved).toContain("jira.section");
    expect(written[0]).toContain("will not run until this points at a section that exists");
  });

  it("comments every field, as the header promises", () => {
    const { deps: d, written } = deps();
    runInit(OPTIONS, d);
    const lines = written[0].split("\n");
    for (const key of [
      "titlePattern",
      "forbidden",
      "blockingLabels",
      "sections",
      "approval",
      "approvalTimeoutSeconds",
      "pattern",
      "baseUrl",
      "keyPattern",
      "linkPolicy",
      "section",
    ]) {
      const at = lines.findIndex((line) => line.startsWith(`  ${key}:`));
      expect(at, `${key} is not a top-level field of its group`).toBeGreaterThan(0);
      expect(lines[at - 1].trim(), `${key} carries no provenance comment`).toMatch(/^#/);
    }
  });

  // "counted as template text at 2 of 1" reads as a bug to anyone who opens it.
  it("does not report a threshold larger than the sample it was read from", () => {
    const { deps: d, written } = deps();
    runInit(OPTIONS, d);
    expect(written[0]).not.toMatch(/at 2 of 1\b/);
    expect(written[0]).toContain("one body cannot show that a line recurs");
  });
});
