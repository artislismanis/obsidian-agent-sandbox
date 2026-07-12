# CLAUDE.md: Container (infra)

This folder contains the Docker image definition and supporting scripts for the Agent Sandbox. **Anyone editing files here is working on infrastructure, not on Claude's workspace.** Be careful and test the rebuild.

## What lives here

| File | Purpose |
|------|---------|
| `Dockerfile` | Container image definition (Ubuntu 24.04, Node 24, Python 3.14, Claude Code, ttyd, firewall tools) |
| `docker-compose.yml` | Service, mounts, resource limits, OAS naming |
| `.env.example` | Environment template (copy to `.env` for standalone CLI use) |
| `.dockerignore` | Excludes from the build context |
| `firewall-baseline.txt` | Project-curated firewall allowlist (baked into the image and bind-mounted read-only at `/etc/oas/firewall-baseline.txt`, so baseline updates apply without a rebuild) |
| `firewall-extras.txt` | Host-managed firewall allowlist extras (mounted read-only at `/etc/oas/firewall-extras.txt`; invisible to the agent) |
| `configs/` | Files copied into the image: `tmux.conf`, `session-helpers.sh` |
| `scripts/entrypoint.sh` | Container entrypoint: sets sudo password, drops to `claude`, runs ttyd |
| `scripts/session.sh` | Per-ttyd-connection session launcher |
| `scripts/init-firewall.sh` | Allowlist-based outbound firewall (run as root) |
| `scripts/verify.sh` | Environment verification / runtime manifest (also baked into image at `/usr/local/bin/verify.sh`) |

## Build

```bash
cd container
docker compose build
```

This produces `oas-sandbox:latest`. Start via the Obsidian plugin (preferred) or `docker compose up -d` after copying `.env.example` to `.env`.

## Not visible inside the running container

This folder is not mounted into the container. For the rationale and exceptions, see [`docs/explanation/architecture.md`](../docs/explanation/architecture.md).

## Adding a system tool

1. Add the package to the main `apt-get install` block in `Dockerfile` (keep the list alphabetized).
2. If the tool needs network access at runtime, add the relevant domains to `firewall-baseline.txt`.
3. Rebuild: `cd container && docker compose build`
4. Restart the container (via plugin or `docker compose down && up -d`).
5. Update `scripts/verify.sh` so the new tool is reported alongside the others (the script has a hardcoded list, so adding to the Dockerfile alone won't surface it).
6. Verify: `docker compose exec sandbox verify.sh`. The tool should appear in its category.
7. Commit on a feature branch and open a PR. Never push infra changes directly to `main`.

## Firewall allowlist

The effective allowlist is the union of three additive sources: `firewall-baseline.txt` (project-curated, changes via PR), `firewall-extras.txt` (host-managed), and the `OAS_ALLOWED_DOMAINS` env var (plugin-supplied). See [`docs/how-to/configure-firewall.md`](../docs/how-to/configure-firewall.md) for how to add entries and which source to use. The safety constraint that lives here: **never weaken the allowlist without clear justification** (this is duplicated in "Safety constraints" below for visibility).

Allowed categories: Anthropic (api.anthropic.com, sentry.io, downloads.claude.ai - the last is load-bearing for `claude update`), npm (incl. registry.yarnpkg.com), GitHub, PyPI, CDNs (jsdelivr, cdnjs, unpkg), Ubuntu apt mirrors (incl. keyserver.ubuntu.com). See `firewall-baseline.txt` for the authoritative list.

## Changing a default value

Several defaults repeat across files because compose's `${VAR:-default}` idiom cannot be centralised. Change every site together:

- ttyd port `7681`: `docker-compose.yml` (ports + `OAS_TTYD_PORT`), `Dockerfile` (healthcheck), `scripts/entrypoint.sh` (ttyd launch), `scripts/verify.sh`
- MCP port `28080`: `docker-compose.yml` (`OAS_MCP_PORT`), plugin settings default, `workspace/.claude/scripts/obsidian-mcp-proxy.js`, `scripts/init-firewall.sh`
- Write dir `agent-workspace`: `docker-compose.yml` (mount + `OAS_VAULT_WRITE_DIR`), `scripts/entrypoint.sh`, `scripts/verify.sh`
- Memory file `memory.json`: `docker-compose.yml` (`OAS_MEMORY_FILE_NAME` + `MEMORY_FILE_PATH`), `scripts/entrypoint.sh`, `.env.example`

## Sudo model

See [`docs/explanation/security-model.md`](../docs/explanation/security-model.md) for the full trust model. Short version: `claude` has `apt-get`/`apt` only, password-gated via `OAS_SUDO_PASSWORD`, which `entrypoint.sh` unsets before dropping privileges.

## Pinned binary downloads

The Dockerfile downloads several binaries directly via `curl` (ttyd,
bash-preexec, atuin, the native Claude Code binary, the nvm install
script). Each has a matching `*_SHA256*` build ARG that is verified
with `sha256sum -c` after the download. **When bumping any of
`TTYD_VERSION`, `BASH_PREEXEC_VERSION`, `ATUIN_VERSION`,
`CLAUDE_CODE_VERSION`, or `NVM_VERSION`, you MUST recompute the
matching SHA** or the build will hard-fail on the verification step:

```
curl -fsSL <url> | sha256sum
```

For arch-split downloads (ttyd, atuin) compute both `_AMD64` and
`_ARM64` SHAs by substituting `x86_64` / `aarch64` in the URL. For
Claude Code, fetch them straight from the upstream manifest:

```
curl -fsSL "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/manifest.json" \
  | jq -r '.platforms | {amd64: ."linux-x64".checksum, arm64: ."linux-arm64".checksum}'
```

The base images (`ubuntu:24.04`, `ghcr.io/astral-sh/uv:0.11`) are pinned by
tag + digest at the top of the Dockerfile. Both use a **literal** tag (no
`ARG` interpolation): Dependabot's docker ecosystem cannot resolve an
ARG-interpolated `FROM` tag, so an ARG-pinned image drifts un-updated (uv
silently lagged 0.7 → 0.11 this way). With literal tags, Dependabot refreshes
the digest within the pinned tag automatically. Bumping the tag itself (e.g.
uv `0.11` → `0.12`, or the Ubuntu LTS line) is a deliberate manual change —
see the ignore rules in `.github/dependabot.yml`. To refresh a digest manually:

```bash
# ubuntu:24.04 digest
curl -sI \
  -H "Authorization: Bearer $(curl -sL 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull' | jq -r .token)" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  'https://registry-1.docker.io/v2/library/ubuntu/manifests/24.04' | grep -i digest

# ghcr.io/astral-sh/uv:<tag> digest
curl -sI \
  -H "Authorization: Bearer $(curl -sL 'https://ghcr.io/token?scope=repository:astral-sh/uv:pull&service=ghcr.io' | jq -r .token)" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  'https://ghcr.io/v2/astral-sh/uv/manifests/0.11' | grep -i docker-content-digest
```

## Safety constraints for this folder

- Never weaken the firewall allowlist without clear justification
- Never grant the claude user broader sudo than `apt-get`/`apt`
- Never set `NOPASSWD` on the sudoers entry; the password gate is the human-intent signal
- Never mount `container/` inside the running container; that would break the isolation this layout is designed to enforce
- Rebuild and run `verify.sh` after any Dockerfile change before committing
