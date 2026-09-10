import { describe, expect, it } from "vitest";
import { baseCandidates, defaultBranch } from "../../src/vcs/github.js";

const fake = (replies: Record<string, string>) => (args: string[]): string => {
  const key = args.join(" ");
  const match = Object.keys(replies).find((k) => key.includes(k));
  if (!match) throw new Error(`unexpected gh call: ${key}`);
  return replies[match];
};

describe("defaultBranch", () => {
  it("reads the repository default", () => {
    const run = fake({ "defaultBranchRef": JSON.stringify({ defaultBranchRef: { name: "develop" } }) });
    expect(defaultBranch(run)).toBe("develop");
  });
});

describe("baseCandidates", () => {
  it("puts the default branch first and adds release branches", () => {
    const run = fake({
      "defaultBranchRef": JSON.stringify({ defaultBranchRef: { name: "develop" } }),
      "api repos": JSON.stringify([
        { name: "release/3.75.0" },
        { name: "release/3.76.0" },
        { name: "develop" },
      ]),
    });
    expect(baseCandidates(run)).toEqual(["develop", "release/3.75.0", "release/3.76.0"]);
  });
});
