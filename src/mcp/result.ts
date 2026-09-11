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

function findingLines(result: SubmitResult): string[] {
  return result.findings.map((finding) => `${finding.rule}: ${finding.message}`);
}

function warningLines(result: SubmitResult): string[] {
  return result.warnings.map((warning) => `${warning.check}: ${warning.message}`);
}

export function previewContent(result: SubmitResult): ToolContent {
  const structured = {
    findings: findingLines(result),
    warnings: warningIds(result),
    body: result.body ?? "",
  };

  if (result.code === 1) {
    return text(
      ["The answer does not comply. Nothing was changed.", ...findingLines(result)],
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
    ],
    structured,
    false,
  );
}

export function applyContent(result: SubmitResult): ToolContent {
  const structured: Record<string, unknown> = {
    findings: findingLines(result),
    warnings: warningIds(result),
    committed: result.committed,
    pushed: result.pushed,
  };
  if (result.body !== undefined) structured.body = result.body;
  if (result.url !== undefined) structured.url = result.url;
  if (result.updated !== undefined) structured.updated = result.updated;

  if (result.code === 0) {
    return text(
      [result.updated === true ? `Updated ${result.url}` : `Opened ${result.url}`],
      structured,
      false,
    );
  }

  const lines = [result.message ?? "Refused.", ...findingLines(result), ...warningLines(result)];

  if (result.warnings.length > 0 && result.findings.length === 0) {
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
