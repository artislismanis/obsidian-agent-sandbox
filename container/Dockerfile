# Base images pinned by tag + digest. Both use a literal (non-ARG) tag so
# Dependabot's docker ecosystem can parse and refresh them; an
# ARG-interpolated FROM tag is a dependabot-core blind spot (why uv silently
# drifted 0.7 -> 0.11 while ubuntu got regular digest PRs).
# Manual refresh: see container/CLAUDE.md "Pinned binary downloads".
FROM ghcr.io/astral-sh/uv:0.11@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 AS uv
FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

# ── Version ARGs ─────────────────────────────────────────────
ARG CLAUDE_CODE_VERSION=2.1.207
ARG PYTHON_VERSION=3.14
ARG NODE_MAJOR=24
ARG TTYD_VERSION=1.7.7
ARG NVM_VERSION=0.40.5
# SHA256 of https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh
# Recompute when bumping NVM_VERSION; see container/CLAUDE.md "Pinned binary downloads".
ARG NVM_INSTALL_SHA256=582070e4c44452c1d8d68e16fc786c2216ecba6bc6bf18dc280a03fdba6ed1a9
ARG ATUIN_VERSION=18.17.0
ARG BASH_PREEXEC_VERSION=0.6.0
ARG MEMORY_SERVER_VERSION=2026.7.4

# ── Binary download SHA256 pins ───────────────────────────────
# Bump a *_VERSION ARG? Recompute its SHA; see container/CLAUDE.md "Pinned binary downloads".
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
ARG BASH_PREEXEC_SHA256=998f4d5e9dd82e254463228cc6caa4d40125ae79b31d5a16a2a2f49357f0c160
ARG ATUIN_SHA256_AMD64=7f9f8b5b71abfaa5cf6be051e2f82e1d4bab529e56f59e16126a684e450c2abb
ARG ATUIN_SHA256_ARM64=e8074dbb2df1b14a7f7456a5a2c4ffe7887c020243f230e37fe56bbaeef00e63
# SHA256s come from https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/manifest.json
# (platforms.linux-x64.checksum / platforms.linux-arm64.checksum).
ARG CLAUDE_CODE_SHA256_AMD64=85e7e988a392d859f90802ca21fb26e89d3c9ab527f5ed0b08df3955e34d5c83
ARG CLAUDE_CODE_SHA256_ARM64=8bc14a284065383460f37981d724b8f7aa7ca93c9849d2fe367e08f03383f454

# ── User ARGs ────────────────────────────────────────────────
# The claude user's uid/gid. Defaults to 1000 because that's the
# uid of the first human user on most Linux / WSL2 hosts, and the
# workspace dir is bind-mounted from the host, and matching uids is
# the only way claude can write to it without chowning the host.
# Override in container/.env if `id -u` on your host returns
# something else; docker-compose.yml passes these through as build
# args. Must be set before the useradd RUN that consumes them.
ARG CLAUDE_UID=1000
ARG CLAUDE_GID=1000

# ══════════════════════════════════════════════════════════════
# Phase 1: ROOT. System packages, binaries, permissions.
# ══════════════════════════════════════════════════════════════

ARG DEBIAN_FRONTEND=noninteractive

# System packages: includes Claude Code deps (ripgrep, git, curl),
# firewall tools (iptables, ipset, iproute2, dnsutils, aggregate),
# sudo + gosu for the narrow apt-get sudoers entry and priv-drop in entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git jq ca-certificates locales \
    ripgrep fd-find nano less tmux \
    iptables ipset iproute2 dnsutils aggregate sudo gosu \
    && ln -sf /usr/bin/fdfind /usr/bin/fd \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# UTF-8 locale: required for terminal Unicode width calculations
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ttyd (web terminal). The atuin binary install lives in Phase 3 so
# bumping ATUIN_VERSION doesn't invalidate the expensive Node/Python/
# Claude Code layers.
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then \
         NATIVE_ARCH="aarch64"; EXPECTED_SHA="${TTYD_SHA256_ARM64}"; \
       else \
         NATIVE_ARCH="x86_64"; EXPECTED_SHA="${TTYD_SHA256_AMD64}"; \
       fi \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${NATIVE_ARCH}" \
       -o /usr/local/bin/ttyd \
    && if [ -n "$EXPECTED_SHA" ]; then \
         echo "${EXPECTED_SHA}  /usr/local/bin/ttyd" | sha256sum -c -; \
       else \
         echo "WARN: TTYD SHA256 not pinned for $NATIVE_ARCH; skipping verification" >&2; \
       fi \
    && chmod +x /usr/local/bin/ttyd

# uv (Python version & package manager)
COPY --from=uv /uv /uvx /usr/local/bin/

# Create non-root user. Ubuntu 24.04's base image ships with a
# pre-created `ubuntu` user at uid 1000, which would force any new
# useradd to the next free uid (typically 1001). That breaks writes
# to the /workspace bind mount when the host user is uid 1000 (the
# normal case) because bind mounts preserve uids exactly: files
# owned by host 1000 can only be written by container uid 1000.
# Fix: delete the base `ubuntu` user first, then create claude with
# an explicit, overridable uid/gid.
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupadd -g "${CLAUDE_GID}" claude \
    && useradd --no-log-init -m -s /bin/bash -u "${CLAUDE_UID}" -g "${CLAUDE_GID}" claude \
    && mkdir -p /workspace /home/claude/.claude /home/claude/.shell-history \
    && chown -R claude:claude /workspace /home/claude/.claude /home/claude/.shell-history \
    && ln -sf /home/claude/.claude/.claude.json /home/claude/.claude.json

# Narrow sudoers entry: claude may run apt/apt-get only, password-gated.
# The password itself is set at container start time by entrypoint.sh from
# the OAS_SUDO_PASSWORD env var (see container/.env.example and README).
RUN echo 'claude ALL=(ALL) PASSWD: /usr/bin/apt-get, /usr/bin/apt' \
      > /etc/sudoers.d/claude-apt \
    && chmod 440 /etc/sudoers.d/claude-apt \
    && visudo -c -f /etc/sudoers.d/claude-apt

# ══════════════════════════════════════════════════════════════
# Phase 2: claude user. nvm, Node, Python, Claude Code.
# ══════════════════════════════════════════════════════════════
USER claude
ENV NVM_DIR=/home/claude/.nvm
ENV EDITOR=nano
ENV VISUAL=nano

# nvm + Node: symlink versioned dir to a stable path for non-interactive shells.
# The install script is downloaded, hash-verified, then executed. Piping curl
# straight into bash would mean any upstream compromise of the script gets
# arbitrary code-exec as the build user during `docker build`.
RUN curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" \
       -o /tmp/nvm-install.sh \
    && echo "${NVM_INSTALL_SHA256}  /tmp/nvm-install.sh" | sha256sum -c - \
    && bash /tmp/nvm-install.sh \
    && rm /tmp/nvm-install.sh \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install "${NODE_MAJOR}" \
    && nvm alias default "${NODE_MAJOR}" \
    && ln -s "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/default" \
    && nvm cache clear
# ~/.local/bin holds the Claude Code native binary (symlink into
# ~/.local/share/claude/versions/<ver>; installed in Phase 3). Listed
# first so `claude update`'s atomic symlink swap is picked up by new
# shells without a rebuild.
ENV PATH=/home/claude/.local/bin:/home/claude/.nvm/default/bin:/home/claude/.local/python-default/bin:$PATH

# Python via uv (userspace-managed). A stable dir symlink at
# ~/.local/python-default gives a version-agnostic entry for PATH.
# Symlinking the whole install root (not just the binary) is load-bearing:
# `python3 -m venv` writes the invocation bin dir into pyvenv.cfg as `home`,
# and `../lib/python3.14/` must resolve to real stdlib from there. A
# `/usr/local/bin/python3` symlink breaks venv because pyvenv.cfg ends up
# with `home = /usr/local/bin` and no stdlib lives there, so Python then
# falls back to python-build-standalone's baked `/install` prefix and
# bails at `No module named 'encodings'`.
RUN uv python install "${PYTHON_VERSION}" && uv cache clean \
    && ln -sfn "$(dirname "$(dirname "$(uv python find)")")" /home/claude/.local/python-default \
    && ln -sf python3 /home/claude/.local/python-default/bin/python

# MCP servers. Claude Code itself is installed as a native binary in
# Phase 3 (see CLAUDE_CODE_VERSION). Clean the npm cache so download
# artifacts don't end up baked into the image layer.
RUN npm install -g --no-audit --no-fund \
       "@modelcontextprotocol/server-memory@${MEMORY_SERVER_VERSION}" \
    && npm cache clean --force

# atuin shell history: the binary itself is installed in Phase 3. This
# step adds pinned bash-preexec.sh (required for atuin's bash hooks to
# register) and writes a local-only config.toml (no sync, no update
# check). Keeping these in Phase 2 means they share the claude user's
# layer cache with the Node/Python installs above.
RUN curl -fsSL "https://raw.githubusercontent.com/rcaloras/bash-preexec/${BASH_PREEXEC_VERSION}/bash-preexec.sh" \
       -o /home/claude/.bash-preexec.sh \
    && if [ -n "${BASH_PREEXEC_SHA256}" ]; then \
         echo "${BASH_PREEXEC_SHA256}  /home/claude/.bash-preexec.sh" | sha256sum -c -; \
       else \
         echo "WARN: BASH_PREEXEC_SHA256 not pinned; skipping verification" >&2; \
       fi \
    && mkdir -p /home/claude/.config/atuin /home/claude/.config/git /home/claude/.config/npm /home/claude/.shell-history/atuin \
    && printf '%s\n' \
       '## Local-only, no sync server' \
       'sync_address = ""' \
       'auto_sync = false' \
       'update_check = false' \
       'search_mode = "fuzzy"' \
       'style = "compact"' \
       'inline_height = 20' \
       'filter_mode = "global"' \
       'filter_mode_shell_up_arrow = "global"' \
       '' \
       '## Inline recording (no daemon in container)' \
       'daemon_enabled = false' \
       > /home/claude/.config/atuin/config.toml

# .bashrc wiring. Ordering is load-bearing: bash-preexec must be sourced
# before atuin init, so that atuin's hooks register into the
# preexec_functions / precmd_functions arrays bash-preexec defines.
RUN printf '%s\n' \
       '' \
       '# Redirect tools that hardcode $HOME/.xxx into the oas-user-config' \
       '# named volume (mounted at ~/.config) so their auth state survives' \
       '# container restarts. XDG-native tools (gh, atuin, pip, uv) already' \
       '# write under ~/.config and need no redirect.' \
       'export GIT_CONFIG_GLOBAL=/home/claude/.config/git/config' \
       'export NPM_CONFIG_USERCONFIG=/home/claude/.config/npm/npmrc' \
       '' \
       '# atuin shell history (DB stored on the volume-backed history dir)' \
       'export ATUIN_CONFIG_DIR=/home/claude/.config/atuin' \
       'export ATUIN_DB_PATH=/home/claude/.shell-history/atuin/history.db' \
       '[ -f /home/claude/.bash-preexec.sh ] && source /home/claude/.bash-preexec.sh' \
       'command -v atuin >/dev/null && eval "$(atuin init bash)"' \
       '' \
       '# Persistent shell sessions via tmux (see ~/.session-helpers.sh)' \
       '[ -f /home/claude/.session-helpers.sh ] && source /home/claude/.session-helpers.sh' \
       >> /home/claude/.bashrc

# ══════════════════════════════════════════════════════════════
# Phase 3: back to root. Volatile binaries and scripts.
#   Everything here invalidates cheaply: atuin bumps, script edits,
#   and the final CMD metadata. Placed last so that changes to any
#   of these do NOT rebuild the expensive Phase 1 apt/Phase 2 Node
#   and Python layers. Entrypoint runs as root to set the claude
#   password from OAS_SUDO_PASSWORD, then drops to claude via gosu.
# ══════════════════════════════════════════════════════════════
USER root

# atuin binary: pinned tarball. Placed here (not in Phase 1) so
# bumping ATUIN_VERSION only invalidates this small layer.
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then \
         NATIVE_ARCH="aarch64"; EXPECTED_SHA="${ATUIN_SHA256_ARM64}"; \
       else \
         NATIVE_ARCH="x86_64"; EXPECTED_SHA="${ATUIN_SHA256_AMD64}"; \
       fi \
    && curl -fsSL "https://github.com/atuinsh/atuin/releases/download/v${ATUIN_VERSION}/atuin-${NATIVE_ARCH}-unknown-linux-gnu.tar.gz" \
       -o /tmp/atuin.tar.gz \
    && if [ -n "$EXPECTED_SHA" ]; then \
         echo "${EXPECTED_SHA}  /tmp/atuin.tar.gz" | sha256sum -c -; \
       else \
         echo "WARN: ATUIN SHA256 not pinned for $NATIVE_ARCH, skipping verification" >&2; \
       fi \
    && tar -xzf /tmp/atuin.tar.gz -C /tmp \
    && install -m 755 /tmp/atuin-*/atuin /usr/local/bin/atuin \
    && rm -rf /tmp/atuin*

# Claude Code: native (self-contained) binary, pinned. We bypass the
# upstream install.sh because it resolves the latest version at runtime;
# we want a build-time-pinned version (matches ttyd/atuin). The binary is
# self-contained, with no Node runtime dependency at runtime.
#
# Installed at the canonical native-install layout (~/.local/share/claude/
# versions/<ver> as the binary, ~/.local/bin/claude as a symlink) and
# owned by claude so that:
#   1. Claude Code's installMethod=native self-check finds the binary
#      where it expects; installing to /usr/local/bin trips a half-done
#      self-migration on first run that leaves a dangling symlink.
#   2. `claude update` at runtime is an atomic symlink swap into the
#      same user-writable tree (downloads.claude.ai is allowlisted in
#      firewall-baseline.txt).
USER claude
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then \
         NATIVE_PLATFORM="linux-arm64"; EXPECTED_SHA="${CLAUDE_CODE_SHA256_ARM64}"; \
       else \
         NATIVE_PLATFORM="linux-x64"; EXPECTED_SHA="${CLAUDE_CODE_SHA256_AMD64}"; \
       fi \
    && VERSIONED=/home/claude/.local/share/claude/versions/${CLAUDE_CODE_VERSION} \
    && mkdir -p /home/claude/.local/bin /home/claude/.local/share/claude/versions \
    && curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
       "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/${NATIVE_PLATFORM}/claude" \
       -o "${VERSIONED}" \
    && if [ -n "$EXPECTED_SHA" ]; then \
         echo "${EXPECTED_SHA}  ${VERSIONED}" | sha256sum -c -; \
       else \
         echo "WARN: CLAUDE_CODE SHA256 not pinned for $NATIVE_PLATFORM, skipping verification" >&2; \
       fi \
    && chmod 755 "${VERSIONED}" \
    && ln -sf "${VERSIONED}" /home/claude/.local/bin/claude
USER root

# Firewall script (run as root via docker compose exec --user root)
COPY --chmod=755 scripts/init-firewall.sh /usr/local/bin/init-firewall.sh

# Baseline firewall allowlist: baked as fallback when the host mount is absent.
# The compose mount (./firewall-baseline.txt:/etc/oas/firewall-baseline.txt:ro)
# shadows this at runtime; this copy ensures standalone `docker run` still works.
COPY --chmod=644 firewall-baseline.txt /etc/oas/firewall-baseline.txt
RUN chmod 755 /etc/oas

# Environment verification script (on PATH inside the image, independent of mounts)
COPY --chmod=755 scripts/verify.sh /usr/local/bin/verify.sh

# Terminal entrypoint and session script
COPY --chown=claude:claude --chmod=755 scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=claude:claude --chmod=755 scripts/session.sh /usr/local/bin/session.sh

# tmux config + session helpers (opt-in persistent shells)
COPY --chown=claude:claude --chmod=644 configs/tmux.conf /home/claude/.tmux.conf
COPY --chown=claude:claude --chmod=644 configs/session-helpers.sh /home/claude/.session-helpers.sh

WORKDIR /workspace
EXPOSE 7681

# Healthcheck baked into the image so `docker run` (without compose) reports
# accurate liveness. docker-compose.yml's healthcheck overrides this for the
# managed-by-plugin case, where OAS_TTYD_PORT may differ from the default.
# Requires curl, which Phase 1 already installs. Shell-form CMD (no array
# brackets) is implicitly run via /bin/sh -c, so ${OAS_TTYD_PORT:-7681}
# expands at runtime. CMD-SHELL is a docker-compose healthcheck.test
# keyword, not a Dockerfile keyword; using it here makes Docker treat
# "CMD-SHELL" as the binary name and the healthcheck fails permanently.
#
# Flags MUST match docker-compose.yml's healthcheck and verify.sh's runtime
# probe so all three layers report the same liveness signal:
#   -f  fail on non-2xx (after redirect)
#   -s  silent (no progress bar)
#   -S  show errors even with -s, for postmortem readability
#   -L  follow redirects (tolerates a future ttyd 301/302)
#
# DL3025 wants JSON notation, which would stop ${OAS_TTYD_PORT:-7681} from
# expanding. hadolint 2.15.0 (action v3.4.0) started flagging HEALTHCHECK CMD.
# hadolint ignore=DL3025
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsSL -o /dev/null "http://localhost:${OAS_TTYD_PORT:-7681}/" || exit 1

CMD ["/usr/local/bin/entrypoint.sh"]
