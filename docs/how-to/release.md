# How to release

Maintainer-only guide for cutting a new plugin release. End-users should follow `install-via-brat.md` instead.

## Prerequisites (one-time per maintainer)

- Push access to the GitHub repo.
- Local git configured so pushes work without prompts.
- A **Personal Access Token with `workflow` scope** to push changes to `.github/workflows/*`: the default auth can lack this scope. Classic PAT or fine-grained PAT with "Workflows: Read and write" both work.
- Node 24+ and `npm ci` clean in `plugin/`.

## What a release consists of

Each tagged release on GitHub gets three attached assets:

- `main.js`: bundled plugin code (minified)
- `manifest.json`: plugin metadata with the new version
- `styles.css`: xterm.js + plugin styles

BRAT downloads these three files by the latest tag and drops them into the user's `<vault>/.obsidian/plugins/obsidian-agent-sandbox/`.

## Version scheme

Semantic-style, but pre-1.0 is treated as beta. Tag format is bare `N.N.N`, no `v` prefix (enforced by `plugin/.npmrc`).

`plugin/versions.json` maps each plugin version to the minimum Obsidian app version it requires. `manifest.json` has `minAppVersion` as the floor. Raising the floor stops updates for users on older Obsidian versions, so do it with care.

## Release procedure

All commands run from repo root unless noted.

### 1. Pre-flight

```bash
cd plugin && npm ci && npm run check && npm run build
```

All unit tests green, lint clean, format clean, type-check clean. If anything fails, fix before proceeding.

Strongly recommended before tagging:

```bash
# From plugin/
npm run test:integration   # needs Docker + oas-sandbox:latest
npm run test:e2e:headless  # needs xvfb or local display

# From repo root: mirrors lint-infra.yml and links.yml CI jobs
find container/scripts container/configs workspace/.claude \
    -type f \( -name '*.sh' -o -name '*.bash' \) | xargs shellcheck -S error
hadolint --config container/.hadolint.yaml container/Dockerfile
actionlint
git ls-files '*.md' | xargs lychee --no-progress --max-concurrency 4 \
    --exclude '^https?://api\.github\.com/' \
    --exclude '^https?://github\.com/[^/]+/[^/]+/(issues|pull|discussions|commit)/' \
    --exclude '^https?://anthropic\.com/' \
    --exclude 'https?://claude\.ai/' \
    --accept 200,206,301,302,307,308
```

See `docs/testing.md` "Lint infrastructure" for how to install `shellcheck`, `hadolint`, `actionlint`, and `lychee`.

Security boundary checks (Stage 7/8 + Stage 9 arg-coercion) now run in CI — no host script needed. They are covered by `test/e2e/specs/security.e2e.ts`, `test/integration/firewall.test.ts`, `src/__tests__/mcp-symlink.test.ts`, and `src/__tests__/mcp-tools.test.ts`; a green `check.yml` + `integration.yml` is the release gate for them.

Stress smoke (required before shipping; covers Stage 12 edge cases):

```bash
# Needs: live container, MCP enabled, jq on host PATH
bash container/test-scripts/stress-checks.sh /path/to/test-vault
```

### 2. Update the changelog (optional)

We don't ship a separate `CHANGELOG.md`. GitHub Release auto-generates notes from commit messages (`generate_release_notes: true` in `release.yml`). For curated notes, draft them in the Release UI after the workflow creates the Release.

### 3. Bump the version

```bash
cd plugin
npm version 0.2.0    # replace with your target version
```

This runs several things in order:

1. Updates `package.json` version to `0.2.0`.
2. Invokes `node version-bump.mjs` via the `"version"` script.
    - Rewrites `manifest.json` `version` → `0.2.0`.
    - Appends `"0.2.0": "<minAppVersion>"` to `versions.json`.
    - Stages both files.
3. Creates a commit containing `package.json`, `manifest.json`, `versions.json`.
4. Creates tag `0.2.0` (no `v` prefix: `.npmrc` sets `tag-version-prefix=""`).

If `npm version` fails partway, see "Recovering from a botched release" below.

### 4. Push commit + tag

```bash
git push
git push --tags
```

The tag push triggers `.github/workflows/release.yml`:

- Checks out at the tag.
- Verifies `GITHUB_REF_NAME` matches `manifest.json.version` (refuses if out of sync).
- `npm ci && npm run build`.
- Creates a GitHub Release named `0.2.0` with `dist/main.js`, `dist/manifest.json`, `dist/styles.css` attached. Marked "Stable" by default. Set `RELEASE_PRERELEASE=true` (repo variable) to mark as pre-release; see step 5.
- Auto-generates release notes from commits since the previous tag.

Watch the workflow: `gh run watch` or visit the Actions tab in the repo.

### 5. Verify the Release

Once the workflow is green:

1. **Assets present**: GitHub → Releases → `0.2.0` → confirm `main.js`, `manifest.json`, `styles.css` download.
2. **Pre-release flag**: the Release is marked "Stable" by default. The flag is driven by the `RELEASE_PRERELEASE` repo variable: ONLY the literal string `true` makes the Release a pre-release; any other value (including unset) ships as stable. To mark a release as pre-release, either tick the box in the GitHub UI for that single Release, or set `RELEASE_PRERELEASE=true` under repo Settings → Secrets and variables → Actions → Variables.
3. **BRAT install**: in a clean Obsidian profile:
    - Command palette → **BRAT: Add a beta plugin for testing**.
    - Paste the repo URL (e.g. `https://github.com/artislismanis/obsidian-agent-sandbox`).
    - BRAT downloads the three assets. Enable the plugin. Confirm it starts and the settings tab renders.

### 6. Post-release

If the release was incorrectly marked pre-release (variable set to `true`):

1. Uncheck "Pre-release" on the GitHub Release.
2. Unset (or set to `false`) the `RELEASE_PRERELEASE` repo variable so future releases default to stable.

If critical bug found immediately:

1. Fix on `main`.
2. Bump to `0.2.1` and cut a patch release.
3. Users on BRAT auto-update on next Obsidian start.

## Recovering from a botched release

### `npm version` committed but tag rejected by remote

```bash
# Check state
git log --oneline -3
git tag --list | head

# If the local commit is unpushed, delete the tag locally and try again
git tag -d 0.2.0
git reset --hard HEAD~1   # discards the commit version-bump produced
```

Fix the underlying issue, then re-run step 3.

### Tag pushed but CI failed

- If the failure is in CI only (e.g. tests flaked), re-run the workflow from the Actions tab.
- If the failure is because of a bad commit, delete the remote tag, fix, re-tag:
    ```bash
    git push --delete origin 0.2.0
    git tag -d 0.2.0
    # fix stuff, commit
    cd plugin && npm version 0.2.0
    git push && git push --tags
    ```

### Wrong files attached

Delete the Release + tag from GitHub UI, then re-cut using the recovery steps above. BRAT users will pick up the replacement on next update check.

## First release: the `0.1.0` baseline

The first published release is `0.1.0`. `manifest.json`, `package.json`, and
`versions.json` are already pinned to `0.1.0` (with `minAppVersion` / floor
`1.11.4`), so there is **no `npm version` bump for this cut** — you tag the
commit on `main` directly. Every subsequent release uses the normal `npm version`
procedure above, incrementing from `0.1.0`.

Checklist:

- [ ] `.github/workflows/check.yml` and `.github/workflows/release.yml` are on `main`.
- [ ] `plugin/manifest.json`, `plugin/package.json`, and `plugin/versions.json` all read `0.1.0` on `main`, and `versions.json["0.1.0"]` equals `manifest.minAppVersion`.
- [ ] A clean `npm ci && npm run check` passes locally.
- [ ] CI's `check.yml` has run green on `main` (confirms Node version + deps resolve on GitHub runners).
- [ ] Tag and push the baseline (from repo root, on an up-to-date `main`):
    ```bash
    git checkout main && git pull
    git tag 0.1.0
    git push origin 0.1.0
    ```
    The tag push triggers `release.yml`, which verifies the version pins, builds, attests provenance, and creates the GitHub Release with `main.js` / `manifest.json` / `styles.css` / `SHA256SUMS` attached.
- [ ] Verify the Release (assets present, marked "Stable"), then do a clean-profile BRAT install to confirm the assets land correctly.
