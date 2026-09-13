export type Provenance = "read" | "observed" | "proposed";

export type Inferred<T> = {
  value: T;
  provenance: Provenance;
  why: string;
};

export type SectionSkeleton = {
  name: string;
  required: boolean;
  minItems?: number;
};
