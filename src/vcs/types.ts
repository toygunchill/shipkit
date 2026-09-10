export class VcsError extends Error {}

export type RepoState = {
  branch: string;
  changedFiles: string[];
  diffstat: string;
  commits: string[];
};

export type PullRequestState = {
  number: number;
  baseRefName: string;
  labels: string[];
  approvals: string[];
};
