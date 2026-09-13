import { describe, expect, it } from "vitest";
import { deriveTeam, derivePortfolioChild, pickSprint } from "../../src/jira/derive.js";

const teams = (...names: string[]) => names.map((team) => ({ team }));

describe("deriveTeam", () => {
  it("takes a clear majority", () => {
    expect(deriveTeam(teams("Squad B", "Squad B", "Squad B", "Squad A"))).toEqual({ value: "Squad B" });
  });

  // Measured: one issue in a Squad A sprint carried Squad B. People move.
  it("refuses a plurality that is not a majority, and says what it saw", () => {
    const got = deriveTeam(teams("Squad B", "Squad B", "Squad D", "Squad D", "Squad C"));
    expect(got).toHaveProperty("unresolved");
    expect((got as { candidates: string[] }).candidates).toContain("Squad B");
  });

  it("refuses an empty sample rather than inventing a team", () => {
    expect(deriveTeam([])).toHaveProperty("unresolved");
  });
});

describe("derivePortfolioChild", () => {
  it("refuses the Squad D shape, which has no majority", () => {
    const sample = [
      ...Array(22).fill({ portfolioChild: "Portfolio A" }),
      ...Array(18).fill({ portfolioChild: "Portfolio C" }),
      ...Array(11).fill({ portfolioChild: "Portfolio D" }),
      ...Array(7).fill({ portfolioChild: "Digital MCP Tool" }),
    ];
    expect(derivePortfolioChild(sample)).toHaveProperty("unresolved");
  });

  it("takes the Squad A shape, which is 55 of 60", () => {
    const sample = [
      ...Array(55).fill({ portfolioChild: "Portfolio A" }),
      ...Array(5).fill({ portfolioChild: "Example Diğer" }),
    ];
    expect(derivePortfolioChild(sample)).toEqual({ value: "Portfolio A" });
  });
});

describe("pickSprint", () => {
  const active = [
    { id: 1251, name: "Squad D Sprint 45" },
    { id: 1249, name: "Squad C Sprint 45" },
    { id: 1243, name: "Squad A Sprint 45" },
    { id: 1234, name: "Squad B Sprint 45" },
  ];

  it("matches the sprint belonging to the team", () => {
    expect(pickSprint(active, "Squad A")).toEqual({ value: 1243 });
  });

  // Six teams exist; four had a sprint when this was measured.
  it("refuses when the team has no active sprint", () => {
    expect(pickSprint(active, "Squad F")).toHaveProperty("unresolved");
  });

  it("refuses when two sprints could match rather than taking the first", () => {
    const ambiguous = [{ id: 1, name: "Squad A Sprint 45" }, { id: 2, name: "Squad A Hotfix 45" }];
    expect(pickSprint(ambiguous, "Squad A")).toHaveProperty("unresolved");
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief. These pin the two things the brief left implicit, and the
// one place where the spec's prose and its own numbers disagree.
// ---------------------------------------------------------------------------

describe("the denominator for a majority", () => {
  // MAJORITY_DENOMINATOR: only issues carrying a value for the field. An issue
  // with the field left blank is an absence of evidence, not a vote against the
  // value everyone who did fill it in agreed on. Counting blanks would make the
  // answer depend on how many unfilled issues the sample happened to sweep up —
  // noise the developer cannot act on, producing a refusal they cannot fix by
  // fixing anything. None of the four measured teams changes outcome either way
  // (Squad D 22/58 and 22/60 both refuse; Squad A 55/60 and 55/60 both pass),
  // so the choice is settled here, on synthetic data, or it is not settled at all.
  it("counts only the issues that carry the field, not every issue sampled", () => {
    const sample = [
      ...Array(3).fill({ team: "Squad B" }),
      ...Array(4).fill({}), // assigned, but Digital Team never filled in
    ];
    // 3 of 3 that answered, versus 3 of 7 sampled. The first is a majority.
    expect(deriveTeam(sample)).toEqual({ value: "Squad B" });
  });

  it("treats a blank string as not carrying a value", () => {
    expect(deriveTeam([{ team: "Squad B" }, { team: "" }, { team: "   " }])).toEqual({
      value: "Squad B",
    });
  });

  it("refuses when nobody filled the field in, rather than reading unanimity into silence", () => {
    expect(derivePortfolioChild([{}, {}, {}])).toHaveProperty("unresolved");
  });
});

describe("what a refusal hands back", () => {
  it("names the flag that unblocks it", () => {
    const team = deriveTeam(teams("Squad B", "Squad D"));
    expect((team as { unresolved: string }).unresolved).toContain("--team");

    const portfolio = derivePortfolioChild([
      { portfolioChild: "Portfolio D" },
      { portfolioChild: "Digital MCP Tool" },
    ]);
    expect((portfolio as { unresolved: string }).unresolved).toContain("--portfolio");

    const sprint = pickSprint([{ id: 1, name: "Squad C Sprint 45" }], "Squad F");
    expect((sprint as { unresolved: string }).unresolved).toContain("--sprint");
  });

  it("lists the candidates commonest first, so a person can see how close it was", () => {
    const got = deriveTeam(teams("Squad C", "Squad D", "Squad D", "Squad B", "Squad B", "Squad B"));
    expect((got as { candidates: string[] }).candidates).toEqual(["Squad B", "Squad D", "Squad C"]);
  });

  it("offers the sprints that do exist when the team's own sprint does not", () => {
    const got = pickSprint([{ id: 1251, name: "Squad D Sprint 45" }, { id: 1234, name: "Squad B Sprint 45" }], "Squad F");
    expect((got as { candidates: string[] }).candidates).toEqual(["Squad D Sprint 45", "Squad B Sprint 45"]);
  });
});

describe("the Squad B portfolio split, 36/20", () => {
  // An earlier draft of the spec narrated this as one of two teams with "no
  // majority at all". The arithmetic said otherwise and the spec now agrees: 36
  // of the 59 that carry a value is 61%, a majority on every denominator the
  // spec gives. Under the rule it mandates — strictly more than half — this team
  // resolves. Raising MAJORITY_THRESHOLD to 2/3 is what would refuse it, and the
  // spec rejects two thirds explicitly: the only personal sample measured sits at
  // 68%, so a two-thirds rule would decide it by 1.6 points. This is the test
  // that would have to change if that were ever revisited.
  it("resolves under a strictly-more-than-half threshold, as the spec now reads", () => {
    const sample = [
      ...Array(36).fill({ portfolioChild: "Portfolio B" }),
      ...Array(20).fill({ portfolioChild: "Portfolio A" }),
    ];
    expect(derivePortfolioChild(sample)).toEqual({ value: "Portfolio B" });
  });
});

describe("the majority boundary", () => {
  it("refuses an exact half, which is not strictly more than half", () => {
    expect(deriveTeam(teams("Squad B", "Squad B", "Squad C", "Squad C"))).toHaveProperty("unresolved");
  });

  it("takes one more than half", () => {
    expect(deriveTeam(teams("Squad B", "Squad B", "Squad B", "Squad C", "Squad C"))).toEqual({
      value: "Squad B",
    });
  });
});

describe("pickSprint matching", () => {
  it("does not let one team's name prefix another's", () => {
    // "Squad A" and "Squad E" are both real teams; a bare startsWith on the
    // team name alone would make the Squad E sprint a candidate for Squad A.
    const active = [{ id: 1, name: "Squad E Sprint 45" }, { id: 2, name: "Squad A Sprint 45" }];
    expect(pickSprint(active, "Squad A")).toEqual({ value: 2 });
  });

  it("refuses an empty board rather than inventing a sprint", () => {
    expect(pickSprint([], "Squad A")).toHaveProperty("unresolved");
  });
});
