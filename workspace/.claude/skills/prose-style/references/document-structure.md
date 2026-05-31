# Document structure

For anything over a paragraph, the shape of the document matters as much
as the words.

## Headlines, not topic headers

Headers should read like newspaper headlines: state the key fact, not
the topic.

| Topic-style | Headline-style |
| --- | --- |
| ## Caching | ## The avatar cache expires after 24 hours |
| ## Performance | ## P99 latency dropped from 800ms to 200ms |
| ## Background | ## Logged-in users saw stale avatars |
| ## Next steps | ## Ship the fix to staging by Friday |
| ## Architecture | ## Three services share one Postgres replica |
| ## Risks | ## Rollback takes 15 minutes; data loss is impossible |

A reader scanning the headers alone should learn the document's main
facts. If they cannot, the headers are doing decoration, not work.

This rule targets narrative section headers. Short utility labels on
structured blocks stay as plain labels: Test, Files, Reproduction,
Acceptance, Steps, Why it matters. These are not topic headers; they
are field names.

For short documents with one or two sections, a plain label or no
header scans faster than a forced fact-headline. Use fact-headlines
where the document has several sections worth scanning.

## Lead with the answer

For anything over ~300 words, put the key facts at the top. The reader
should not need to read the whole document to learn the punchline.

### TL;DR pattern

Start with a TL;DR or Summary block of one paragraph or three bullets:

> **TL;DR:** The auth service crashes when `userId` is null. The fix
> ships Friday. No customer impact expected because the bug triggers
> only on a logged-out path that nobody reaches in production.

Then the body expands.

### Inverted pyramid

Order content by importance, not chronology or logic.

1. The key fact (what happened, what we are doing, what to decide)
2. Why it matters (impact, urgency, who is affected)
3. Supporting detail (how, when, edge cases, alternatives considered)
4. Background and history (if any, last)

Background should rarely lead. If the reader needs context to understand
the headline, the document has too much background.

## Tables over prose for data

Use a table when comparing more than two items on more than two
dimensions. Prose comparisons become unreadable above 2x2.

Use prose for narrative ("first we tried X, which failed because Y"). Use
tables for reference ("here are the five options with their trade-offs").

## Cut the announcing intro

These intros add no information. Delete them.

- "This document describes..."
- "In this section, we will cover..."
- "The purpose of this PR is..."
- "This RFC proposes..."

The title already states what the document is. Start with content.

## Section length

If a section runs longer than three paragraphs, check whether it should be:

- A bulleted list (most often)
- Split into two sections with separate headlines
- Shortened by cutting throat-clearing or repeated points

## The conclusion test

Conclusions that restate the document add nothing. Cut them.

A conclusion is justified only if it:

- Lists concrete next actions with owners
- Names a decision the reader must make
- Captures lessons that change future behaviour

If the conclusion would start with "In conclusion" or "To summarise", it
fails the test.

## Visual hierarchy

Use formatting to guide scanning:

- **Bold** for the one or two phrases the reader must not miss per section
- *Italics* sparingly, for technical terms on first use
- `Code` for identifiers, file paths, commands
- Block quotes for verbatim text (errors, log lines, external quotes)

Avoid bold for emphasis. If a sentence needs bold to land, rewrite it.

## Length targets

Rough guidance, not hard rules:

| Document type | Target length |
| --- | --- |
| PR description | Under 200 words |
| JIRA ticket | Under 300 words |
| README section | Under 400 words |
| Design doc | Under 1,500 words; longer needs a TL;DR |
| RFC | Under 2,500 words; longer needs an executive summary |

When you exceed the target, ask what to cut, not how to justify the length.

## When to add to this list

Add a pattern when:

- You spot a structural issue in this project's documents, AND
- There is a repeatable fix, AND
- The fix is not specific to a single document type.

Document-type-specific structure (PR templates, design-doc templates,
ADR formats) belongs in a separate project skill that references this one.
