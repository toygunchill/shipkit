import type { Brief } from "../brief/types.js";
import type { SubmitResult } from "../submit/run.js";

export type ToolContent = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

function text(lines: string[], structured: Record<string, unknown>, isError: boolean): ToolContent {
  return {
    content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
    structuredContent: structured,
    isError,
  };
}

export function briefContent(brief: Brief): ToolContent {
  return text(
    [
      `Target: ${brief.target.branch} (${brief.target.reason})`,
      `Sections to fill: ${brief.template.sections.map((s) => s.name).join(", ")}`,
      `Title must match: ${brief.rules.titlePattern}`,
    ],
    brief as unknown as Record<string, unknown>,
    false,
  );
}

function warningIds(result: SubmitResult): string[] {
  return result.warnings.map((warning) => warning.check);
}

// The ids alone are what `apply` requires echoed back in `acknowledge`; the messages are what
// make those ids mean anything to whoever — human or agent — decides whether to send them.
// Carrying only `check` in structuredContent left the message reachable solely by parsing the
// prose in `content[0].text`.
function structuredWarnings(result: SubmitResult): { check: string; message: string }[] {
  return result.warnings.map((warning) => ({ check: warning.check, message: warning.message }));
}

/**
 * Advice, for the one caller that cannot hear it any other way. The MCP server discards
 * `out` and `err` — stdout is the protocol channel — so an observation printed by
 * `runSubmit` and not carried here reaches nobody, which is the whole failure this wiring
 * exists to close.
 *
 * Kept out of `warnings` in the structured content as firmly as it is kept out of the type:
 * an agent reading `warnings` and echoing the ids back in `acknowledge` must never find a
 * topic there that no gate ever asked about.
 */
function structuredAdvice(result: SubmitResult): { topic: string; message: string }[] {
  return (result.advice ?? []).map((item) => ({ topic: item.topic, message: item.message }));
}

function adviceLines(result: SubmitResult): string[] {
  return (result.advice ?? []).map((item) => item.message);
}

function findingLines(result: SubmitResult): string[] {
  return result.findings.map((finding) => `${finding.rule}: ${finding.message}`);
}

function warningLines(result: SubmitResult): string[] {
  return result.warnings.map((warning) => `${warning.check}: ${warning.message}`);
}

export function previewContent(result: SubmitResult): ToolContent {
  const structured = {
    findings: findingLines(result),
    warnings: structuredWarnings(result),
    advice: structuredAdvice(result),
    body: result.body ?? "",
  };

  if (result.code === 1) {
    return text(
      ["The answer does not comply. Nothing was changed.", ...findingLines(result)],
      structured,
      true,
    );
  }

  // `runSubmit` returns code 2 as data — not a throw — for an invalid base and for every
  // ConfigError, VcsError, ResponseError and JiraError it catches. None of those reach
  // `handlePreview`'s try/catch, so without this branch they fall through to the "Ready to
  // apply" text below: a preview that never ran reported as one that found nothing wrong.
  if (result.code === 2) {
    return text(
      [result.message ?? "Preview failed.", ...findingLines(result), ...warningLines(result)],
      structured,
      true,
    );
  }

  return text(
    [
      result.warnings.length === 0
        ? "Ready to apply. No warnings."
        : "Ready to apply, with warnings. Pass these ids to shipkit_apply as acknowledge:",
      ...warningLines(result),
      ...adviceLines(result),
    ],
    structured,
    false,
  );
}

export function applyContent(result: SubmitResult): ToolContent {
  const structured: Record<string, unknown> = {
    findings: findingLines(result),
    warnings: structuredWarnings(result),
    advice: structuredAdvice(result),
    committed: result.committed,
    pushed: result.pushed,
  };
  if (result.body !== undefined) structured.body = result.body;
  if (result.url !== undefined) structured.url = result.url;
  if (result.updated !== undefined) structured.updated = result.updated;

  if (result.code === 0) {
    return text(
      [
        result.updated === true ? `Updated ${result.url}` : `Opened ${result.url}`,
        ...adviceLines(result),
      ],
      structured,
      false,
    );
  }

  const lines = [result.message ?? "Refused.", ...findingLines(result), ...warningLines(result)];

  // `result.refusal` names the exact gate reason, so this is appended only when
  // acknowledging the ids is actually the remedy. Guessing from `warnings.length` and
  // `findings.length` alone (as this once did) also matches "denied", "timed-out",
  // "no-surface" and "human-required" — none of which acknowledge: [...] can fix — and
  // would send an agent calling `shipkit_apply` again with the same ids into an
  // identical refusal.
  if (result.refusal === "unacknowledged") {
    lines.push(
      `Call again with acknowledge: [${warningIds(result).map((id) => `"${id}"`).join(", ")}] to proceed.`,
    );
  }

  // Half-done is the state a caller is least likely to guess and most needs told.
  if (result.committed) {
    lines.push(
      result.pushed
        ? "A commit was created and pushed; no pull request was opened."
        : "A commit was created locally and has not been pushed.",
    );
  }

  return text(lines, structured, true);
}

export function failureContent(message: string): ToolContent {
  return text([message], { message }, true);
}
