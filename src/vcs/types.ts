export class VcsError extends Error {}

export type RepoState = {
  branch: string;
  changedFiles: string[];
  diffstat: string;
  commits: string[];
};

/** One line this push adds, with the file it lands in. */
export type AddedLine = {
  path: string;
  text: string;
};

export type PullRequestState = {
  number: number;
  url: string;
  baseRefName: string;
  labels: string[];
  approvals: string[];
};
