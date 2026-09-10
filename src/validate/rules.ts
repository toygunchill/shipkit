import type { Section, ShipkitConfig } from "../config/schema.js";
import { parseBody } from "./body.js";
import type { Finding, ValidationResult } from "./types.js";

export type ValidateInput = {
  title: string;
  body: string;
  config: ShipkitConfig;
};

function countItems(content: string): number {
  return content
    .split("\n")
    .filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
}

export function validate({ title, body, config }: ValidateInput): ValidationResult {
  const findings: Finding[] = [];
  const parsed = parseBody(body);

  if (!new RegExp(config.pr.titlePattern).test(title)) {
    findings.push({
      rule: "title-pattern",
      message: `Title does not match ${config.pr.titlePattern}`,
    });
  }

  for (const term of config.pr.forbidden) {
    if (body.includes(term)) {
      findings.push({
        rule: "forbidden-text",
        message: `Body still contains ${JSON.stringify(term)}`,
      });
    }
  }

  for (const section of config.pr.sections) {
    findings.push(...checkSection(section, parsed.sections[section.name]));
  }

  const issuesSection = config.jira.section;
  const issues = parsed.sections[issuesSection];
  if (issues !== undefined && !new RegExp(config.jira.keyPattern).test(issues)) {
    findings.push({
      rule: "issue-key-missing",
      message: `${issuesSection} has no key matching ${config.jira.keyPattern}`,
      section: issuesSection,
    });
  }

  return { ok: findings.length === 0, findings };
}

function checkSection(section: Section, content: string | undefined): Finding[] {
  if (content === undefined) {
    return section.required
      ? [{
          rule: "section-missing",
          message: `Required section "${section.name}" is absent`,
          section: section.name,
        }]
      : [];
  }

  if (section.required && content.length === 0) {
    return [{
      rule: "section-empty",
      message: `Required section "${section.name}" is empty`,
      section: section.name,
    }];
  }

  if (section.minItems !== undefined && countItems(content) < section.minItems) {
    return [{
      rule: "section-min-items",
      message: `"${section.name}" needs at least ${section.minItems} items`,
      section: section.name,
    }];
  }

  return [];
}
