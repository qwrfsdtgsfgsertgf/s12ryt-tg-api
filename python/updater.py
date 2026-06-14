"""
程式內置更新模組

功能：
  - 查詢當前 / 遠端最新版本 (git commit hash)
  - 執行 git pull 更新程式碼
  - 自動重啟進程 (os.execv)
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# ============================================================
# 資料結構
# ============================================================


@dataclass
class VersionInfo:
    """版本資訊"""
    hash: str           # 短 commit hash
    date: str           # ISO 8601 提交時間
    message: str        # 提交訊息第一行


@dataclass
class UpdateCheckResult:
    """更新檢查結果"""
    has_update: bool
    current: VersionInfo
    latest: VersionInfo
    commits_behind: int
    new_commits: list[str]


@dataclass
class UpdateResult:
    """更新執行結果"""
    success: bool
    message: str
    new_hash: str | None = None


# ============================================================
# Git 輔助函數
# ============================================================


def _run_git(args: list[str], timeout: int = 30) -> str:
    """執行 git 命令，回傳 stdout（已 strip）"""
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode != 0:
            err = (result.stderr or "").strip()
            out = (result.stdout or "").strip()
            raise RuntimeError(err or out or f"git {' '.join(args)} failed (exit {result.returncode})")
        return (result.stdout or "").strip()
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {' '.join(args)} timed out after {timeout}s")


def _parse_version_info(ref: str) -> VersionInfo:
    """從 git ref 取得版本資訊"""
    hash_ = _run_git(["rev-parse", "--short", ref])
    date = _run_git(["log", "-1", "--format=%cI", ref])
    message = _run_git(["log", "-1", "--format=%s", ref])
    return VersionInfo(hash=hash_, date=date, message=message)


# ============================================================
# 公開 API
# ============================================================


def get_current_version() -> VersionInfo:
    """取得當前版本資訊"""
    return _parse_version_info("HEAD")


def fetch_and_check_update() -> UpdateCheckResult:
    """
    Fetch 遠端並檢查是否有更新。
    呼叫後 origin/main 會更新到最新。
    """
    # Step 1: Fetch latest from remote
    _run_git(["fetch", "origin", "main"])

    current = _parse_version_info("HEAD")
    latest = _parse_version_info("origin/main")

    # Step 2: Compare hashes
    current_full = _run_git(["rev-parse", "HEAD"])
    latest_full = _run_git(["rev-parse", "origin/main"])
    has_update = current_full != latest_full

    # Step 3: Get commits behind (if any)
    new_commits: list[str] = []
    commits_behind = 0

    if has_update:
        log_output = _run_git([
            "log", "--oneline", "--no-decorate",
            "HEAD..origin/main",
        ])
        if log_output:
            new_commits = [line for line in log_output.split("\n") if line]
            commits_behind = len(new_commits)

    return UpdateCheckResult(
        has_update=has_update,
        current=current,
        latest=latest,
        commits_behind=commits_behind,
        new_commits=new_commits,
    )


def is_working_dir_clean() -> bool:
    """檢查工作目錄是否乾淨（沒有未提交的更改）"""
    status = _run_git(["status", "--porcelain"])
    return len(status) == 0


def perform_update() -> UpdateResult:
    """執行 git pull 更新程式碼"""
    try:
        if not is_working_dir_clean():
            return UpdateResult(
                success=False,
                message="工作目錄有未提交的更改，請先處理後再更新。",
            )

        _run_git(["pull", "origin", "main"])

        new_hash = _run_git(["rev-parse", "--short", "HEAD"])

        return UpdateResult(
            success=True,
            message=f"更新成功！新版本：{new_hash}",
            new_hash=new_hash,
        )
    except Exception as e:
        return UpdateResult(
            success=False,
            message=f"更新失敗：{e}",
        )


async def restart_process(delay: float = 2.0) -> None:
    """
    重啟進程（非阻塞方式）。

    使用 asyncio.create_task 排程延遲重啟，
    讓呼叫端可以先回覆 Telegram 訊息。

    重啟方式：os.execv 直接替換當前進程。
    """
    logger.info("[updater] 將在 %.1f 秒後重啟...", delay)

    async def _do_restart():
        await asyncio.sleep(delay)

        # 刷新使用量佇列，避免資料遺失
        try:
            from db import database
            await database._flush_usage_queue()
        except Exception as e:
            logger.error("[updater] 刷新使用量佇列失敗：%s", e)

        logger.info("[updater] 正在重啟進程...")
        # os.execv 替換當前進程 — 乾淨的重啟
        # 新進程從 main() 開始，重新初始化一切
        os.execv(sys.executable, [sys.executable] + sys.argv)

    asyncio.create_task(_do_restart())
