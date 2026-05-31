# Specificity

Vague prose reads as filler. Specific prose reads as competence.

Most of the "punch" people associate with good writing comes from this
file. Cuts here are higher-impact than any banned phrase.

## Concrete nouns over abstractions

| Vague | Specific |
| --- | --- |
| stakeholders | the auth team, the CFO, three customers |
| users | logged-in customers, anonymous visitors |
| resources | three engineers, £20k of compute |
| the system | the avatar resolver, the Postgres replica |
| things | (name them) |
| issues | the null-pointer crash, the 500 on profile load |
| considerations | the 30-day data-retention rule |
| data | the last 30 days of access logs |
| performance | P99 latency, CPU utilisation, error rate |
| infrastructure | the production Kubernetes cluster |

If you cannot replace the abstract noun with a specific one, you have not
pinned down the topic.

## Specific numbers over vague quantities

| Vague | Specific |
| --- | --- |
| many users | 1,200 users |
| significantly faster | 5x faster (3.2s → 0.6s) |
| reduces load | cuts CPU from 80% to 35% |
| saves time | saves each engineer 3 hours a week |
| recently | last Tuesday, in March |
| soon | by Friday, next sprint |
| often | three times a week |
| a lot of | dozens, hundreds, thousands |
| most | 8 of 10 |
| a small number | three, five |

Round where the precision is fake. "About 1,200 users" beats "1,247 users"
if the count fluctuates. "Roughly 5x" beats "4.83x" outside a benchmark
report.

## Strong verbs

Pick the verb that does the work. Avoid weak generic verbs ("be", "have",
"do", "get", "make") when a specific one fits.

| Weak | Strong |
| --- | --- |
| makes things faster | accelerates, doubles throughput, halves latency |
| has a problem | crashes, leaks memory, misroutes |
| is responsible for | owns, handles, processes |
| does the routing | routes |
| gets the data | fetches, queries, reads |
| reduces errors | eliminates, prevents, blocks |
| improves performance | speeds up, scales, slashes latency |
| works with | integrates, talks to, syncs with |
| deals with | handles, resolves, routes |
| takes care of | owns, runs, ships |

## Named actors

Name the person, team, or system. Generic actors ("the team", "users",
"the system") hide the real subject.

- Vague: "Stakeholders need to be informed."
- Specific: "Notify the on-call engineer and the support lead."

- Vague: "The system handles errors."
- Specific: "The retry middleware catches 5xx and retries up to three times."

- Vague: "We need to address the issue."
- Specific: "The platform team needs to patch the auth service by Friday."

## One idea per sentence

If a sentence has two clauses joined by "and" or "but", check whether they
are one idea or two. If two, split.

- Bad: "The cache stores tokens for 24 hours, and we use Redis with a
  cluster of three nodes for high availability."
- Good: "The cache stores tokens for 24 hours. Redis runs as a three-node
  cluster for high availability."

- Bad: "We rolled back the deploy because it broke logins, but the team
  is investigating root cause and we expect a fix by Wednesday."
- Good: "We rolled back the deploy after it broke logins. The team
  expects a root-cause fix by Wednesday."

## The "so what" test

After each sentence or paragraph, ask: would the reader stop and say
"so what?" If yes, either add the consequence or cut the sentence.

- Weak: "We migrated to OAuth."
- Stronger: "We migrated to OAuth. Third-party apps can now sign users in
  without a password."

- Weak: "The database has 12 tables."
- Stronger: "The database has 12 tables. The `events` table holds 90% of
  the rows and dominates query cost."

If the consequence is "no consequence", the sentence is filler. Cut it.

## When to add to this list

Add a swap when:

- You spot the vague version in this project's prose, AND
- The specific version sharpens the meaning, AND
- The specifics are repeatable across documents (not one-off).

Group by category. Draw examples from this project where possible.
