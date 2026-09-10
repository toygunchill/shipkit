export type Finding = {
  rule: string;
  message: string;
  section?: string;
};

export type ValidationResult = {
  ok: boolean;
  findings: Finding[];
};
