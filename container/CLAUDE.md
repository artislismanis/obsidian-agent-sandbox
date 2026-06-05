# CLAUDE.md: Container (infra)

This folder contains the Docker image definition and supporting scripts for the Agent Sandbox. **Anyone editing files here is working on infrastructure, not on Claude's workspace.** Be careful and test the rebuild.

## What lives here

| File | Purpose |
|------|---------|
| `Dockerfile` | Container image definition (Ubuntu 24.04, Node 24, Python 3.12, Claude Code, ttyd, firewall tools) |
| `docker-compose.yml` | Service, mounts, resource limits, OAS naming |
| `.env.example` | Environment template (copy to `.env` for standalone CLI use) |
| `.dockerignore` | Excludes from the build context |
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
2. If the tool needs network access at runtime, add the relevant domains to the allowlist in `scripts/init-firewall.sh`.
3. Rebuild: `cd container && docker compose build`
4. Restart the container (via plugin or `docker compose down && up -d`).
5. Update `scripts/verify.sh` so the new tool is reported alongside the others (the script has a hardcoded list, so adding to the Dockerfile alone won't surface it).
6. Verify: `docker compose exec sandbox verify.sh`. The tool should appear in its category.
7. Commit on a feature branch and open a PR. Never push infra changes directly to `main`.

## Firewall allowlist

See [`docs/how-to/configure-firewall.md`](../docs/how-to/configure-firewall.md) for how to add entries. The safety constraint that lives here: **never weaken the allowlist without clear justification** (this is duplicated in "Safety constraints" below for visibility).

Allowed categories: Anthropic (api.anthropic.com, sentry.io), npm, GitHub, PyPI, CDNs (jsdelivr, cdnjs, unpkg), Ubuntu apt mirrors.

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

The base images (`ubuntu:24.04`, `ghcr.io/astral-sh/uv`) are pinned by digest at
the top of the Dockerfile; Dependabot's docker ecosystem refreshes them
on tag bumps. To refresh manually:

```bash
# ubuntu:24.04 digest
curl -sI \
  -H "Authorization: Bearer $(curl -sL 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull' | jq -r .token)" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  'https://registry-1.docker.io/v2/library/ubuntu/manifests/24.04' | grep -i digest
```

## Safety constraints for this folder

- Never weaken the firewall allowlist without clear justification
- Never grant the claude user broader sudo than `apt-get`/`apt`
- Never set `NOPASSWD` on the sudoers entry; the password gate is the human-intent signal
- Never mount `container/` inside the running container; that would break the isolation this layout is designed to enforce
- Rebuild and run `verify.sh` after any Dockerfile change before committing
