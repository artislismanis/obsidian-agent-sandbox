# prose-style skill

The house style for every word written in this project.

## Files

```
prose-style/
├── SKILL.md                       # core rules, principles, decision shortcuts
├── README.md                      # this file
└── references/
    ├── banned-phrases.md          # words and phrases to cut
    ├── structures.md              # formulaic patterns to avoid
    ├── plain-language.md          # long-word → short-word swaps
    ├── british-english.md         # spelling and idiom
    ├── specificity.md             # concrete nouns, numbers, strong verbs
    ├── document-structure.md      # headlines, TL;DR, pyramid principle
    └── examples.md                # before/after pairs by context
```

`SKILL.md` loads every time the skill triggers. References load on demand.
Keep `SKILL.md` focused on principles and shortcuts. Detail belongs in
references.

## Extending

Three ways to add rules:

1. **Add to an existing reference.** Each file has a "When to add" section
   at the bottom with category guidance. Most additions go here.
2. **Create a new reference file.** Use this when a rule does not fit any
   existing category. Update `SKILL.md`'s "When to read which reference"
   table to point at the new file.
3. **Add examples to `examples.md`.** When you spot a real before/after
   pair in this project's prose, capture it. Real examples beat invented
   ones.

## Precedence

`prose-style` is the source of truth for voice and style across the project.

Other skills should reference it, not restate its rules. A project skill
extending `prose-style` can add domain rules (a section template, a
formatting convention, a domain glossary) but must not duplicate the
style rules.

When a project skill conflicts with `prose-style`:
- `prose-style` wins on style (voice, structure, banned words).
- The project skill wins on domain content (what the document contains).
