# Auto-Updater & Release Pipeline

How Ompcot updates reach installed clients, how releases are cut, and the runbook for when the updater manifest breaks.

## Updater configuration

- Tauri v2 updater plugin; endpoint: `https://github.com/zh2209645/ompcot/releases/latest/download/latest.json`
- Artifacts are minisign-signed; the signing key lives in the `TAURI_SIGNING_PRIVATE_KEY` (+ password) CI secrets — see the one-time setup in the repo's release workflow
- Platform keys in `latest.json`: `darwin-aarch64`(+`-app`), `darwin-x86_64`(+`-app`), `linux-x86_64`(`-deb`/`-rpm`), `linux-aarch64`(`-deb`/`-rpm`), `windows-x86_64`(`-nsis`/`-msi`), `windows-aarch64`(`-nsis`/`-msi`) — 16 entries total

## Release procedure

Tag-push triggers have never fired in this repo — releases are **manually dispatched**:

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, then `cd src-tauri && cargo update -p ompcot` (refreshes `Cargo.lock`'s own-package entry; 4-file diff, 4 insertions/deletions)
2. Commit `chore(release): vX.Y.Z`, tag `vX.Y.Z`, push `main` + tag
3. `gh workflow run Release --ref vX.Y.Z`
4. Watch: `gh run watch <run-id> --exit-status` (~10 min; 6 build jobs + `publish-updater-manifest`)
5. Verify the endpoint (see checklist below)

## Pipeline design (current)

The manifest job is race-free by construction:

1. Each of the 6 matrix build jobs uploads a uniquely-named fragment `latest.<platform>.json` (tauri-action's own racy publisher is disabled via `includeUpdaterJson: false`)
2. `publish-updater-manifest` (needs the matrix, `if: always()`) is the **single writer**: per attempt it re-fetches the live manifest + ALL fragments fresh, merges, publishes once with `gh release upload --clobber` (no standalone DELETE), verifies convergence (every fragment's key+signature+url present), then cleans up fragments
3. **Never-dark guarantees**: zero fragments → publish nothing and fail loudly (the endpoint keeps serving the previous release's manifest); partial matrix failure → publish available platforms with PARTIAL/MISSING warnings, THEN mark the run red. The endpoint is never left without a latest.json while any build succeeded
4. The job has no checkout step — `GH_REPO` must be exported for every `gh release ...` call; manifest/fragment reads use the GitHub API asset endpoint (`Accept: application/octet-stream`), never the CDN download URL

## Incident history (why the design is what it is)

- **v0.7.2** — tauri-action's default publisher ran on all 6 jobs (download→merge→DELETE→upload); the windows-2022 job's DELETE hit a 404 (asset replaced by a peer mid-flight), its platform entries never landed, every Windows x64 client's update check failed
- **v0.7.3** — the replacement fragment step died on macOS runners: `mapfile` is bash-4+, macOS ships bash 3.2 (exit 127); plus the on-disk `Ompcot.app.tar.gz` vs uploaded `Ompcot_aarch64.app.tar.gz` rename mismatch. The strict `needs:` also meant the manifest job skipped → Latest with no latest.json → endpoint 404 for everyone
- **v0.7.4** — all builds green, but the manifest job had no checkout and no `GH_REPO`, so every `gh release` call died "not a git repository" (silently for the notes fetch, mislabeled for the upload); the upload never ran and the job reported a misleading "did not converge"
- **v0.8.2** — windows-11-arm's fragment step hit GitHub asset-listing propagation lag (assets were all present); the **partial-publish design worked as intended**: 13-platform manifest kept the endpoint healthy, the run went red with precise annotations, clients on missing platforms kept their version
- CDN reality: `releases/latest/download/latest.json` caches for minutes after asset changes — verify with cache-busters and expect lag

## Manual manifest repair runbook

When latest.json is missing/broken on the Latest release (symptom: clients' update checks fail or 404):

1. Confirm assets: `gh api repos/zh2209645/ompcot/releases/tags/vX.Y.Z --jq '[.assets[].name]'` — updater pairs are `<artifact>` + `<artifact>.sig`
2. Build the manifest locally: download all `.sig` files (`gh release download vX.Y.Z -R zh2209645/ompcot -p "*.sig" -D <tmp>`); each platform entry = `{signature: <base64 of the .sig file text>, url: https://github.com/zh2209645/ompcot/releases/download/vX.Y.Z/<artifact>}`. Role of each key follows the 16-entry table above (nsis = `*-setup.exe`, msi = `*.msi`; macOS = `Ompcot_aarch64|x64.app.tar.gz`)
3. Upload **with the file named exactly `latest.json` on disk** (the `#rename` upload syntax only sets a label and creates a stray asset): `cp fixed.json latest.json && gh release upload vX.Y.Z -R zh2209645/ompcot latest.json --clobber`
4. Delete leftover `latest.<platform>.json` fragments: fetch each asset id via the API and `gh api -X DELETE repos/.../releases/assets/<id>`
5. Verify with a cache-buster against BOTH the direct asset URL and `releases/latest/download/latest.json`; expect a few minutes of CDN lag on the latter

**Prefix-matching pitfall**: any check like `startswith("latest.")` also matches `latest.json` itself — always exclude it (`select(startswith("latest.") and . != "latest.json")`). An early cleanup command deleted the manifest this way and had to be re-uploaded.

## macOS artifacts

See `docs/release-macos.md` for bundle-signing policy (ad-hoc identity, Gatekeeper "unverified developer" path is intentional). CI produces the shipped dmg/app.tar.gz; the local `bun run release:mac:dmg` script remains for manual policy verification.
