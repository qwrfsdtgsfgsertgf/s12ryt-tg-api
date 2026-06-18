# F3: Real Command-Based QA Replay Results

**Date**: 2026-06-18
**All scenarios executed via Bash/PowerShell commands**

## T1: Version Files
| Scenario | Result | Evidence |
|----------|--------|----------|
| Version files exist and match | PASS | .nvmrc=24, .node-version=24 |
| No EOL versions (18/20/25/26) | PASS | Neither file contains EOL major |

## T2: Package Engines
| Scenario | Result | Evidence |
|----------|--------|----------|
| engines.node exists and bounded | PASS | `>=24 <25` |
| .npmrc engine-strict enabled | PASS | `engine-strict=true` |

## T3: Lockfile Remediation
| Scenario | Result | Evidence |
|----------|--------|----------|
| form-data@4.0.5 absent | PASS | Not in resolved packages |
| esbuild@0.28.0 absent | PASS | Not in resolved packages |
| npm audit --audit-level=moderate | PASS | `found 0 vulnerabilities`, exit 0 |

## T4: CI Workflow
| Scenario | Result | Evidence |
|----------|--------|----------|
| Contains setup-node | PASS | |
| Contains node-version-file | PASS | Uses `.nvmrc` |
| Contains npm ci --engine-strict | PASS | |
| Contains npm audit --audit-level=moderate | PASS | |
| Contains npm run build | PASS | |
| Contains npm test | PASS | |
| release.yml unchanged | PASS | File still exists, not modified |

## T5: README Runtime Docs
| Scenario | Result | Evidence |
|----------|--------|----------|
| 'Node.js 18+' absent | PASS | |
| 'Node.js 24 LTS' present | PASS | |
| Scope focused (1 line changed) | PASS | |

## T6: Hosting Instructions
| Scenario | Result | Evidence |
|----------|--------|----------|
| Version precondition present | PASS | "Node.js 24 LTS or newer is required" |
| No secrets | PASS | No token/key/password patterns found |

## T7: Full Verification + Regression
| Scenario | Result | Evidence |
|----------|--------|----------|
| node --version = 24.x | PASS | v24.11.1 |
| npm ci --engine-strict | PASS | Exit 0 |
| npm run build | PASS | Exit 0 |
| npm test | PASS | 236/236 passed |
| npm audit 0 vulnerabilities | PASS | Exit 0 |
| No broad >=18 engine | PASS | |
| No active form-data@4.0.5 | PASS | Confirmed via package-lock resolution check |
| No active esbuild@0.28.0 | PASS | Confirmed via package-lock resolution check |

## Summary
- **Scenarios**: 22/22 PASS
- **Evidence**: 22/22 present
- **VERDICT**: APPROVE
