import type { PreflightInput, PreflightResult, Warning } from "./types.js";

export type { PreflightInput, PreflightResult, Warning };

function foreignKeys(commits: string[], keyPattern: string, ticketKey: string): string[] {
  const pattern = new RegExp(keyPattern, "g");
  const found = new Set<string>();
  for (const subject of commits) {
    for (const match of subject.matchAll(pattern)) {
      if (match[0] !== ticketKey) found.add(match[0]);
    }
  }
  return [...found];
}

export function preflight(input: PreflightInput): PreflightResult {
  const { branch, base, commits, ticketKey, pullRequest, config } = input;
  const warnings: Warning[] = [];

  if (pullRequest !== null && pullRequest.approvals.length > 0) {
    warnings.push({
      check: "approvals-dismissed",
      message:
        `Pushing will dismiss ${pullRequest.approvals.length} existing approval(s) on ` +
        `#${pullRequest.number}: ${pullRequest.approvals.join(", ")}`,
    });
  }

  if (ticketKey !== undefined) {
    const foreign = foreignKeys(commits, config.jira.keyPattern, ticketKey);
    if (foreign.length > 0) {
      warnings.push({
        check: "foreign-commits",
        message:
          `Branch "${branch}" carries commits citing ${foreign.join(", ")}, not ${ticketKey}. ` +
          `They will appear in this pull request.`,
      });
    }
  }

  if (pullRequest !== null && pullRequest.baseRefName !== base) {
    warnings.push({
      check: "base-mismatch",
      message:
        `Pull request #${pullRequest.number} targets ${pullRequest.baseRefName}, ` +
        `but this run targets ${base}`,
    });
  }

  if (pullRequest !== null) {
    const blocking = new Set(config.pr.blockingLabels.map((l) => l.toLowerCase()));
    const present = pullRequest.labels.filter((l) => blocking.has(l.toLowerCase()));
    if (present.length > 0) {
      warnings.push({
        check: "blocking-label",
        message: `Label(s) ${present.join(", ")} will block the merge gate`,
      });
    }
  }

  if (ticketKey !== undefined && !input.issueVerified) {
    warnings.push({
      check: "issue-unverified",
      message:
        `${ticketKey} could not be checked against Jira, so the issue-level rule did not run. ` +
        `Set SHIPKIT_JIRA_TOKEN to verify the cited key is at Story or Bug level.`,
    });
  }

  return { warnings };
}
