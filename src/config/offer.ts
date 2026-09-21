import { createInterface } from "node:readline";
import { discoverConfig, explainDiscovery } from "./discover.js";

/**
 * Offers to set a repository up when it has no conventions file yet.
 *
 * Only ever asked at a terminal. An agent and a CI job both reach this code, and a prompt
 * there is a process that hangs until something kills it — so with no TTY the offer is not
 * made and the explanation is printed instead, which is what a caller can act on.
 *
 * Nothing is created without a yes. The whole point of `init` is that a team reads what it
 * wrote before trusting it, and a file created silently is one nobody read.
 */
export type OfferDeps = {
  isInteractive: () => boolean;
  ask: (question: string) => Promise<string>;
  runInit: () => Promise<number>;
  err: (line: string) => void;
};

export type OfferOutcome = "ready" | "declined" | "not-interactive" | "ambiguous";

export async function offerSetup(root: string, deps: OfferDeps): Promise<OfferOutcome> {
  const discovery = discoverConfig(root);
  if (discovery.found === "one") return "ready";

  // Several is never something to fix by creating a sixth file.
  if (discovery.found === "several") {
    deps.err(explainDiscovery(discovery, root));
    return "ambiguous";
  }

  if (!deps.isInteractive()) {
    deps.err(explainDiscovery(discovery, root));
    return "not-interactive";
  }

  deps.err(
    "This repository has no conventions file, so shipkit does not know what to check " +
      "against — it keeps no rules of its own.",
  );
  const answer = (await deps.ask("Write one now from what your forge and your code can prove? [Y/n] "))
    .trim()
    .toLowerCase();
  // Empty means the default, which is yes: the person was asked, and pressing return at a
  // prompt whose default is spelled out is an answer.
  if (answer !== "" && answer !== "y" && answer !== "yes") {
    deps.err("Nothing was created. Run `shipkit init` when you want one.");
    return "declined";
  }

  const code = await deps.runInit();
  if (code !== 0) return "declined";
  deps.err("Read what it wrote before trusting it — every value says where it came from.");
  return "ready";
}

/** The real prompt. Closes the interface whatever the answer, so the process can exit. */
export function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
