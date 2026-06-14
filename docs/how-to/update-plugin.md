# How to update the plugin

*Maintainer cutting a new version? See [release.md](release.md) instead.*

## If you installed via BRAT

BRAT auto-checks on Obsidian start. To force: command palette → **BRAT: Check for updates to beta plugins**.

Updates replace the plugin files in `<vault>/.obsidian/plugins/agent-sandbox/`. Restart Obsidian (or toggle the plugin off/on) to load the new version.

## If you installed manually (built from source)

```bash
cd ~/code/obsidian-agent-sandbox
git pull
cd plugin
npm install    # in case dependencies changed
npm run build
```

Copy the contents of `plugin/dist/` into `<vault>/.obsidian/plugins/agent-sandbox/` (replacing the previous files). Restart Obsidian.

## Rebuilding the container

Container image updates are separate from plugin updates. After pulling:

```bash
cd container
docker compose build
```

Restart the container via the plugin (**Sandbox: Restart Container**).

Check you got the new image: **Sandbox: Container Status** or `cd container && docker compose exec sandbox verify.sh`, then look at the version line in the header.

## When to rebuild vs update

| Changed | Plugin update | Container rebuild |
|---|---|---|
| `plugin/src/**` | ✔ | n/a |
| `workspace/**` | n/a (mounted rw) | n/a |
| `container/Dockerfile` | n/a | ✔ |
| `container/scripts/**` | n/a | ✔ (entrypoint/session/verify are baked into the image) |
| `container/firewall-extras.txt` | n/a | No rebuild. Restart the container or rerun `/usr/local/bin/init-firewall.sh` inside the container (file is mounted ro and re-read on every apply). |
| `container/docker-compose.yml` | n/a | No rebuild, run `docker compose up -d`. |

## Rolling back

- Plugin: BRAT → **Switch a beta plugin to a different version** (for tagged releases), or `git checkout <tag> && npm run build` for manual installs.
- Container: each commit ships the Dockerfile that built it. `git checkout <old-commit>` in `container/`, `docker compose build`, and the old image is back.

## Settings compatibility

Plugin settings are additive: new releases add new keys with defaults but never remove or rename keys. Rolling back leaves unknown keys in `data.json`, which are ignored. Rolling forward picks up the new defaults.

If a release introduces a breaking settings change, the release notes call it out.
