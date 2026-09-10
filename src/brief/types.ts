import type { ShipkitConfig } from "../config/schema.js";

export type BriefSection = {
  name: string;
  required: boolean;
  minItems?: number;
  hint?: string;
};

export type Brief = {
  change: { branch: string; files: string[]; diffstat: string; commits: string[] };
  ticket?: {
    key: string;
    type: string;
    summary: string;
    cite: string;
    parent?: { key: string; type: string; summary: string };
  };
  target: { branch: string; reason: string };
  template: { sections: BriefSection[] };
  rules: {
    titlePattern: string;
    branchPattern: string;
    keyPattern: string;
    forbidden: string[];
    issuesSection: string;
    linkPolicy: ShipkitConfig["jira"]["linkPolicy"];
  };
};
