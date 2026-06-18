# Node.js Security Remediation — Notepad

## Learnings

1. **`網站指令.md` is gitignored** (`.gitignore:37`) — changes to it are local-only, won't be committed. The version guard was still added for local deployment safety.

2. **npm doesn't reliably read HTTPS_PROXY** without `npm_config_` prefix — this was discovered during the earlier update system work (commit c246e66).

3. **Lockfile string matching can produce false positives** — `form-data@4.0.5` strings appeared in lockfile metadata (integrity hashes, old entries in `packages` section). Must verify via `npm ls --all` or programmatic package-lock resolution check, not just string search.

4. **npm audit requires running from the correct directory** — running from repo root fails with ENOLOCK.

5. **engine-strict + bounded range** (`>=24 <25`) is the correct approach — a broad `>=22` would accidentally allow Node 26 Current-only.

## Decisions
- Node 24 LTS chosen as production target (Active LTS until 2028-04-30)
- Separate CI workflow (`nodejs-ci.yml`) created instead of modifying `release.yml` to avoid breaking release automation
- Evidence files stored in `.sisyphus/evidence/` per project convention, not committed

## Verification Evidence
- All 22 QA scenarios PASS
- 0 npm vulnerabilities
- 236/236 tests pass
- Build succeeds
- 4 commits pushed: 2cae433 → 9d881f6 → 4ed50b1 → f1b5977
