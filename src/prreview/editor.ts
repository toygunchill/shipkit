import { randomBytes } from "node:crypto";
import { createHandler, listen } from "../review/server.js";
import { applyKept, parseKept, renderPrPage, type KeptRemark } from "./page.js";
import type { Prepared } from "./run.js";
import type { AcceptedRemark } from "./validate.js";

/**
 * Serving the editor and waiting for one answer.
 *
 * The same loopback-and-token server the local review page already uses. Only the page and
 * the shape of the answer differ, which is why `createHandler` takes its reader as a
 * dependency rather than either page knowing about the other.
 *
 * One answer, then the server stops. There is deliberately no second chance: by the time a
 * person could give one, the first has already been published.
 */

export type EditorOutcome =
  | { answered: "publish"; remarks: AcceptedRemark[] }
  | { answered: "nothing" };

export type EditorDeps = {
  prepared: Prepared;
  title: string;
  diff: string;
  port: number;
  /** Opens the page. Omitted to print the URL and let the person open it. */
  open?: ((url: string) => void) | undefined;
  out: (line: string) => void;
};

export async function runEditor(deps: EditorDeps): Promise<EditorOutcome> {
  const { prepared } = deps;
  const accepted = prepared.validation.accepted;
  const token = randomBytes(24).toString("base64url");

  const page = renderPrPage({
    token,
    repository: `${prepared.target.owner}/${prepared.target.repo}`,
    number: prepared.target.number,
    title: deps.title,
    author: prepared.author,
    mine: prepared.mine,
    diff: deps.diff,
    accepted,
    rejected: prepared.validation.rejected,
  });

  let settle: (outcome: EditorOutcome) => void = () => {};
  const answered = new Promise<EditorOutcome>((resolve) => {
    settle = resolve;
  });

  const handler = createHandler<KeptRemark>({
    token,
    page,
    parse: (body) => parseKept(body, accepted.length),
    submit: (kept) => {
      settle(
        kept.length === 0
          ? { answered: "nothing" }
          : { answered: "publish", remarks: applyKept(accepted, kept) },
      );
    },
    // Nothing is opened from this page. The change belongs to somebody else and may exist
    // in no checkout here, so an "open in editor" button would be an offer shipkit cannot
    // keep.
    openable: new Set<string>(),
  });

  const listening = await listen(handler, deps.port);
  try {
    const url = `${listening.origin}/?token=${encodeURIComponent(token)}`;
    if (deps.open !== undefined) {
      deps.open(url);
      deps.out(`Review open at ${url}`);
    } else {
      deps.out(`Review at ${url}`);
    }
    return await answered;
  } finally {
    // After the answer, whichever way it went. The handler has already written its 200 by
    // the time the promise resolves, so the page still shows what happened.
    await listening.close();
  }
}
