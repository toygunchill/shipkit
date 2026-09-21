import { Document } from "yaml";
import type { Inferred, SectionSkeleton } from "./types.js";
import type { JiraGuess } from "./jira.js";

/** Everything `init` writes, each field carrying where it came from. */
export type InitDraft = {
  /** Where the readiness checklist went, sibling-relative. Absent when none was proposed. */
  readinessFile?: string | undefined;
  titlePattern: Inferred<string>;
  branchPattern: Inferred<string>;
  forbidden: Inferred<string[]>;
  blockingLabels: Inferred<string[]>;
  sections: Inferred<SectionSkeleton[]>;
  jira: Inferred<JiraGuess>;
  /**
   * Which section the issue-key rule reads. Part of the draft rather than a
   * constant here because it has to name a section that actually exists: naming
   * one that doesn't is not a stricter config, it is a rule that never runs.
   */
  jiraSection: Inferred<string>;
};

/**
 * The three fields nothing can be inferred about, carrying their reasons anyway.
 *
 * The header promises every field says where it came from, and four fields used
 * to carry no comment at all. A constant is still a choice somebody made for you,
 * which is the whole content of the `proposed` label.
 */
const APPROVAL: Inferred<string> = {
  value: "echo",
  provenance: "proposed",
  why:
    "acknowledging the warning ids is enough. Never `human` from `init`: that mode " +
    "refuses every warned push until the approval app is installed and running",
};

const APPROVAL_TIMEOUT: Inferred<number> = {
  value: 120,
  provenance: "proposed",
  why: "long enough to read three warnings and click, short enough not to outlast an agent's own tool call",
};

const LINK_POLICY: Inferred<string> = {
  value: "story",
  provenance: "proposed",
  why: "cite the story rather than its sub-task; nothing on a forge or in a body states this preference",
};

/**
 * The header carries what each label means, once. Per-field comments then say
 * only the label and the evidence.
 *
 * An earlier draft repeated the meaning above every field, and reading the
 * result made the case against it: the same sentence three times in thirty
 * lines is how a file teaches people to skip its comments, which costs more
 * than the explanation gains.
 */
const HEADER = `Written by \`shipkit init\`. Every field below says where it came from:

  read      the forge proved it — a fact, not a guess
  observed  merged pull requests actually contain this — true of the past,
            which is not the same as intended
  proposed  shipkit's suggestion — your call

Edit the observed and proposed values. The point of this file is to hold new
pull requests to a baseline you chose, not to the average of the old ones.`;

function note(inferred: Inferred<unknown>): string {
  return ` ${inferred.provenance}: ${inferred.why}`;
}

/**
 * Renders the draft as YAML that `configSchema` accepts, with a provenance
 * comment above every field.
 *
 * Serialisation goes through the `yaml` package's `Document` rather than string
 * building. A pattern like `ABC-\d+` written by interpolation comes back from
 * the parser as `ABC-d+` — a regular expression that silently matches nothing,
 * in the field whose whole job is matching. The comments are attached to each
 * pair's *key* node; putting them on the value node is also valid YAML but
 * pushes the value onto its own line, which reads as a mistake.
 */
export function renderConfig(draft: InitDraft): string {
  const doc = new Document({
    pr: {
      titlePattern: draft.titlePattern.value,
      forbidden: draft.forbidden.value,
      blockingLabels: draft.blockingLabels.value,
      sections: draft.sections.value.map((section) => ({
        name: section.name,
        required: section.required,
        ...(section.minItems === undefined ? {} : { minItems: section.minItems }),
      })),
      approval: APPROVAL.value,
      approvalTimeoutSeconds: APPROVAL_TIMEOUT.value,
    },
    // Only when one was proposed. An absent key means no checklist, which is the correct
    // state for a repository that has none — a key pointing at a file that is not there
    // makes every later run refuse.
    ...(draft.readinessFile === undefined ? {} : { readiness: draft.readinessFile }),
    branch: { pattern: draft.branchPattern.value },
    jira: {
      baseUrl: draft.jira.value.baseUrl ?? "https://jira.example.com",
      keyPattern: draft.jira.value.keyPattern ?? "[A-Z]+-\\d+",
      linkPolicy: LINK_POLICY.value,
      section: draft.jiraSection.value,
    },
  });

  doc.commentBefore = HEADER.split("\n")
    .map((line) => (line === "" ? "" : ` ${line}`))
    .join("\n");

  comment(doc, ["pr", "titlePattern"], draft.titlePattern);
  comment(doc, ["pr", "forbidden"], draft.forbidden);
  comment(doc, ["pr", "blockingLabels"], draft.blockingLabels);
  comment(doc, ["pr", "sections"], draft.sections);
  comment(doc, ["pr", "approval"], APPROVAL);
  comment(doc, ["pr", "approvalTimeoutSeconds"], APPROVAL_TIMEOUT);
  comment(doc, ["branch", "pattern"], draft.branchPattern);
  comment(doc, ["jira", "baseUrl"], draft.jira);
  comment(doc, ["jira", "keyPattern"], draft.jira);
  comment(doc, ["jira", "linkPolicy"], LINK_POLICY);
  comment(doc, ["jira", "section"], draft.jiraSection);

  return doc.toString({ lineWidth: 0 });
}

/** Attaches a provenance note above one key, leaving the document alone if the key is absent. */
function comment(doc: Document, path: string[], inferred: Inferred<unknown>): void {
  const parent = doc.getIn(path.slice(0, -1), true) as { items?: { key?: { value?: unknown; commentBefore?: string } }[] };
  const last = path[path.length - 1];
  const pair = parent?.items?.find((item) => item.key?.value === last);
  if (pair?.key === undefined) return;
  pair.key.commentBefore = note(inferred);
}
