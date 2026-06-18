/**
 * 網路工具模組 — 為 updater.ts 提供代理、重試、鏡像和診斷能力
 *
 * 解決容器部署中 GitHub 不可達的問題：
 *   1. 代理支援（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 環境變數）
 *   2. 指數退避重試
 *   3. GitHub 鏡像（GITHUB_MIRROR 前綴代理模式）
 *   4. 連通性診斷
 */

import { ProxyAgent, type Dispatcher } from "undici";

// ========================
// 代理管理
// ========================

let cachedDispatcher: Dispatcher | null = null;
let cachedProxyUrl: string | null = null;

/**
 * 取得當前應使用的代理 dispatcher（懶加載 + 快取）。
 * 讀取順序：HTTPS_PROXY → HTTP_PROXY → ALL_PROXY
 * 如果都沒設定，返回 null（直連）。
 */
function getProxyDispatcher(): Dispatcher | null {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "";

  // URL 沒變 → 沿用快取
  if (proxyUrl === cachedProxyUrl) return cachedDispatcher;

  cachedProxyUrl = proxyUrl;

  if (!proxyUrl) {
    cachedDispatcher = null;
    return null;
  }

  try {
    cachedDispatcher = new ProxyAgent(proxyUrl);
    console.log(`[net] ✓ 使用代理：${proxyUrl}`);
  } catch (err) {
    console.warn(`[net] 代理初始化失敗，回退直連：${(err as Error).message}`);
    cachedDispatcher = null;
  }
  return cachedDispatcher;
}

// ========================
// GitHub 鏡像
// ========================

/**
 * 如果設定了 GITHUB_MIRROR，對 GitHub URL 加上前綴。
 *
 * 例如 GITHUB_MIRROR=https://ghproxy.com：
 *   https://api.github.com/repos/... → https://ghproxy.com/https://api.github.com/repos/...
 */
export function applyMirror(url: string): string {
  const mirror = process.env.GITHUB_MIRROR;
  if (!mirror) return url;
  return `${mirror}/${url}`;
}

// ========================
// 帶重試的 fetch
// ========================

interface RetryFetchOptions {
  /** 請求超時（毫秒），預設 30 秒 */
  timeoutMs?: number;
  /** 重試次數（不含首次），預設 2 */
  retries?: number;
  /** 請求標頭 */
  headers?: Record<string, string>;
  /** 是否跟隨重定向，預設 true */
  redirect?: RequestRedirect;
}

/**
 * 指數退避重試 + 代理 + 超時的 fetch 包裝。
 *
 * @throws Error 所有重試耗盡後拋出最後一次錯誤
 */
export async function fetchWithRetry(
  url: string,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    retries = 2,
    headers = {},
    redirect = "follow",
  } = options;

  const dispatcher = getProxyDispatcher();
  const totalAttempts = retries + 1;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      // undici 的 dispatcher 選項不在標準 RequestInit 類型中，需擴展
      const fetchOpts: Record<string, unknown> = {
        headers,
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (dispatcher) fetchOpts.dispatcher = dispatcher;

      const resp = await fetch(url, fetchOpts as RequestInit);

      // 5xx 重試，4xx 不重試（客戶端錯誤）
      if (resp.status >= 500 && attempt < totalAttempts) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.warn(
          `[net] HTTP ${resp.status}（第 ${attempt}/${totalAttempts} 次），${delay}ms 後重試`,
        );
        await sleep(delay);
        continue;
      }

      return resp;
    } catch (err) {
      lastError = err as Error;
      if (attempt < totalAttempts) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        const msg = (err as Error).name === "TimeoutError"
          ? `超時 (${timeoutMs}ms)`
          : (err as Error).message;
        console.warn(
          `[net] 請求失敗（第 ${attempt}/${totalAttempts} 次），${delay}ms 後重試：${msg}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("fetchWithRetry: 不明錯誤");
}

// ========================
// 連通性診斷
// ========================

export interface ConnectivityReport {
  /** GitHub API（api.github.com）是否可達 */
  githubApi: { ok: boolean; latencyMs: number; error?: string };
  /** GitHub tarball 下載（codeload.github.com）是否可達 */
  githubDownload: { ok: boolean; latencyMs: number; error?: string };
  /** git fetch origin 是否可用 */
  gitFetch: { ok: boolean; error?: string };
  /** 建議訊息列表 */
  suggestions: string[];
}

/**
 * 診斷更新系統的網路連通性。
 * 測試 GitHub API、tarball 下載、git fetch 三個環節。
 */
export async function diagnoseConnectivity(
  githubApiUrl: string,
  tarballUrl: string,
): Promise<ConnectivityReport> {
  const report: ConnectivityReport = {
    githubApi: { ok: false, latencyMs: 0 },
    githubDownload: { ok: false, latencyMs: 0 },
    gitFetch: { ok: false },
    suggestions: [],
  };

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    "";
  const mirror = process.env.GITHUB_MIRROR || "";

  // Test 1: GitHub API
  try {
    const t0 = Date.now();
    const apiUrl = applyMirror(githubApiUrl);
    const resp = await fetchWithRetry(apiUrl, {
      timeoutMs: 15_000,
      retries: 0,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "s12ryt-connectivity-check",
      },
    });
    report.githubApi = {
      ok: resp.ok,
      latencyMs: Date.now() - t0,
      ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }),
    };
  } catch (err) {
    report.githubApi = {
      ok: false,
      latencyMs: 0,
      error: (err as Error).message,
    };
  }

  // Test 2: GitHub tarball download (HEAD 請求，不下載完整檔案)
  try {
    const t0 = Date.now();
    const dlUrl = applyMirror(tarballUrl);
    const dispatcher = getProxyDispatcher();
    const fetchOpts: Record<string, unknown> = {
      method: "HEAD",
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const resp = await fetch(dlUrl, fetchOpts as RequestInit);
    report.githubDownload = {
      ok: resp.ok,
      latencyMs: Date.now() - t0,
      ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }),
    };
  } catch (err) {
    report.githubDownload = {
      ok: false,
      latencyMs: 0,
      error: (err as Error).message,
    };
  }

  // Test 3: git fetch
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["fetch", "origin", "main", "--dry-run"], {
      timeout: 15_000,
      stdio: "pipe",
      cwd: process.cwd(),
    });
    report.gitFetch = { ok: true };
  } catch (err) {
    report.gitFetch = {
      ok: false,
      error: (err as Error).message.split("\n")[0],
    };
  }

  // 生成建議
  const apiFailed = !report.githubApi.ok;
  const dlFailed = !report.githubDownload.ok;
  const gitFailed = !report.gitFetch.ok;

  if (apiFailed && dlFailed && gitFailed) {
    // 全部失敗 → 網路問題
    if (!proxyUrl && !mirror) {
      report.suggestions.push(
        "🔴 無法連接 GitHub。請設定環境變數：",
        "   export HTTPS_PROXY=http://your-proxy:port",
        "   # 或使用 GitHub 鏡像：",
        "   export GITHUB_MIRROR=https://ghproxy.com",
      );
    }
  } else if (dlFailed && !apiFailed) {
    // API 可達但下載不可達 → codeload 被封
    if (!mirror) {
      report.suggestions.push(
        "🟡 GitHub API 可達，但 tarball 下載失敗。",
        "   建議設定鏡像：export GITHUB_MIRROR=https://ghproxy.com",
      );
    }
  } else if (gitFailed) {
    // git fetch 失敗
    if (!proxyUrl) {
      report.suggestions.push(
        "🟡 git fetch 失敗，可能是 git 未設定代理。",
        "   建議：git config --global http.proxy http://your-proxy:port",
      );
    }
  }

  if (report.githubApi.ok && report.githubDownload.ok && report.gitFetch.ok) {
    report.suggestions.push("🟢 所有連線正常。");
  }

  return report;
}

// ========================
// 工具函數
// ========================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
