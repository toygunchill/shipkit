import { JiraError, type IssueFacts, type IssueRef } from "./types.js";

export { JiraError };
export type { IssueFacts, IssueRef };

export type Fetcher = (url: string, token: string) => Promise<unknown>;

const defaultFetcher: Fetcher = async (url, token) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new JiraError(`Jira responded ${response.status} for ${url}`);
  }
  return response.json();
};

type RawIssue = {
  key?: string;
  fields?: {
    summary?: string;
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string; issuetype?: { name?: string } } };
  };
};

function toRef(key: string | undefined, type: string | undefined, summary: string | undefined): IssueRef {
  if (key === undefined || type === undefined) {
    throw new JiraError("Jira issue is missing its key or type");
  }
  return { key, type, summary: summary ?? "" };
}

export async function fetchIssue(
  baseUrl: string,
  key: string,
  token: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<IssueFacts> {
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/2/issue/${encodeURIComponent(key)}`;

  let raw: unknown;
  try {
    raw = await fetcher(url, token);
  } catch (error) {
    if (error instanceof JiraError) throw error;
    throw new JiraError(`Cannot reach Jira for ${key}: ${(error as Error).message}`);
  }

  const issue = raw as RawIssue;
  if (issue.key === undefined || issue.fields === undefined) {
    throw new JiraError(`Jira returned no issue for ${key}`);
  }

  const facts: IssueFacts = toRef(issue.key, issue.fields.issuetype?.name, issue.fields.summary);
  const parent = issue.fields.parent;
  if (parent !== undefined) {
    return {
      ...facts,
      parent: toRef(parent.key, parent.fields?.issuetype?.name, parent.fields?.summary),
    };
  }
  return facts;
}
