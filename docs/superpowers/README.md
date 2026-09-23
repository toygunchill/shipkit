# Specs and plans

The design history of this tool: why each part is shaped the way it is, what was measured
to decide it, and — where it happened — what an earlier draft got wrong and how.

## The names in here are pseudonyms

These documents were written against one team's repository and Jira, which is how the
measurements in them exist at all. The identities are gone; the numbers are not.

| In the documents | What it was |
|---|---|
| `Squad A` … `Squad F` | six real teams, one pseudonym each and used consistently |
| `Portfolio A` … `Portfolio D` | the values of a cascading Jira field |
| `ABC-1234` | issue keys, prefix replaced, numbers kept so cross-references still line up |
| `customfield_10101`, `customfield_10102` | two custom field ids |
| `jira.example.com`, `git.example.com`, `acme/example-app` | the Jira, the forge, the repository |

The measurements are untouched, because they are the argument: 56 of 78 merged pull
requests left the template's own text in place; 371 review comments across 248 threads;
one portfolio distribution at 22/18/11/7 and another at 36 of 59; one developer's own
issues at 68% / 28%.

Those numbers are why the thresholds are what they are, and a threshold with its evidence
removed is a number somebody once picked.

## What these are not

Not documentation of how to use shipkit — that is the [README](../../README.md). Not
current: a spec records what was decided then, including the parts a later commit changed.
Where a document is wrong about the code today, the code is right.
