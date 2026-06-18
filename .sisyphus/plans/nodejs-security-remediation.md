# Node.js å®‰å…¨?§ä¿®å¾©è???
## TL;DR

> **Quick Summary**: å°?Node.js ?ˆæœ¬ç­–ç•¥å¾žæœªå¼·åˆ¶?æ?ä»¶ä?æ¨™ç¤º `Node.js 18+`ï¼Œä¿®æ­?‚º?¯åŸ·è¡Œã€å¯é©—è???Active LTS ?¿ç?ï¼›å??‚æ??¤ç›®??`npm audit` ?¼ç¾??`form-data` HIGH ??`esbuild` LOW é¢¨éšªï¼Œä¸¦? ä? CI/?‡ä»¶?²å?æ­¸ã€?>
> **Deliverables**:
> - Node.js runtime ?Žç¢º?–å???Node 24 LTSï¼ˆé?è¨­ï?ï¼Œè‹¥æ­???°å?ä¸æ”¯?´å?ä¸€?´é???Node 22 LTS??> - ?°å??ˆæœ¬?ç¤º/å¼·åˆ¶æª”æ?ï¼šroot `.nvmrc`?root `.node-version`?`nodejs/package.json` engines?`nodejs/.npmrc` engine-strict??> - ?´æ–° `nodejs/package-lock.json`ï¼Œä¿®è£?`form-data@4.0.5` ??`esbuild@0.28.0` advisories??> - ?°å? Node.js CIï¼š`npm ci`?`npm audit`?`npm run build`?`npm test`??> - ?´æ–° README ?‡éƒ¨ç½²æ?ä»¤ï?ç§»é™¤ Node 18+ ?„é??Ÿå??¨æ?ç¤ºã€?>
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 2 implementation waves + final verification wave
> **Critical Path**: T1/T2/T3/T4/T5/T6 ??T7 ??F1-F4

---

## Context

### Original Request

ä½¿ç”¨?…è?æ±‚ï??Œå¹«?‘ç?node-js?ˆæœ¬?‰ä?ä»€éº¼å??¨æ€§å?é¡Œã€ï?å¾Œç??¸æ??Œç”¢?Ÿä¿®å¾©è??«ã€ã€?
### Planning Constraint

- ä½¿ç”¨?…æ?ç¢ºè?æ±‚ï??Œä?è¦ç”¨subagent?ã€‚æœ¬è¨ˆç•«?¢ç??Žç?ä¸ä½¿??subagent??- ?Ÿæœ¬?‰å???Metis gap analysis å·²ä?ä½¿ç”¨?…è?æ±‚æ”¹?ºæœ¬??self-gap review??- é«˜ç²¾åº?Momus review å±¬æ–¼ subagentï¼›é™¤?žä½¿?¨è€…ä?å¾Œæ?ç¢ºè§£?¤é??¶ï??¦å?ä¸åŸ·è¡Œã€?
### Interview / Inspection Summary

**Key Findings**:
- `README.md:402` ä»æ?ç¤?Node.js ?€æ±‚ç‚º `TypeScript / Node.js 18+`ï¼›Node 18 å·?EOL??- å®˜æ–¹ Node.js release scheduleï¼šæˆª??2026-06-18ï¼ŒNode 22 ??Node 24 ??LTSï¼›Node 18??0??5 ??EOLï¼›Node 26 ??Current å°šæœª??LTS??- `nodejs/package.json:1-31` æ²’æ? `engines.node`ï¼Œnpm ä¸æ??»æ­¢ EOL runtime??- repository æ²’æ? `.nvmrc`?`.node-version`?Dockerfile?docker-composeï¼Œéƒ¨ç½??‹ç™¼ runtime æ²’æ?è¢«é?å®šã€?- `.github/workflows/release.yml:1-180` ?ªæ? release automationï¼Œæ???Node setup?install?build?test?audit gate??- `ç¶²ç??‡ä»¤.md:1` ?„éƒ¨ç½²å??•å‘½ä»¤ä½¿??`/usr/local/bin/node` ??`/usr/local/bin/npm`ï¼Œä?æ²’æ??‡å? Node ?ˆæœ¬??- ?¬æ?æª¢æŸ¥ï¼š`node v24.11.1`?`npm 11.7.0`??- `npm audit --json` ?¼ç¾ 2 ?‹æ?æ´žï?
  - HIGH `form-data@4.0.5`ï¼šGHSA-hmw2-7cc7-3qxx / CVE-2026-12143ï¼Œmultipart field/filename CRLF injectionï¼›patched `4.0.6`??  - LOW `esbuild@0.28.0`ï¼šGHSA-g7r4-m6w7-qqqrï¼ŒWindows dev server arbitrary file readï¼›patched `0.28.1`??- `npm audit fix --dry-run --json` é¡¯ç¤ºä¿®è??ªé??´æ–° transitive installed packagesï¼š`form-data 4.0.5 ??4.0.6`?`esbuild 0.28.0 ??0.28.1`?`@esbuild/win32-x64 0.28.0 ??0.28.1`??
### Local Self-Gap Reviewï¼ˆMetis skipped per userï¼?
**Identified Gaps / Resolutions**:
- Gap: ä½¿ç”¨?…å??ªæ?å®?Node 22 ??Node 24?? 
  Resolution: ?è¨­ Node 24 LTSï¼Œå??ºæ”¯?´æ???2028-04-30ï¼›è‹¥æ­?? hosting ä¸æ”¯??Node 24ï¼Œæ•´é«”ä??´é???Node 22 LTS??- Gap: ?ªæ?ä¿?package-lock ä¸è¶³ä»¥é˜²æ­¢æœªä¾†å???EOL runtime?? 
  Resolution: ?Œæ?è¨ˆç•« version files?package engines?engine-strict?CI gate?æ?ä»¶æ›´?°ã€?- Gap: release workflow æ²’æ?æ¸¬è©¦/audit gateï¼Œå¯?½ç™¼å¸ƒå«æ¼æ??ˆæœ¬?? 
  Resolution: ?°å??¨ç? Node CI workflowï¼›é¿?ç›´?¥æ”¹è¤‡é? release workflowï¼Œé?ä½Žç ´å£žç™¼å¸ƒæ?ç¨‹é¢¨?ªã€?- Gap: `form-data` ??`esbuild` ?½æ˜¯ transitive/dev-path é¢¨éšªï¼Œå®¹?“è¢«?Žåº¦?‡ç??? 
  Resolution: ?…å? minimal lockfile remediationï¼Œä??šå»£æ³?major upgrade ?–æ¥­?™é?è¼¯æ”¹?•ã€?
### Local High-Accuracy Reviewï¼ˆno subagents per userï¼?
**Review Result**: PASS after tightening the plan below.

**Checks performed locally**:
- Confirmed all 7 implementation tasks include references, acceptance criteria, happy-path QA, negative/regression QA, evidence paths, and scope guardrails.
- Confirmed final verification can be executed without subagents: it is written as command/tool-based roles, not mandatory delegated agents.
- Tightened runtime enforcement so `engines.node` must use a bounded LTS range, not a broad range like `>=22` that would accidentally allow Current-only Node 26.
- Tightened CI guidance so workflow should use `.nvmrc` via `actions/setup-node` `node-version-file` or otherwise match `.nvmrc` exactly, preventing docs/config drift.
- Added explicit dependency-tree verification via `npm ls form-data esbuild --all`, because lockfile greps alone can miss how npm resolves transitive packages.

**Residual accepted default**:
- Default runtime target remains Node 24 LTS. Node 22 LTS is only an explicit fallback if deployment hosting cannot support Node 24.

---

## Work Objectives

### Core Objective

å°?Node.js ?ˆæœ¬å®‰å…¨é¢¨éšª?‡ç›®??npm advisories è½‰å??ºå¯?·è??å¯é©—è??å¯?²å?æ­¸ç?ä¿®å¾©ï¼šruntime ä¸å??è¨± EOL Nodeï¼Œdependency audit æ¸…é›¶?–è‡³å°‘æ???HIGH/MODERATE é¢¨éšªï¼ŒCI ?½é˜»æ­¢å??¨é€€?–ã€?
### Concrete Deliverables

- Root runtime version filesï¼š`.nvmrc`?`.node-version`??- Node package enforcementï¼š`nodejs/package.json` engines?`nodejs/.npmrc` engine-strict??- Dependency remediationï¼š`nodejs/package-lock.json` ä¸?`form-data` ??`esbuild` patched??- CIï¼š`.github/workflows/nodejs-ci.yml` ?–ç???Node.js CI workflow??- Documentationï¼š`README.md` ??`ç¶²ç??‡ä»¤.md` ??Node ?ˆæœ¬/?¨ç½²èªªæ??´æ–°??- Evidenceï¼šæ??‰é?è­‰è¼¸?ºä?å­˜æ–¼ `.sisyphus/evidence/nodejs-security-remediation/`??
### Definition of Done

- [x] `node --version` é¡¯ç¤ºç¬¦å?è¨ˆç•« runtimeï¼ˆé?è¨?Node 24.xï¼‰ã€?- [x] `cd nodejs && npm ci --engine-strict` ?å???- [x] `cd nodejs && npm audit --audit-level=moderate` ?å?ï¼Œä? `npm audit --json` ä¸å??—å‡º `form-data@4.0.5` ??`esbuild@0.28.0`??- [x] `cd nodejs && npm run build` ?å???- [x] `cd nodejs && npm test` ?å???- [x] README ?‡éƒ¨ç½²æ?ä»¤ä??å»ºè­?Node 18/20 ä½œç‚º?¯æŽ¥??production runtime??
### Must Have

- Node production target å¿…é???Active/Maintenance LTSï¼Œä?å¾—æ˜¯ EOL ??Current-only??- å¿…é?ä¿®è? `form-data` HIGH advisory??- å¿…é?ä¿®è??–æ?ç¢ºæ???`esbuild` LOW Windows dev-server advisory??- å¿…é??‰æ??¨å¯?·è?é©—è?ï¼Œä??½åª? äººå·¥ç›®è¦–ã€?
### Must NOT Haveï¼ˆGuardrailsï¼?
- ä¸å?å°?Node 18?Node 20?Node 25 è¨­ç‚º?¯æŽ¥??production target??- ä¸å?ä¿®æ”¹ Telegram bot æ¥­å??è¼¯?API provider selection?æ??é?è¼¯ã€è??™åº« schema??- ä¸å??šç„¡?œç?å¤§è?æ¨?dependency major upgrade??- ä¸å??°å??–è¼¸?ºä»»ä½?secret?token?API key??- ä¸å??¨ã€Œæ??•ç¢ºèªå¯ä»¥è??ä??ºå”¯ä¸€ acceptance criteria??
---

## Verification Strategy

> **ZERO HUMAN INTERVENTION FOR VERIFICATION** - ?€?‰é?è­‰éƒ½å¿…é??¯ç”± command/tool ?·è??‚äººé¡žåªè² è²¬?€å¾Œæ‰¹?†ï?ä¸è?è²¬æ›¿ä»?¸¬è©¦ã€?
### Test Decision

- **Infrastructure exists**: YES (`nodejs/package.json` has `vitest`, `npm test`, `npm run build`)
- **Automated tests**: Tests-after / regression verificationï¼ˆæœ¬å·¥ä???config/dependency/docs remediationï¼Œä??©å? TDD ?ˆå¯«å¤±æ?æ¸¬è©¦ï¼?- **Framework**: Vitest + TypeScript build + npm audit
- **Agent-Executed QA**: ALWAYSï¼›æ???TODO ?½æ? command-based QA scenarios??
### QA Policy

Evidence path: `.sisyphus/evidence/nodejs-security-remediation/task-{N}-{scenario-slug}.txt`??
- **Config / Docs**: Use Bash or PowerShell to read files and assert exact content.
- **Dependency Audit**: Use npm commands and lockfile inspection.
- **CI YAML**: Use grep/read checks plus `npm ci`, build, test, audit locally.
- **No browser QA** required; this remediation does not change UI behavior.

---

## Execution Strategy

### Parallel Execution Waves

```text
Wave 1 (Start Immediately - independent remediation tracks):
?œâ??€ T1: Add root Node version files [.nvmrc, .node-version] [quick]
?œâ??€ T2: Enforce runtime in nodejs package config [quick]
?œâ??€ T3: Refresh npm lockfile to remediate advisories [quick]
?œâ??€ T4: Add Node.js CI safety gate [unspecified-high]
?œâ??€ T5: Update README runtime/security docs [writing]
?”â??€ T6: Update hosting/startup instructions [writing]

Wave 2 (After Wave 1 - integration verification):
?”â??€ T7: Run full local security/build/test verification and collect evidence [quick]

Wave FINAL (After ALL tasks ??verification roles):
?œâ??€ F1: Plan compliance audit
?œâ??€ F2: Code quality/config hygiene review
?œâ??€ F3: Real command-based QA replay
?”â??€ F4: Scope fidelity check

Critical Path: T1-T6 ??T7 ??F1-F4 ??user okay
Max Concurrent: 6 in Wave 1
```

### Dependency Matrix

| Task | Blocked By | Blocks | Notes |
|---|---|---|---|
| T1 | None | T7 | Establishes root runtime version hints. |
| T2 | None | T7 | Enforces runtime during npm install. |
| T3 | None | T7 | Clears npm advisories. |
| T4 | None | T7 | Adds CI gate. |
| T5 | None | T7 | Documentation consistency. |
| T6 | None | T7 | Deployment consistency. |
| T7 | T1-T6 | F1-F4 | Integrated verification and evidence. |
| F1-F4 | T7 | User approval | Final verification before completion. |

### Dispatch Summaryï¼ˆfor future execution onlyï¼?
> Planning phase will not call subagents because user said ?Œä?è¦ç”¨subagent?? Categories below are only recommendations for a future executor or manual task routing.

- **Wave 1**: T1/T2/T3 ??`quick`; T4 ??`unspecified-high`; T5/T6 ??`writing`.
- **Wave 2**: T7 ??`quick`.
- **Final**: verification roles may be executed by tooling or by an executor that the user explicitly allows.

---

## TODOs

> Implementation + verification belong together. Every task below includes agent-executable QA scenarios.

- [x] 1. Add root Node version files

  **What to do**:
  - Add root `.nvmrc` and root `.node-version`.
  - Default target: Node 24 LTS. Use a concrete 24.x version consistently, preferably current official LTS at execution time.
  - If production hosting cannot support Node 24, use Node 22 LTS consistently in all files/docs instead.

  **Must NOT do**:
  - Do not set Node 18, Node 20, Node 25, or Node 26 Current-only as production target.
  - Do not modify application source code.

  **Recommended Agent Profile**:
  - **Category**: `quick` ??small config-only change.
  - **Skills**: none.
  - **Skills Evaluated but Omitted**: `git-master` ??no git operation is required inside this task.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T2-T6
  - **Blocks**: T7
  - **Blocked By**: None

  **References**:
  - `README.md:402` ??currently documents `Node.js 18+`, proving the version policy is outdated.
  - Root glob result ??no `.nvmrc` or `.node-version` currently exists, so these are new controls.
  - Official Node.js previous releases / schedule ??Node 24 LTS preferred; Node 22 LTS acceptable fallback.

  **Acceptance Criteria**:
  - [x] `.nvmrc` exists at repository root and contains the selected supported LTS version: Node 24 by default, or Node 22 only if the hosting fallback is explicitly documented.
  - [x] `.node-version` exists at repository root and matches `.nvmrc` policy exactly.
  - [x] Neither file contains `18`, `20`, `25`, or `26` as the target major version.

  **QA Scenarios**:

  ```text
  Scenario: Root runtime files exist and match
    Tool: Bash/PowerShell
    Preconditions: Repository root contains the new version files.
    Steps:
      1. Read `.nvmrc` and `.node-version`.
      2. Assert both files resolve to the same supported LTS major, default 24.
      3. Save the command output.
    Expected Result: Both files exist, are non-empty, and consistently target Node 24 LTS unless a documented Node 22 fallback is used.
    Failure Indicators: Missing file, mismatched major versions, or EOL major version.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-1-version-files.txt

  Scenario: EOL runtime is not accepted in version files
    Tool: Bash/PowerShell
    Preconditions: Version files are present.
    Steps:
      1. Search `.nvmrc` and `.node-version` for major versions 18, 20, 25, 26.
      2. Assert zero matches for those as target versions.
    Expected Result: No EOL/Current-only target is present.
    Failure Indicators: Any target major is 18, 20, 25, or 26.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-1-no-eol-version.txt
  ```

  **Commit**: YES
  - Message: `chore(node): pin active lts runtime version`
  - Files: `.nvmrc`, `.node-version`
  - Pre-commit: version-file QA scenarios above

- [x] 2. Enforce runtime in Node package config

  **What to do**:
  - Update `nodejs/package.json` with `engines.node` matching the selected LTS policy.
  - Use a bounded LTS range: default `>=24 <25`; fallback `>=22 <23` only if production hosting cannot support Node 24.
  - Add `nodejs/.npmrc` with engine-strict enabled so installs fail under unsupported Node.
  - Keep package metadata/scripts otherwise unchanged unless npm requires lockfile metadata normalization.

  **Must NOT do**:
  - Do not rename scripts or change app entrypoints.
  - Do not change dependency versions in this task; T3 handles advisories.

  **Recommended Agent Profile**:
  - **Category**: `quick` ??package metadata/config only.
  - **Skills**: none.
  - **Skills Evaluated but Omitted**: `fullstack-architect-framework` ??no architecture decision is needed.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1, T3-T6
  - **Blocks**: T7
  - **Blocked By**: None

  **References**:
  - `nodejs/package.json:1-31` ??current package has scripts/dependencies but no `engines.node`.
  - `nodejs/package-lock.json:610-622` ??some transitive packages already require `^20.19.0 || >=22.12.0`, so broad `18+` is incompatible with modern tooling.
  - `nodejs/package-lock.json:3018-3032` ??`tsx@4.22.4` requires Node `>=18.0.0`, which is not sufficient as a security policy.

  **Acceptance Criteria**:
  - [x] `nodejs/package.json` contains an `engines.node` range that excludes Node 18/20/25/26 and permits only the selected LTS major.
  - [x] Default range is `>=24 <25`; fallback range is `>=22 <23` only when the Node 22 fallback is explicitly documented.
  - [x] `nodejs/.npmrc` enables engine-strict behavior.
  - [x] `cd nodejs && npm ci --engine-strict` succeeds under the selected LTS runtime.

  **QA Scenarios**:

  ```text
  Scenario: Package engines enforce supported LTS
    Tool: Bash/PowerShell
    Preconditions: T2 changes applied.
    Steps:
      1. Read `nodejs/package.json`.
      2. Assert `engines.node` exists.
      3. Assert the range is bounded to exactly one supported LTS major: default `>=24 <25`, or fallback `>=22 <23` with documented justification.
    Expected Result: package.json has a clear supported LTS engine policy.
    Failure Indicators: Missing engines, broad `>=18`, broad `>=22`, missing upper bound, or allowing EOL/Current-only Node.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-2-engines.txt

  Scenario: npm install respects engine policy
    Tool: Bash
    Preconditions: Running on selected supported LTS runtime.
    Steps:
      1. Run `cd nodejs && npm ci --engine-strict`.
      2. Assert exit code is 0.
      3. Save npm output.
    Expected Result: Install succeeds only on supported runtime and uses package-lock deterministically.
    Failure Indicators: engine warning ignored, npm install failure, or lockfile drift outside expected files.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-2-engine-strict-install.txt
  ```

  **Commit**: YES
  - Message: `chore(node): enforce supported runtime engines`
  - Files: `nodejs/package.json`, `nodejs/.npmrc`
  - Pre-commit: `cd nodejs && npm ci --engine-strict`

- [x] 3. Refresh npm lockfile to remediate advisories

  **What to do**:
  - In `nodejs/`, run minimal npm remediation that updates transitive vulnerable packages.
  - Target patched versions: `form-data >=4.0.6`, `esbuild >=0.28.1`.
  - Prefer `npm audit fix` or equivalent minimal lockfile update; avoid unrelated package churn.

  **Must NOT do**:
  - Do not perform broad major upgrades.
  - Do not change production code or tests unless required by dependency remediation failure.

  **Recommended Agent Profile**:
  - **Category**: `quick` ??lockfile-only or near-lockfile-only remediation.
  - **Skills**: none.
  - **Skills Evaluated but Omitted**: `pua` ??no repeated failure/frustration trigger exists.

  **Parallelization**:
  - **Can Run In Parallel**: YES, but coordinate if T2 also touches npm metadata.
  - **Parallel Group**: Wave 1 with T1, T2, T4-T6
  - **Blocks**: T7
  - **Blocked By**: None

  **References**:
  - `nodejs/package-lock.json:1628-1652` ??vulnerable `esbuild@0.28.0` entry.
  - `nodejs/package-lock.json:1837-1853` ??vulnerable `form-data@4.0.5` entry.
  - `npm audit --json` finding ??HIGH `form-data` CVE-2026-12143; LOW `esbuild` GHSA-g7r4-m6w7-qqqr.
  - `npm audit fix --dry-run --json` ??expected remediation only updates `form-data`, `esbuild`, and platform esbuild package.

  **Acceptance Criteria**:
  - [x] `nodejs/package-lock.json` no longer resolves `form-data@4.0.5`.
  - [x] `nodejs/package-lock.json` no longer resolves `esbuild@0.28.0`.
  - [x] `cd nodejs && npm audit --audit-level=moderate` exits 0.
  - [x] Full `npm audit --json` output is saved and reviewed for remaining advisories.

  **QA Scenarios**:

  ```text
  Scenario: Audit advisories are remediated
    Tool: Bash
    Preconditions: Lockfile remediation applied and dependencies installed.
    Steps:
      1. Run `cd nodejs && npm audit --audit-level=moderate`.
      2. Capture exit code and output.
      3. Run `cd nodejs && npm audit --json` and save output.
    Expected Result: Moderate-or-higher audit gate passes; JSON no longer lists CVE-2026-12143 or GHSA-g7r4-m6w7-qqqr as active.
    Failure Indicators: audit exit code non-zero, HIGH/MODERATE advisory remains, or vulnerable versions remain in lockfile.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-3-npm-audit.txt

  Scenario: Vulnerable exact versions are absent from lockfile
    Tool: Bash/PowerShell
    Preconditions: `nodejs/package-lock.json` updated.
    Steps:
      1. Search lockfile for `form-data-4.0.5`, `form-data@4.0.5`, and `esbuild-0.28.0` / `esbuild@0.28.0` patterns.
      2. Assert no active resolved package entry uses those exact vulnerable versions.
      3. Confirm patched versions are present.
    Expected Result: Patched versions are present; vulnerable exact versions are absent.
    Failure Indicators: Any active package-lock entry still pins vulnerable versions.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-3-lockfile-versions.txt
  ```

  **Commit**: YES
  - Message: `fix(node): remediate npm audit advisories`
  - Files: `nodejs/package-lock.json` and `nodejs/package.json` only if npm changes metadata
  - Pre-commit: `cd nodejs && npm audit --audit-level=moderate`

- [x] 4. Add Node.js CI safety gate

  **What to do**:
  - Add a dedicated Node.js CI workflow, preferably `.github/workflows/nodejs-ci.yml`.
  - Trigger on PRs and pushes affecting `nodejs/**`, package files, workflow files, and runtime version files.
  - Use selected LTS runtime (default Node 24). Prefer `actions/setup-node` with `node-version-file: .nvmrc`; if the workflow hard-codes a version, it must exactly match `.nvmrc`.
  - Run, in `nodejs/`: `npm ci --engine-strict`, `npm audit --audit-level=moderate`, `npm run build`, `npm test`.
  - Keep permissions minimal, e.g. contents read-only.

  **Must NOT do**:
  - Do not alter release tagging/publishing logic in `.github/workflows/release.yml` unless absolutely necessary.
  - Do not add secret-dependent CI steps.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` ??CI workflow requires careful YAML and path filters.
  - **Skills**: none.
  - **Skills Evaluated but Omitted**: `playwright-cli` ??no browser workflow needed.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1-T3, T5-T6
  - **Blocks**: T7
  - **Blocked By**: None

  **References**:
  - `.github/workflows/release.yml:1-180` ??existing GitHub workflow has release automation but no install/build/test/audit gate.
  - `nodejs/package.json:6-11` ??scripts to run in CI: `build`, `test`.
  - `nodejs/package-lock.json:1-32` ??lockfileVersion 3 supports deterministic `npm ci`.

  **Acceptance Criteria**:
  - [x] CI workflow sets up selected LTS Node version via `.nvmrc` or an exact value matching `.nvmrc`.
  - [x] CI uses `working-directory: nodejs` or equivalent for all npm commands.
  - [x] CI includes install, audit, build, and test steps.
  - [x] CI has path filters or triggers that cover Node runtime/package/workflow changes.

  **QA Scenarios**:

  ```text
  Scenario: CI workflow contains required security gates
    Tool: Bash/PowerShell
    Preconditions: CI workflow file exists.
    Steps:
      1. Read `.github/workflows/nodejs-ci.yml`.
      2. Assert it contains setup-node with `node-version-file: .nvmrc` or an exact selected LTS version matching `.nvmrc`.
      3. Assert it runs `npm ci --engine-strict`, `npm audit --audit-level=moderate`, `npm run build`, and `npm test` in `nodejs`.
    Expected Result: Workflow has all required gates.
    Failure Indicators: Missing audit/build/test/install, wrong working directory, or EOL Node version.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-4-ci-content.txt

  Scenario: Existing release workflow is not accidentally broken
    Tool: Bash/PowerShell
    Preconditions: New CI workflow added.
    Steps:
      1. Read `.github/workflows/release.yml`.
      2. Assert release triggers and release creation steps remain present.
      3. Compare intended changed files; release workflow should be unchanged unless explicitly justified.
    Expected Result: Release automation remains intact while new CI gate is separate.
    Failure Indicators: Release trigger removed, release creation removed, or unrelated release logic changed.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-4-release-unchanged.txt
  ```

  **Commit**: YES
  - Message: `ci(node): add build test audit gate`
  - Files: `.github/workflows/nodejs-ci.yml`
  - Pre-commit: local install/audit/build/test commands from T7 if possible

- [x] 5. Update README runtime/security docs

  **What to do**:
  - Update `README.md` tech stack/runtime section from `Node.js 18+` to selected LTS policy.
  - State that production should use Active/Maintenance LTS only.
  - Mention Node 24 LTS default and Node 22 LTS fallback only if hosting cannot support 24.

  **Must NOT do**:
  - Do not rewrite unrelated README sections.
  - Do not add verbose security policy beyond the Node version remediation scope.

  **Recommended Agent Profile**:
  - **Category**: `writing` ??documentation-only.
  - **Skills**: none.
  - **Skills Evaluated but Omitted**: `ui-ux-pro-max` ??no UI copy/design change.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1-T4, T6
  - **Blocks**: T7
  - **Blocked By**: None

  **References**:
  - `README.md:390-406` ??tech stack table; `README.md:402` contains outdated `Node.js 18+`.
  - Official Node.js previous releases page ??production apps should use Active LTS or Maintenance LTS.

  **Acceptance Criteria**:
  - [x] README no longer states `Node.js 18+` as acceptable.
  - [x] README documents selected LTS runtime clearly.
  - [x] README does not imply EOL Node versions are safe.

  **QA Scenarios**:

  ```text
  Scenario: README documents active LTS runtime
    Tool: Bash/PowerShell
    Preconditions: README updated.
    Steps:
      1. Search `README.md` for `Node.js 18+` and `Node 18`.
      2. Assert outdated production requirement is absent.
      3. Search for selected LTS runtime text.
    Expected Result: README points users to Node 24 LTS by default or an explicitly supported LTS fallback.
    Failure Indicators: `Node.js 18+` remains or README lacks a replacement runtime requirement.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-5-readme-runtime.txt

  Scenario: README scope stays focused
    Tool: Bash/PowerShell
    Preconditions: README updated.
    Steps:
      1. Inspect diff for README.
      2. Assert changes are limited to runtime/security/deployment wording.
    Expected Result: No unrelated README rewrites.
    Failure Indicators: Large unrelated documentation churn.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-5-readme-scope.txt
  ```

  **Commit**: YES
  - Message: `docs(node): document supported lts runtime`
  - Files: `README.md`
  - Pre-commit: README QA scenarios above

- [x] 6. Update hosting/startup instructions

  **What to do**:
  - Update `ç¶²ç??‡ä»¤.md` to state the selected Node LTS requirement before running npm/node commands.
  - Preserve the existing hosting intent but avoid implying any `/usr/local/bin/node` version is acceptable.
  - If the one-line install/start command remains, add a clear precondition that `/usr/local/bin/node --version` must match supported LTS.

  **Must NOT do**:
  - Do not embed secrets or real tokens.
  - Do not change application startup semantics beyond runtime-version safety wording.

  **Recommended Agent Profile**:
  - **Category**: `writing` ??deployment documentation-only.
  - **Skills**: none.
  - **Skills Evaluated but Omitted**: `playwright-cli` ??no browser validation.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1-T5
  - **Blocks**: T7
  - **Blocked By**: None

  **References**:
  - `ç¶²ç??‡ä»¤.md:1` ??existing command uses `/usr/local/bin/npm`, `/usr/local/bin/node`, `ts-node --esm` without a Node version precondition.
  - Root version files from T1 ??deployment docs must match chosen LTS target.

  **Acceptance Criteria**:
  - [x] `ç¶²ç??‡ä»¤.md` documents the selected LTS runtime requirement.
  - [x] The startup command or surrounding text includes a version check/precondition.
  - [x] No Node 18/20 compatibility statement remains.

  **QA Scenarios**:

  ```text
  Scenario: Hosting docs include runtime precondition
    Tool: Bash/PowerShell
    Preconditions: `ç¶²ç??‡ä»¤.md` updated.
    Steps:
      1. Read `ç¶²ç??‡ä»¤.md`.
      2. Assert it mentions selected LTS runtime requirement.
      3. Assert it includes or references a node version check before install/start.
    Expected Result: A deployer can see the required Node version before running the command.
    Failure Indicators: Command still appears without runtime precondition.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-6-hosting-runtime.txt

  Scenario: Hosting docs contain no secrets
    Tool: Bash/PowerShell
    Preconditions: `ç¶²ç??‡ä»¤.md` updated.
    Steps:
      1. Search the changed text for token/key/password-like assignments.
      2. Assert no real credentials are present.
    Expected Result: Documentation contains no secrets.
    Failure Indicators: Real token/API key/password appears.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-6-no-secrets.txt
  ```

  **Commit**: YES
  - Message: `docs(deploy): require supported node runtime`
  - Files: `ç¶²ç??‡ä»¤.md`
  - Pre-commit: hosting QA scenarios above

- [x] 7. Run full local security/build/test verification and collect evidence

  **What to do**:
  - After T1-T6, run the complete verification command set.
  - Save command outputs to `.sisyphus/evidence/nodejs-security-remediation/`.
  - Summarize remaining risks, if any, in an evidence summary file.

  **Must NOT do**:
  - Do not mark work complete if audit/build/test fails.
  - Do not hide low-severity findings; if any remain, document them and whether they are accepted or still to fix.

  **Recommended Agent Profile**:
  - **Category**: `quick` ??command execution and evidence capture.
  - **Skills**: none.
  - **Skills Evaluated but Omitted**: `playwright-cli` ??no UI changed.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 sequential integration task
  - **Blocks**: F1-F4
  - **Blocked By**: T1-T6

  **References**:
  - `nodejs/package.json:6-11` ??authoritative build/test scripts.
  - `nodejs/package-lock.json:1-32` ??deterministic npm install source.
  - T1-T6 changed files ??all must be validated together.

  **Acceptance Criteria**:
  - [x] `node --version` confirms selected LTS runtime.
  - [x] `cd nodejs && npm ci --engine-strict` passes.
  - [x] `cd nodejs && npm ls form-data esbuild --all` shows patched resolved versions.
  - [x] `cd nodejs && npm audit --audit-level=moderate` passes.
  - [x] `cd nodejs && npm run build` passes.
  - [x] `cd nodejs && npm test` passes.
  - [x] Evidence files exist for every command.

  **QA Scenarios**:

  ```text
  Scenario: Full happy-path verification passes
    Tool: Bash
    Preconditions: T1-T6 complete; supported Node LTS active.
    Steps:
      1. Run `node --version`.
      2. Run `cd nodejs && npm ci --engine-strict`.
      3. Run `cd nodejs && npm ls form-data esbuild --all`.
      4. Run `cd nodejs && npm audit --audit-level=moderate`.
      5. Run `cd nodejs && npm run build`.
      6. Run `cd nodejs && npm test`.
      7. Save all outputs.
    Expected Result: All commands exit 0.
    Failure Indicators: Any non-zero exit code or audit vulnerability at moderate/high/critical.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-7-full-verification.txt

  Scenario: Vulnerable runtime/dependency regression check
    Tool: Bash/PowerShell
    Preconditions: Full verification commands completed.
    Steps:
      1. Inspect runtime files and package engines for EOL Node allowance.
      2. Inspect package-lock for `form-data@4.0.5` and `esbuild@0.28.0`.
      3. Assert none of the forbidden runtime/dependency values remain.
    Expected Result: No EOL runtime target and no vulnerable exact dependency versions remain.
    Failure Indicators: Node 18/20 allowed, form-data 4.0.5 present, or esbuild 0.28.0 present.
    Evidence: .sisyphus/evidence/nodejs-security-remediation/task-7-regression-check.txt
  ```

  **Commit**: NO (verification-only unless evidence is intentionally committed)
  - Message: N/A
  - Files: `.sisyphus/evidence/nodejs-security-remediation/*` if project convention commits evidence; otherwise leave uncommitted/local.
  - Pre-commit: N/A

---

## Final Verification Waveï¼ˆafter ALL implementation tasksï¼?
> These are verification roles for the future execution phase. They are not invoked during this planning session because the user requested no subagents.
>
> All verification must use tools/commands; no human-only checking.

- [x] F1. **Plan Compliance Audit**
  - Verify every Must Have is satisfied.
  - Search all changed files for forbidden runtime targets (`Node.js 18+`, `Node 18`, `Node 20`, broad `>=18` production policy).
  - Confirm evidence files exist for T1-T7.
  - Output: `Must Have [N/N] | Must NOT Have [N/N] | Evidence [N/N] | VERDICT: APPROVE/REJECT`.

- [x] F2. **Code Quality / Config Hygiene Review**
  - Run `cd nodejs && npm ci --engine-strict`, `npm run build`, `npm test`, and `npm audit --audit-level=moderate`.
  - Review changed config/YAML/docs for unrelated churn, secrets, and invalid syntax.
  - Output: `Install [PASS/FAIL] | Build [PASS/FAIL] | Tests [PASS/FAIL] | Audit [PASS/FAIL] | VERDICT`.

- [x] F3. **Real Command-Based QA Replay**
  - Execute every QA scenario listed under T1-T7.
  - Save final replay outputs to `.sisyphus/evidence/nodejs-security-remediation/final-qa/`.
  - Output: `Scenarios [N/N pass] | Evidence [N/N present] | VERDICT`.

- [x] F4. **Scope Fidelity Check**
  - Compare actual diff against T1-T7.
  - Reject if bot business logic, provider routing, auth/permissions, database schema, or secrets were changed.
  - Reject broad dependency upgrade churn not required for advisories.
  - Output: `Tasks [N/N compliant] | Scope creep [NONE/issues] | VERDICT`.

---

## Commit Strategy

- **Commit 1**: `chore(node): pin active lts runtime version`
  - Files: `.nvmrc`, `.node-version`, `nodejs/package.json`, `nodejs/.npmrc`
  - Verify: `cd nodejs && npm ci --engine-strict`
- **Commit 2**: `fix(node): remediate npm audit advisories`
  - Files: `nodejs/package-lock.json` and only necessary package metadata changes
  - Verify: `cd nodejs && npm audit --audit-level=moderate`
- **Commit 3**: `ci(node): add build test audit gate`
  - Files: `.github/workflows/nodejs-ci.yml`
  - Verify: inspect workflow plus local `npm ci`, audit, build, test
- **Commit 4**: `docs(node): document supported lts runtime`
  - Files: `README.md`, `ç¶²ç??‡ä»¤.md`
  - Verify: docs grep scenarios from T5/T6

---

## Success Criteria

### Verification Commands

```bash
node --version
cd nodejs && npm ci --engine-strict
cd nodejs && npm audit --audit-level=moderate
cd nodejs && npm run build
cd nodejs && npm test
```

Expected result: every command exits 0 under selected LTS runtime.

### Final Checklist

- [x] Node production target is Active/Maintenance LTS only.
- [x] `README.md` no longer says `Node.js 18+`.
- [x] Runtime version files and npm engines are consistent.
- [x] `form-data@4.0.5` is absent from active lockfile resolution.
- [x] `esbuild@0.28.0` is absent from active lockfile resolution.
- [x] CI runs install, audit, build, and tests.
- [x] Deployment docs include a Node version precondition.
- [x] No unrelated bot logic, database schema, provider routing, auth, or secret handling changed.
