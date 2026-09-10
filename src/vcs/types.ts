export class VcsError extends Error {}

export type RepoState = {
  branch: string;
  changedFiles: string[];
  diffstat: string;
  commits: string[];
};

export type PullRequestState = {
  number: number;
  url: string;
  baseRefName: string;
  labels: string[];
  approvals: string[];
};
