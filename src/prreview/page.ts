import { escapeHtml } from "../review/page.js";
import type { AcceptedRemark, Rejection } from "./validate.js";

/**
 * The page a person answers a pull-request review on.
 *
 * The same idea as `review`'s page and a different shape, because the question is
 * different. There, shipkit is telling you about your own unpushed change and you decide
 * what to fix. Here you are deciding what to say to somebody else, in public, under your
 * name — so the page is arranged around the diff rather than around a list of findings, and
 * every remark is drawn on the line it is about.
 *
 * Nothing is ticked when the page opens. A review that arrives pre-approved is one a person
 * scrolls past and sends, which is exactly the outcome the editor exists to prevent.
 */

export type KeptRemark = {
  /** Index into the accepted list the page was rendered from. */
  index: number;
  /** The body as the person left it — they may have rewritten it entirely. */
  body: string;
  /** Their own words, appended under the remark. Empty when they added none. */
  note: string;
};

export type PrPageInput = {
  token: string;
  repository: string;
  number: number;
  title: string;
  author: string;
  mine: boolean;
  /** The unified diff, as fetched. */
  diff: string;
  accepted: readonly AcceptedRemark[];
  /** Refusals are shown, not hidden: an agent inventing rule ids is worth seeing. */
  rejected: readonly Rejection[];
};

type Row = { kind: "hunk" | "add" | "del" | "ctx"; text: string; line?: number; side?: "LEFT" | "RIGHT" };

/** Re-walks the diff for display, with the same line arithmetic the anchors were built on. */
function rowsOf(diff: string): Map<string, Row[]> {
  const files = new Map<string, Row[]>();
  let path: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const push = (row: Row): void => {
    if (path === undefined) return;
    const rows = files.get(path) ?? [];
    rows.push(row);
    files.set(path, rows);
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      path = undefined;
      inHunk = false;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const named = raw.slice(4).trim().replace(/^[ab]\//, "");
      path = named === "/dev/null" ? path : named;
      if (path !== undefined && !files.has(path)) files.set(path, []);
      inHunk = false;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const named = raw.slice(4).trim().replace(/^[ab]\//, "");
      if (named !== "/dev/null") path = named;
      if (path !== undefined && !files.has(path)) files.set(path, []);
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      push({ kind: "add", text: raw, line: newLine, side: "RIGHT" });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      push({ kind: "del", text: raw, line: oldLine, side: "LEFT" });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      push({ kind: "ctx", text: raw, line: newLine, side: "RIGHT" });
      oldLine += 1;
      newLine += 1;
    } else {
      inHunk = false;
    }
  }

  return files;
}

function remarkCard(index: number, ruleId: string, body: string): string {
  const i = String(index);
  return `<div class="remark" data-index="${i}">
  <label class="keep"><input type="checkbox" name="keep" value="${i}"> keep</label>
  <div class="rbody">
    <div class="rule">${escapeHtml(ruleId)}</div>
    <textarea class="body" data-index="${i}" rows="2">${escapeHtml(body)}</textarea>
    <textarea class="note" data-index="${i}" rows="1" placeholder="add your own words (appended)"></textarea>
  </div>
</div>`;
}

const STYLE = `
:root { color-scheme: light dark; --fg:#1f2328; --bg:#fff; --muted:#59636e; --line:#d1d9e0;
  --card:#f6f8fa; --add:#e6ffec; --del:#ffebe9; --accent:#0969da; --warn:#9a6700; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --muted:#9198a1;
  --line:#3d444d; --card:#151b23; --add:#12261e; --del:#25171c; --accent:#4493f8; --warn:#d29922; } }
* { box-sizing:border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.wrap { max-width:1000px; margin:0 auto; }
header { border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:20px; }
h1 { font-size:18px; margin:0 0 4px; }
.sub { color:var(--muted); font-size:13px; }
.warnbox { border:1px solid var(--warn); border-left-width:4px; border-radius:6px; padding:10px 12px;
  margin:16px 0; color:var(--warn); font-size:13px; }
.file { border:1px solid var(--line); border-radius:6px; margin:0 0 16px; overflow:hidden; }
.file > .name { background:var(--card); padding:8px 12px; border-bottom:1px solid var(--line);
  font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
table.diff { width:100%; border-collapse:collapse;
  font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
table.diff td { padding:0 8px; vertical-align:top; white-space:pre-wrap; word-break:break-word; }
td.ln { width:1%; text-align:right; color:var(--muted); user-select:none; white-space:nowrap; }
tr.add td { background:var(--add); } tr.del td { background:var(--del); }
tr.hunk td { background:var(--card); color:var(--muted); }
tr.remarkrow > td { padding:0 0 0 0; }
.remark { display:flex; gap:10px; padding:10px 12px; border-top:1px solid var(--line);
  border-bottom:1px solid var(--line); background:var(--bg); }
.remark .keep { white-space:nowrap; color:var(--muted); font-size:12px; }
.rbody { flex:1; min-width:0; }
.rule { font:11px ui-monospace,Menlo,monospace; color:var(--accent); margin-bottom:4px; }
textarea { width:100%; font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px;
  padding:6px 8px; resize:vertical; }
textarea.note { margin-top:6px; }
.general { border:1px solid var(--line); border-radius:6px; padding:0; margin:0 0 16px; }
.general > .name { background:var(--card); padding:8px 12px; border-bottom:1px solid var(--line); font-size:12px; }
.refused { color:var(--muted); font-size:12px; margin:4px 0; }
footer { position:sticky; bottom:0; background:var(--bg); border-top:1px solid var(--line);
  padding:14px 0; margin-top:24px; }
button { font:inherit; padding:8px 14px; border:1px solid var(--line); border-radius:6px;
  background:var(--card); color:var(--fg); cursor:pointer; }
button.send { border-color:var(--accent); color:#fff; background:var(--accent); font-weight:600; }
button:disabled { opacity:.5; cursor:not-allowed; }
#count { color:var(--muted); margin-left:10px; font-size:13px; }
#done { display:none; padding:12px; border:1px solid var(--line); border-radius:6px; margin-top:12px; }
`;

/**
 * The send control states the consequence rather than inviting a reflex.
 *
 * This publishes the moment it is pressed, on somebody else's pull request, and a
 * notification cannot be withdrawn. A button that said "Send" would be the wrong size for
 * what it does.
 */
function sendLabel(input: PrPageInput): string {
  // Escaped: a login is somebody else's text, and this one is interpolated into the page.
  const whose = input.mine ? "your own" : `${escapeHtml(input.author)}'s`;
  return `Publish on ${whose} ${escapeHtml(input.repository)}#${input.number}`;
}

export function renderPrPage(input: PrPageInput): string {
  const rows = rowsOf(input.diff);

  // Remarks, keyed by the line they belong to, so each is drawn inside the diff rather than
  // in a list beside it. A finding you have to match to a line yourself is one you skim.
  const byLine = new Map<string, number[]>();
  const general: number[] = [];
  input.accepted.forEach((remark, index) => {
    if (remark.placement === "line") {
      const key = `${remark.path} ${remark.line} ${remark.side}`;
      byLine.set(key, [...(byLine.get(key) ?? []), index]);
    } else {
      general.push(index);
    }
  });

  const cardFor = (index: number): string => {
    const remark = input.accepted[index] as AcceptedRemark;
    return remarkCard(index, remark.ruleId, remark.body);
  };

  const files: string[] = [];
  for (const [path, fileRows] of rows) {
    // A file nothing was said about is still shown: the point of anchoring remarks to the
    // diff is that a person reads the change, not a list.
    const body = fileRows
      .map((row) => {
        const cls = row.kind === "hunk" ? "hunk" : row.kind === "add" ? "add" : row.kind === "del" ? "del" : "";
        const num = row.line === undefined ? "" : String(row.line);
        const line = `<tr class="${cls}"><td class="ln">${num}</td><td>${escapeHtml(row.text)}</td></tr>`;
        if (row.line === undefined || row.side === undefined) return line;
        const here = byLine.get(`${path} ${row.line} ${row.side}`);
        if (here === undefined) return line;
        return `${line}<tr class="remarkrow"><td colspan="2">${here.map(cardFor).join("")}</td></tr>`;
      })
      .join("");
    files.push(`<div class="file"><div class="name">${escapeHtml(path)}</div><table class="diff">${body}</table></div>`);
  }

  const generalBlock =
    general.length === 0
      ? ""
      : `<div class="general"><div class="name">About the change as a whole — not attached to any line</div>${general
          .map(cardFor)
          .join("")}</div>`;

  const refusedBlock =
    input.rejected.length === 0
      ? ""
      : `<div class="warnbox"><strong>${input.rejected.length} remark(s) were refused and are not shown above.</strong>${input.rejected
          .map((r) => `<div class="refused">${escapeHtml(r.remark.ruleId || "no rule")}: ${escapeHtml(r.reason)}</div>`)
          .join("")}</div>`;

  const script = `
const token = ${JSON.stringify(input.token)};
const send = document.getElementById('send');
const count = document.getElementById('count');
function kept() {
  return [...document.querySelectorAll('input[name=keep]:checked')].map(function (box) {
    const i = box.value;
    const scope = box.closest('.remark');
    return {
      index: Number(i),
      body: scope.querySelector('textarea.body').value,
      note: scope.querySelector('textarea.note').value
    };
  });
}
function refresh() {
  const n = kept().length;
  count.textContent = n === 0 ? 'nothing ticked' : n + ' ticked';
  send.disabled = n === 0;
}
document.addEventListener('change', function (e) { if (e.target.name === 'keep') refresh(); });
refresh();
send.addEventListener('click', async function () {
  send.disabled = true;
  const res = await fetch('/submit?token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: kept() })
  });
  const done = document.getElementById('done');
  done.style.display = 'block';
  done.textContent = res.ok ? 'Published. You can close this tab.' : 'Not published: ' + (await res.text());
  if (!res.ok) send.disabled = false;
});
document.getElementById('nothing').addEventListener('click', async function () {
  await fetch('/submit?token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [] })
  });
  const done = document.getElementById('done');
  done.style.display = 'block';
  done.textContent = 'Nothing published. You can close this tab.';
});
`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.repository)}#${input.number} — shipkit</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
<header>
  <h1>${escapeHtml(input.title)}</h1>
  <div class="sub">${escapeHtml(input.repository)}#${input.number} · by ${escapeHtml(input.author)}${input.mine ? " (yours)" : ""} · ${input.accepted.length} remark(s)</div>
</header>
${refusedBlock}
${generalBlock}
${files.join("")}
<footer>
  <button id="send" class="send" disabled>${sendLabel(input)}</button>
  <button id="nothing">Publish nothing</button>
  <span id="count"></span>
  <div class="sub" style="margin-top:8px">Publishing is immediate and public. A notification cannot be withdrawn.</div>
  <div id="done"></div>
</footer>
</div><script>${script}</script></body></html>`;
}

/** Reads what the page posted back. Returns `undefined` when the body is not a selection. */
export function parseKept(body: string, accepted: number): KeptRemark[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;

  const kept: KeptRemark[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const { index, body: text, note } = raw as Record<string, unknown>;
    // The index addresses a remark shipkit itself produced. Anything outside the list is a
    // request to publish something that was never reviewed, so it is refused rather than
    // clamped.
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= accepted) {
      return undefined;
    }
    if (typeof text !== "string" || typeof note !== "string") return undefined;
    kept.push({ index, body: text, note });
  }
  return kept;
}

/** Applies the person's edits, producing what will actually be published. */
export function applyKept(
  accepted: readonly AcceptedRemark[],
  kept: readonly KeptRemark[],
): AcceptedRemark[] {
  return kept.map((choice) => {
    const original = accepted[choice.index] as AcceptedRemark;
    const trimmed = choice.note.trim();
    // The person's own words go under the remark, separated, so it stays clear which half a
    // human wrote — that is the whole reason they were invited to add any.
    const body = trimmed.length === 0 ? choice.body : `${choice.body}\n\n${trimmed}`;
    return { ...original, body };
  });
}
