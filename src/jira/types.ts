export class JiraError extends Error {}

export type IssueRef = {
  key: string;
  type: string;
  summary: string;
};

export type IssueFacts = IssueRef & {
  parent?: IssueRef;
};
