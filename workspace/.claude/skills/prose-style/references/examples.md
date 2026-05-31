# Examples

Before/after pairs. Find the closest context for the type of prose you
are writing.

## Documentation

### Bad
> Here's the thing: we've recently been navigating a really challenging
> landscape around our auth implementation. The reality is that the system,
> which was previously utilising session cookies, now leverages OAuth tokens
> (which was a game-changer). The implications are significant for
> downstream services.

### Good
> **The auth system issues OAuth tokens.**
>
> **Why it matters:** downstream services must accept tokens, not session
> cookies.
>
> - All endpoints validate `Authorization: Bearer <token>`.
> - Access tokens expire after 24 hours.
> - Refresh tokens last 30 days.

---

## PR description

### Bad
> This PR fixes the bug. We were previously not handling the null case
> correctly, which was causing failures. Now we handle it. Plot twist:
> the same pattern exists in three other files but that's another PR.

### Good
> **Handles `null` user IDs in the avatar resolver.**
>
> **Why it matters:** logged-out users triggered a 500 on every profile
> page load. About 200 reports a week in Sentry.
>
> - Returns the placeholder avatar when `userId` is null.
> - Test added in `avatar.test.ts`.
> - Same fix needed in three other resolvers; tracked in PROJ-1234.

---

## JIRA ticket

### Bad
> Title: Look into the avatar thing
>
> Users have been complaining about avatars not updating. Let's
> investigate and see what's going on. Could be a caching issue but
> hard to say.

### Good
> Title: Logged-in users see stale avatar after profile update
>
> **What:** Avatar images do not refresh until the user clears their
> browser cache.
>
> **Why it matters:** 5-10 support tickets a week. P2 customer impact.
>
> Reproduction:
> - Log in as any user.
> - Upload a new avatar via Settings.
> - Reload the profile page. Old avatar persists.
>
> Acceptance:
> - New avatar visible within one page reload.
> - No regression in CDN cache hit rate.

---

## Code comment

### Bad
```js
// Regression for the 2026-05-23 capability sweep (S9.3): wrong-type args
// must surface a schema-validation error, not the generic "File not found".
// Without this guard, callers can't tell whether they sent a typed-wrong
// argument or genuinely asked for a missing file.
it("rejects wrong-type path with Invalid arguments", ...)
```

### Good (no comment; the name says it)
```js
it("rejects wrong-type path with Invalid arguments", ...)
```

### Good (one line, adds information)
```js
// Type errors must stay distinguishable from "file not found".
it("rejects wrong-type path with Invalid arguments", ...)
```

---

## Inline comment

### Bad (commit-message style)
```js
// Now retries 3 times instead of 1 to handle flaky upstream.
await retry(call, { attempts: 3 });
```

### Good (shape, not change)
```js
// Upstream is flaky under load; three attempts covers observed jitter.
await retry(call, { attempts: 3 });
```

---

## Commit message

### Bad
> Updated stuff
>
> Made some changes to the auth code because we had some issues with
> tokens not being validated correctly in certain edge cases.

### Good
> Validate OAuth tokens on every request
>
> The previous middleware skipped validation for cached routes.
> Cached responses now require a fresh token check.
>
> Fixes PROJ-1234.

---

## Slack message

### Bad
> Hey team, just wanted to circle back on the avatar thing we were
> discussing earlier. I think we should probably look into the caching
> layer at some point, but maybe that's a bigger conversation for the
> sprint planning?

### Good
> Avatar bug: caching layer needs review. Worth a 15-minute look this
> sprint? @alice can you take it?

---

## Design doc section

### Bad
> ## Background
>
> Over the past few months, we have been observing a number of issues
> related to how we handle authentication. As the system has grown, the
> complexity of the auth layer has increased significantly, and we are
> now at a point where we need to take a step back and consider whether
> our current approach is still the right one. There are many factors
> at play, and the implications of any change would be significant.

### Good
> ## The auth layer fails open under load above 2,000 RPS
>
> **Why it matters:** the marketing campaign on 15 June projects 5,000
> RPS. The current system would let unauthenticated requests through.
>
> Three options below. Each lists cost, risk, and timeline.

---

## When to add an example

Add a context here when:

- You have an actual before/after pair from this project, AND
- It illustrates a rule that the SKILL.md or a reference covers, AND
- The transformation teaches something the existing examples do not.

Real examples beat invented ones. Invented examples are fine when no
real one exists yet.
