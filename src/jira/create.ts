/**
 * The one write in shipkit that leaves the repository.
 *
 * Everything else this tool does is a read, a file it wrote itself, or a git operation the
 * developer could undo. Creating a Jira issue is none of those: there is no `--undo`, and a
 * ticket opened by mistake is a row somebody else has to notice and close. So this module
 * is as small as it can be — one call, no retry, no fallback to a second shape of request —
 * and it is reached only from a command a person typed, past every refusal in `tech-task`.
 *
 * The POST mirrors the GET in `src/jira/client.ts`: the same `Bearer` header, the same
 * redaction of the token out of any message, the same `JiraError` on the way out. The seam
 * is injected for the same reason it is there, except that here no test crosses it at all —
 * asserting on `buildCreatePayload` is how the create path is tested, because a test that
 * exercised this function would be one edit away from opening real tickets.
 */

import { JiraError } from "./types.js";

/** Sends the payload and answers with the created key. Injected, so the caller decides what "send" means. */
export type IssueCreator = (payload: Record<string, unknown>, token: string) => Promise<{ key: string }>;

/** The transport seam: a POST that returns parsed JSON, or throws. */
export type Poster = (url: string, token: string, body: unknown) => Promise<unknown>;

const defaultPoster: Poster = async (url, token, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Jira answers a rejected create with the field that rejected it, and that text is the
    // most useful thing this command can say — a required field nobody knew about reads as
    // "Field 'customfield_xxxxx' is required" and names itself.
    const detail = await response.text().catch(() => "");
    throw new JiraError(
      `Jira responded ${response.status} for ${url}${detail.trim().length > 0 ? `: ${detail.trim()}` : ""}`,
    );
  }
  return response.json();
};

function redactToken(message: string, token: string): string {
  return message.split(token).join("[redacted]");
}

/**
 * Creates one issue from an already-assembled payload.
 *
 * Takes the payload rather than building it, so that the thing shown by `--dry-run` and the
 * thing sent are the same object and cannot drift apart.
 */
export async function createIssue(
  baseUrl: string,
  payload: Record<string, unknown>,
  token: string,
  poster: Poster = defaultPoster,
): Promise<{ key: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/2/issue`;

  let raw: unknown;
  try {
    raw = await poster(url, token, payload);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactToken(rawMessage, token);
    if (error instanceof JiraError) throw new JiraError(message);
    throw new JiraError(`Cannot reach Jira to create the issue: ${message}`);
  }

  const key = (raw as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || key.length === 0) {
    // The issue may well exist at this point — the POST succeeded — so this says what it
    // knows rather than implying nothing happened.
    throw new JiraError("Jira accepted the create but returned no issue key");
  }
  return { key };
}

/** `createIssue` bound to one Jira, in the shape the command holds it. */
export function issueCreator(baseUrl: string, poster: Poster = defaultPoster): IssueCreator {
  return (payload, token) => createIssue(baseUrl, payload, token, poster);
}
