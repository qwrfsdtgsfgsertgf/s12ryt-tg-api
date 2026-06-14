/**
 * 程式內置更新模組
 *
 * 功能：
 *   - 查詢當前 / 遠端最新版本 (git commit hash)
 *   - 執行 git pull 更新程式碼
 *   - 自動重啟進程
 */

import { spawn, execSync, type SpawnOptions } from "node:child_process";
import { utimesSync } from "node:fs";
import { closeDb } from "./db/database.js";

// ========================
// 型別定義
// ========================

export interface VersionInfo {
  /** 短 commit hash，例如 "abc1234" */
  hash: string;
  /** ISO 8601 提交時間，例如 "2024-01-15T10:30:00+08:00" */
  date: string;
  /** 提交訊息第一行 */
  message: string;
}

export interface UpdateCheckResult {
  /** 是否有更新 */
  hasUpdate: boolean;
  /** 當前版本 */
  current: VersionInfo;
  /** 最新版本 */
  latest: VersionInfo;
  /** 落後的 commit 數量 */
  commitsBehind: number;
  /** 落後的 commit 列表（每行一條） */
  newCommits: string[];
}

export interface UpdateResult {
  success: boolean;
  message: string;
  /** 更新後的 commit hash */
  newHash?: string;
}

// ========================
// Git 輔助函數
// ========================

function execGit(args: string[]): string {
  try {
    const result = execSync(`git ${args.join(" ")}`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() ?? "";
    const stdout = err.stdout?.toString()?.trim() ?? "";
    throw new Error(stderr || stdout || err.message || "git command failed");
  }
}

function parseVersionInfo(ref: string): VersionInfo {
  const hash = execGit(["rev-parse", "--short", ref]);
  const date = execGit(["log", "-1", "--format=%cI", ref]);
  const message = execGit(["log", "-1", "--format=%s", ref]);
  return { hash, date, message };
}

// ========================
// 公開 API
// ========================

/**
 * 取得當前版本資訊
 */
export function getCurrentVersion(): VersionInfo {
  return parseVersionInfo("HEAD");
}

/**
 * Fetch 遠端並取得最新版本資訊
 * 呼叫後 origin/main 會更新到最新
 */
export function fetchAndCheckUpdate(): UpdateCheckResult {
  // Step 1: Fetch latest from remote
  execGit(["fetch", "origin", "main"]);

  const current = parseVersionInfo("HEAD");
  const latest = parseVersionInfo("origin/main");

  // Step 2: Compare hashes
  const currentFull = execGit(["rev-parse", "HEAD"]);
  const latestFull = execGit(["rev-parse", "origin/main"]);
  const hasUpdate = currentFull !== latestFull;

  // Step 3: Get commits behind (if any)
  let newCommits: string[] = [];
  let commitsBehind = 0;

  if (hasUpdate) {
    const logOutput = execGit([
      "log", "--oneline", "--no-decorate",
      `HEAD..origin/main`,
    ]);
    if (logOutput) {
      newCommits = logOutput.split("\n").filter(Boolean);
      commitsBehind = newCommits.length;
    }
  }

  return { hasUpdate, current, latest, commitsBehind, newCommits };
}

/**
 * 檢查工作目錄是否乾淨（沒有未提交的更改）
 */
export function isWorkingDirClean(): boolean {
  const status = execGit(["status", "--porcelain"]);
  return status.length === 0;
}

/**
 * 執行 git pull 更新程式碼
 */
export function performUpdate(): UpdateResult {
  try {
    // Check working directory
    if (!isWorkingDirClean()) {
      return {
        success: false,
        message: "工作目錄有未提交的更改，請先處理後再更新。",
      };
    }

    // Pull latest code
    execGit(["pull", "origin", "main"]);

    // Get new version
    const newHash = execGit(["rev-parse", "--short", "HEAD"]);

    return {
      success: true,
      message: `更新成功！新版本：${newHash}`,
      newHash,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `更新失敗：${err.message}`,
    };
  }
}

/**
 * 重啟進程
 *
 * 分兩種模式處理：
 *   1. tsx watch 模式：觸發 entry file 的 mtime 變化，tsx watcher 會自動重啟
 *   2. 生產模式（node dist/...）：spawn 新進程（detached），然後 exit 舊進程
 *
 * 延遲時間確保 Telegram 訊息能先送達。
 */
export function restartProcess(delayMs = 2000): void {
  console.log(`[updater] 將在 ${delayMs}ms 後重啟...`);

  setTimeout(() => {
    const argvStr = process.argv.slice(1).join(" ");
    const isWatch =
      (argvStr.includes("tsx") && argvStr.includes("watch")) ||
      process.env.TSX_WATCH === "true";

    // 關閉資料庫（兩種模式都需要）
    try {
      closeDb();
    } catch (e) {
      console.error("[updater] 關閉資料庫失敗：", e);
    }

    if (isWatch) {
      // tsx watch 模式：觸發 file change 讓 watcher 自動重啟
      console.log("[updater] tsx watch 模式：觸發 watcher 重啟...");
      try {
        const entryFile = process.argv[process.argv.length - 1];
        const now = new Date();
        utimesSync(entryFile, now, now);
      } catch (e) {
        console.error("[updater] 觸發 watcher 重啟失敗，直接退出：", e);
      }
      console.log("[updater] 舊進程正在退出...");
      process.exit(0);
      return;
    }

    // 生產模式：spawn 新的 detached 進程
    console.log("[updater] 正在啟動新進程...");
    const child = spawn(
      process.execPath,
      process.argv.slice(1),
      {
        detached: true,
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
      } satisfies SpawnOptions,
    );
    child.unref();

    console.log("[updater] 舊進程正在退出...");
    process.exit(0);
  }, delayMs);
}

/**
 * 更新並重啟（git pull + restart）
 */
export function updateAndRestart(): UpdateResult {
  const result = performUpdate();
  if (result.success) {
    restartProcess(2000);
  }
  return result;
}
