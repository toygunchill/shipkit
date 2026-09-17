import type { AddedLine } from "../vcs/types.js";

/**
 * Pragmas that happen to be spelled as comments. `// MARK:` is how the file is divided into
 * sections and `// swiftlint:` is how a rule is silenced: neither is an explanation, and
 * asking about them would train the reader to acknowledge without looking.
 */
const PRAGMA = /^\/\/\s*(MARK:|swiftlint:|periphery:|sourcery:)/;

/** A documentation comment, which is asked about wherever it sits — see below. */
const DOC_COMMENT = /^\/{3}/;

/** A comment, once the line's indentation has been taken off. */
const COMMENT = /^\/\//;

/**
 * The comments a push adds that a reader would take as prose: an explanation of the code,
 * or documentation of the thing it declares.
 *
 * Two shapes, because the licence header has to escape and only one rule lets it. A header
 * block is a run of column-zero `//` lines at the top of every file in the codebase, so a
 * plain comment counts only when it is indented — which is what a comment written inside a
 * type, a function or a modifier chain always is. A `///` counts wherever it sits: headers
 * are never written that way, so a column-zero one is documentation on a top-level
 * declaration rather than boilerplate, and those are the ones review asked about by name.
 *
 * Block comments are deliberately out of scope. They are vanishingly rare in the codebases
 * this runs against, and recognising one properly means tracking whether a line sits inside
 * an open block — state this function does not have, since it sees only the lines a diff
 * added and never the ones around them.
 */
export function explanatoryComments(added: AddedLine[]): AddedLine[] {
  return added.filter(({ text }) => {
    const trimmed = text.trimStart();
    if (!COMMENT.test(trimmed)) return false;
    if (PRAGMA.test(trimmed)) return false;
    if (DOC_COMMENT.test(trimmed)) return true;
    return trimmed.length !== text.length;
  });
}
