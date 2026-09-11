import type { ShipkitConfig } from "../config/schema.js";
import type { PullRequestState } from "../vcs/types.js";

export type Warning = {
  check: string;
  message: string;
};

export type PreflightInput = {
  branch: string;
  base: string;
  commits: string[];
  ticketKey?: string;
  /** False when a key was derived but Jira could not be consulted — see `issue-unverified`. */
  issueVerified: boolean;
  pullRequest: PullRequestState | null;
  /** Untracked, non-ignored paths that staging would sweep into the commit. */
  untrackedFiles: string[];
  config: ShipkitConfig;
};

export type PreflightResult = {
  warnings: Warning[];
};
