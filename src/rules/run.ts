import { propose } from "./propose.js";
import { renderRules } from "./render.js";
import type { Survey } from "./survey.js";

export type RulesOptions = {
  /** Where to write. Absent means stdout, so the command composes. */
  out?: string | undefined;
  force: boolean;
};

export type RulesDeps = {
  survey: () => Survey;
  exists: (path: string) => boolean;
  write: (path: string, text: string) => void;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type RulesResult = {
  code: 0 | 2;
  /** The file's text, whether it was written or printed. */
  text?: string;
  path?: string;
  message?: string;
};

/**
 * Proposes a readiness ruleset from the code, and writes nothing anybody has not asked for.
 *
 * Nothing here points a config at the result, and nothing here enforces it. The output is a
 * draft with its evidence written beside every line — the same contract `init` has, for the
 * same reason: a file a team has not read is a file a team does not follow.
 */
export function runRules(options: RulesOptions, deps: RulesDeps): RulesResult {
  const survey = deps.survey();
  const proposals = propose(survey);

  if (proposals.rules.length === 0) {
    // Refused rather than written empty. The readiness schema requires at least one rule, so
    // an empty file would not load — and a file that cannot load is a worse answer than a
    // sentence saying there was nothing to propose.
    const message = [
      "Nothing in this repository matched a rule shipkit knows how to look for, so there is",
      "nothing to propose. Nothing was written.",
      "",
      "That is a statement about this catalogue, not about your code. Write the checklist by",
      "hand — docs/examples/example-app.readiness.yml is one that was extracted by reading a",
      "team's code and its review comments, which is the part no command can do for you.",
    ].join("\n");
    deps.err(message);
    return { code: 2, message };
  }

  const text = renderRules(proposals, survey.files.length, survey.capped);

  if (options.out === undefined) {
    deps.out(text);
    return { code: 0, text };
  }

  if (deps.exists(options.out) && !options.force) {
    const message = `${options.out} already exists. Pass --force to overwrite it, or --out to write elsewhere.`;
    deps.err(message);
    return { code: 2, message };
  }

  deps.write(options.out, text);
  deps.err(
    `${proposals.rules.length} rule${proposals.rules.length === 1 ? "" : "s"} written to ${options.out}. ` +
      "Read it before anything points at it: every line says what it was derived from, and " +
      "all of them are `advise`, which never gates a push.",
  );
  return { code: 0, text, path: options.out };
}
