# British English

Default to British spelling for all prose. Code identifiers, library
names, and API terms keep their original spelling.

## Spelling swaps

### `-ize` → `-ise`

| American | British |
| --- | --- |
| organize | organise |
| realize | realise |
| utilize | utilise |
| analyze | analyse |
| recognize | recognise |
| optimize | optimise |
| customize | customise |
| categorize | categorise |
| prioritize | prioritise |
| summarize | summarise |
| emphasize | emphasise |
| apologize | apologise |

### `-or` → `-our`

| American | British |
| --- | --- |
| behavior | behaviour |
| color | colour |
| favorite | favourite |
| flavor | flavour |
| honor | honour |
| labor | labour |
| neighbor | neighbour |
| rumor | rumour |

### `-er` → `-re`

| American | British |
| --- | --- |
| center | centre |
| fiber | fibre |
| liter | litre |
| meter (unit) | metre |
| theater | theatre |

### Doubled consonants

| American | British |
| --- | --- |
| traveling | travelling |
| traveled | travelled |
| labeled | labelled |
| canceled | cancelled |
| modeling | modelling |
| signaled | signalled |

### Other common swaps

| American | British |
| --- | --- |
| defense | defence |
| offense | offence |
| license (noun) | licence |
| license (verb) | license |
| practice (verb) | practise |
| practice (noun) | practice |
| gray | grey |
| catalog | catalogue |
| dialog (general) | dialogue |
| program (general) | programme |
| check (financial) | cheque |
| tire (wheel) | tyre |
| jail | gaol (or jail) |
| math | maths |

## Where to keep American

| Context | Example |
| --- | --- |
| Code identifiers | `color: red;` in CSS, `Analyzer` class in an SDK |
| API names | `BehaviorSubject` (RxJS), `Initializer` |
| Library and framework names | `Tailwind`, `behavior-tree-js` |
| File names matching a convention | `Initialization.md` if siblings use US spelling |
| Quoted text from external sources | Leave quoted material unchanged |
| HTML elements | `<dialog>`, `<color>` (web platform) |

## Idioms

- "different to" or "different from" (both fine), not "different than"
- "in hospital" not "in the hospital"
- "at the weekend" not "on the weekend"
- "Mr", "Dr", "Mrs" without full stops
- "amongst" and "whilst" are fine but "among" and "while" read more naturally
- Dates: "31 May 2026" or "31st May 2026", not "May 31, 2026"
- Times: 24-hour clock for technical writing ("14:00"), 12-hour for casual ("2pm")
- Quotation marks: single quotes for direct speech and titles, double for
  quotes within quotes. Logical punctuation: full stop outside the quote
  unless it is part of the quoted material.

## When to add to this list

Add a swap when:

- Claude Code produces the American version in this project, AND
- The British version is the standard form (check Oxford English
  Dictionary if unsure).

Keep tables grouped by suffix pattern. Most common offenders near the top
of each section.
