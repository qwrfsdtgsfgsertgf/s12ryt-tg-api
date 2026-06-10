"""
User handlers - Regular user commands for the Telegram Bot.

Commands: /start, /url, /key, /usage, /key-add, /key-del,
          /start-coding, /set-coding, /model_catch
"""
import logging

from telegram import Update
from telegram.ext import ContextTypes, ConversationHandler

from config import Config
from db import database
from db.database import (
    get_coding_config_by_tg_id,
    set_coding_config,
)
from bot.handlers.model_fetcher import (
    fetch_models_no_auth,
    fetch_provider_models,
)
from bot.handlers.admin_handlers import _safe_reply_models

logger = logging.getLogger(__name__)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start command."""
    await update.message.reply_text("你好!")


async def url_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /url command - Return current API endpoint."""
    # Check settings first, fall back to default
    url = await database.get_setting("api_url")
    if not url:
        url = Config.DEFAULT_API_URL
    await update.message.reply_text(f"當前 API 接口: {url}")


async def key_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /key command.
    If user has no key, create one. Otherwise return existing keys.
    """
    tg_user_id = update.effective_user.id

    # Ensure user exists in database
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        # Auto-create user on first /key
        username = update.effective_user.username or ""
        await database.add_user(tg_user_id, username)
        user = await database.get_user_by_tg_id(tg_user_id)

    # Get existing keys
    keys = await database.get_keys_by_user(tg_user_id)

    if not keys:
        # First time - create a new key
        result = await database.add_api_key(tg_user_id)
        if result:
            await update.message.reply_text(f"您的 key: {result['key']}")
        else:
            await update.message.reply_text("❌ 創建 key 失敗，請稍後再試。")
    else:
        # Show existing keys
        key_list = "\n".join(f"  `{k['key']}`" for k in keys if k.get("is_active"))
        if not key_list:
            # All keys inactive, create new one
            result = await database.add_api_key(tg_user_id)
            if result:
                await update.message.reply_text(f"您的 key: {result['key']}")
            else:
                await update.message.reply_text("❌ 創建 key 失敗，請稍後再試。")
        else:
            await update.message.reply_text(f"您的 key:\n{key_list}", parse_mode="Markdown")


async def usage_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /usage command - Show token usage for all user's API keys."""
    tg_user_id = update.effective_user.id
    keys = await database.get_keys_by_user(tg_user_id)

    if not keys:
        await update.message.reply_text("您還沒有任何 API key，請使用 /key 創建。")
        return

    lines = []
    for key_record in keys:
        if not key_record.get("is_active"):
            continue
        key_display = key_record["key"][:20] + "..."
        usage_records = await database.get_usage_by_key(key_record["id"])

        total_input = sum(r.get("input_tokens", 0) for r in usage_records)
        total_output = sum(r.get("output_tokens", 0) for r in usage_records)
        total_input_cost = sum(r.get("input_cost", 0) for r in usage_records)
        total_output_cost = sum(r.get("output_cost", 0) for r in usage_records)

        lines.append(
            f"🔑 `{key_display}`\n"
            f"  輸入 token: {total_input:,}\n"
            f"  輸出 token: {total_output:,}\n"
            f"  輸入費用: ${total_input_cost:.6f}\n"
            f"  輸出費用: ${total_output_cost:.6f}"
        )

    if not lines:
        await update.message.reply_text("暫無使用記錄。")
    else:
        await update.message.reply_text("\n\n".join(lines), parse_mode="Markdown")


async def key_add_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /key-add command - Add a new API key."""
    tg_user_id = update.effective_user.id

    # Ensure user exists
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        username = update.effective_user.username or ""
        await database.add_user(tg_user_id, username)

    result = await database.add_api_key(tg_user_id)
    if result:
        await update.message.reply_text(f"您的 key: {result['key']}")
    else:
        await update.message.reply_text("❌ 創建 key 失敗，請稍後再試。")


async def key_del_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /key-del command - List keys for multi-select deletion."""
    tg_user_id = update.effective_user.id
    keys = await database.get_keys_by_user(tg_user_id)

    active_keys = [k for k in keys if k.get("is_active")]
    if not active_keys:
        await update.message.reply_text("您沒有可刪除的 API key。")
        return

    # Store keys in user_data for later callback processing
    context.user_data["keys_to_delete"] = {str(i + 1): k["id"] for i, k in enumerate(active_keys)}
    context.user_data["selected_for_deletion"] = set()

    # Build numbered list
    lines = []
    for i, k in enumerate(active_keys, 1):
        lines.append(f"{i}. `{k['key']}`")

    await update.message.reply_text(
        "請回覆要刪除的 key 編號（多選用逗號分隔，如: 1,2）：\n\n" + "\n".join(lines),
        parse_mode="Markdown",
    )

    # Set state for text reply handling
    return "WAITING_KEY_DEL"


async def key_del_text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle text reply for /key-del multi-select."""
    text = update.message.text.strip()
    keys_map: dict = context.user_data.get("keys_to_delete", {})
    selected: set = context.user_data.get("selected_for_deletion", set())

    # Parse selection
    try:
        indices = [idx.strip() for idx in text.split(",")]
        for idx in indices:
            if idx in keys_map:
                selected.add(idx)
    except Exception:
        await update.message.reply_text("❌ 格式錯誤，請使用數字編號（如: 1,2）。")
        return "WAITING_KEY_DEL"

    # Delete selected keys
    deleted = 0
    for idx in selected:
        key_id = keys_map.get(idx)
        if key_id:
            success = await database.delete_api_key(key_id)
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個 API key。")

    # Clean up
    context.user_data.pop("keys_to_delete", None)
    context.user_data.pop("selected_for_deletion", None)
    return -1  # End conversation


# ============================================================
# /start-coding - Toggle coding mode on/off
# ============================================================

async def start_coding_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start-coding - Toggle coding mode for the current user."""
    from db.database import reset_coding_session_stats
    tg_user_id = update.effective_user.id

    # Ensure user exists
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        await update.message.reply_text("❌ 您尚未註冊，請先使用 /key 創建 API key。")
        return

    config = await get_coding_config_by_tg_id(tg_user_id)

    if config and config.get("is_active"):
        # Currently active → deactivate + show session summary
        # Capture stats before deactivating
        s_in = config.get("session_input_tokens", 0) or 0
        s_out = config.get("session_output_tokens", 0) or 0
        s_in_cost = config.get("session_input_cost", 0.0) or 0.0
        s_out_cost = config.get("session_output_cost", 0.0) or 0.0
        s_reqs = config.get("session_requests", 0) or 0

        await set_coding_config(user["id"], is_active=0)

        if s_reqs > 0:
            import json
            total_cost = s_in_cost + s_out_cost
            # Build per-model breakdown
            model_counts_raw = config.get("session_model_counts", "{}") or "{}"
            try:
                model_counts = json.loads(model_counts_raw) if isinstance(model_counts_raw, str) else {}
            except (json.JSONDecodeError, TypeError):
                model_counts = {}
            model_breakdown = ""
            if model_counts:
                model_breakdown = "\n\n📋 模型調用統計：\n" + "\n".join(
                    f"   {m}: {c} 次" for m, c in model_counts.items()
                )
            await update.message.reply_text(
                f"🔴 Coding 模式已關閉。\n\n"
                f"📊 本次 Coding Session 統計：\n"
                f"   調用次數：{s_reqs}\n"
                f"   輸入 Token：{s_in:,}\n"
                f"   輸出 Token：{s_out:,}\n"
                f"   輸入費用：${s_in_cost:.6f}\n"
                f"   輸出費用：${s_out_cost:.6f}\n"
                f"   總費用：${total_cost:.6f}"
                + model_breakdown
            )
        else:
            await update.message.reply_text("🔴 Coding 模式已關閉。\n\n📊 本次 Session 無請求記錄。")
    else:
        # Currently inactive → activate + reset session stats
        if config and config.get("fallback_models"):
            await set_coding_config(user["id"], is_active=1)
            await reset_coding_session_stats(user["id"])
            fallback_list = [m.strip() for m in config["fallback_models"].split(",") if m.strip()]
            await update.message.reply_text(
                f"🟢 Coding 模式已開啟！\n\n"
                f"📋 當前 Fallback 模型鏈：\n"
                + "\n".join(f"   {i + 1}. {m}" for i, m in enumerate(fallback_list))
                + f"\n\n最大重試次數：{config.get('max_retries', 3)}"
            )
        else:
            # No fallback configured yet
            await set_coding_config(user["id"], is_active=1)
            await update.message.reply_text(
                "🟢 Coding 模式已開啟，但尚未設定 Fallback 模型。\n"
                "請使用 /set_coding 設定 Fallback 模型鏈。"
            )


# ============================================================
# /set-coding - Multi-turn conversation to configure coding mode
# ============================================================

SET_CODING_FALLBACK = 0
SET_CODING_MAX_RETRIES = 1


async def set_coding_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /set-coding conversation."""
    tg_user_id = update.effective_user.id
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        await update.message.reply_text("❌ 您尚未註冊，請先使用 /key 創建 API key。")
        return ConversationHandler.END

    # Show current config
    config = await get_coding_config_by_tg_id(tg_user_id)
    if config and config.get("fallback_models"):
        current = config["fallback_models"]
        await update.message.reply_text(
            f"📋 當前 Coding 模式設定：\n"
            f"   Fallback 模型：{current}\n"
            f"   最大重試次數：{config.get('max_retries', 3)}\n"
            f"   狀態：{'🟢 開啟' if config.get('is_active') else '🔴 關閉'}\n\n"
            "請輸入新的 Fallback 模型鏈（用逗號分隔，按順序排列）：\n"
            "例如：claude-4-sonnet,gpt-4o,deepseek-v3\n\n"
            "或輸入 skip 保持不變："
        )
    else:
        # Show available models
        from db.database import get_provider_cache
        cache = get_provider_cache()
        available = sorted(cache.keys())

        model_list = "\n".join(f"   {m}" for m in available[:30])
        suffix = f"\n   ...還有 {len(available) - 30} 個" if len(available) > 30 else ""

        await update.message.reply_text(
            "🔧 設定 Coding 模式 — Fallback 模型鏈\n\n"
            "當主模型報錯時，會按順序嘗試以下模型：\n\n"
            f"📦 可用模型：\n{model_list}{suffix}\n\n"
            "請輸入 Fallback 模型鏈（用逗號分隔，按優先順序排列）：\n"
            "例如：claude-4-sonnet,gpt-4o,deepseek-v3"
        )

    return SET_CODING_FALLBACK


async def set_coding_fallback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive fallback model chain."""
    text = update.message.text.strip().lower()
    tg_user_id = update.effective_user.id
    user = await database.get_user_by_tg_id(tg_user_id)

    if text == "skip":
        await update.message.reply_text("請輸入最大重試次數（1-10），或輸入 skip 保持預設（3）：")
        return SET_CODING_MAX_RETRIES

    # Validate models exist
    from db.database import get_provider_cache
    cache = get_provider_cache()
    models = [m.strip() for m in text.split(",") if m.strip()]

    invalid = [m for m in models if m not in cache]
    if invalid:
        await update.message.reply_text(
            f"❌ 以下模型不存在：{', '.join(invalid)}\n\n"
            "請重新輸入，或輸入 skip 保持不變："
        )
        return SET_CODING_FALLBACK

    context.user_data["coding_fallback_models"] = ",".join(models)

    await update.message.reply_text(
        f"✅ Fallback 模型鏈：\n"
        + "\n".join(f"   {i + 1}. {m}" for i, m in enumerate(models))
        + "\n\n請輸入最大重試次數（1-10），或輸入 skip 保持預設（3）："
    )
    return SET_CODING_MAX_RETRIES


async def set_coding_max_retries(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive max retries and save config."""
    text = update.message.text.strip().lower()
    tg_user_id = update.effective_user.id
    user = await database.get_user_by_tg_id(tg_user_id)

    if text == "skip":
        max_retries = 3
    else:
        try:
            max_retries = int(text)
            if not 1 <= max_retries <= 10:
                await update.message.reply_text("❌ 請輸入 1-10 之間的數字：")
                return SET_CODING_MAX_RETRIES
        except ValueError:
            await update.message.reply_text("❌ 請輸入數字（1-10）：")
            return SET_CODING_MAX_RETRIES

    fallback_models = context.user_data.pop("coding_fallback_models", None)

    # Get current config to preserve fallback_models if skipped
    current_config = await get_coding_config_by_tg_id(tg_user_id)
    if fallback_models is None:
        fallback_models = current_config.get("fallback_models", "") if current_config else ""

    await set_coding_config(
        user["id"],
        is_active=1,  # Auto-enable when configured
        fallback_models=fallback_models,
        max_retries=max_retries,
    )

    fallback_list = [m.strip() for m in fallback_models.split(",") if m.strip()]
    await update.message.reply_text(
        "✅ Coding 模式設定完成！\n\n"
        f"📋 Fallback 模型鏈：\n"
        + "\n".join(f"   {i + 1}. {m}" for i, m in enumerate(fallback_list))
        + f"\n\n最大重試次數：{max_retries}\n"
        "狀態：🟢 已開啟\n\n"
        "使用 /start-coding 可以開關 Coding 模式。"
    )
    return ConversationHandler.END


async def set_coding_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel /set-coding conversation."""
    context.user_data.pop("coding_fallback_models", None)
    await update.message.reply_text("❌ 設定已取消。")
    return ConversationHandler.END


# ============================================================
# /model_catch - Fetch model list from an external API URL
# ============================================================

MODEL_CATCH_URL = 0
MODEL_CATCH_KEY = 1


async def model_catch_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /model_catch conversation — ask for URL."""
    await update.message.reply_text(
        "🔍 請輸入要抓取模型的 API URL：\n\n"
        "例如：https://api.example.com/v1"
    )
    return MODEL_CATCH_URL


async def model_catch_url(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive URL and try fetching models without auth."""
    url = update.message.text.strip()
    context.user_data["model_catch_url"] = url

    await update.message.reply_text("⏳ 正在嘗試抓取模型列表（不帶 Key）...")

    models, needs_auth = await fetch_models_no_auth(url)

    if needs_auth:
        await update.message.reply_text(
            "🔒 伺服器要求認證（401/403）。\n"
            "請輸入 API Key，或輸入 /cancel 取消："
        )
        return MODEL_CATCH_KEY

    if not models:
        await update.message.reply_text(
            "❌ 無法從該 URL 獲取模型列表。\n"
            "可能原因：URL 不正確、伺服器無回應、或回應格式不支援。\n\n"
            "請確認 URL 格式後重新嘗試。"
        )
        return ConversationHandler.END

    # Display models (with safe pagination)
    await _safe_reply_models(update, models, header=f"✅ 找到 {len(models)} 個模型：")
    context.user_data.pop("model_catch_url", None)
    return ConversationHandler.END


async def model_catch_key(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive API key and retry fetching models."""
    api_key = update.message.text.strip()
    url = context.user_data.get("model_catch_url", "")

    await update.message.reply_text("⏳ 正在使用 Key 重新抓取模型列表...")

    # Try with openai_chat format (most common)
    models = await fetch_provider_models(url, api_key, "openai_chat")

    if not models:
        # Try google format as fallback
        models = await fetch_provider_models(url, api_key, "google")

    if not models:
        await update.message.reply_text(
            "❌ 即使使用 Key 也無法獲取模型列表。\n"
            "請確認 URL 和 Key 是否正確。"
        )
        context.user_data.pop("model_catch_url", None)
        return ConversationHandler.END

    # Display models (with safe pagination)
    await _safe_reply_models(update, models, header=f"✅ 找到 {len(models)} 個模型：")
    context.user_data.pop("model_catch_url", None)
    return ConversationHandler.END


async def model_catch_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel /model_catch conversation."""
    context.user_data.pop("model_catch_url", None)
    await update.message.reply_text("❌ 已取消。")
    return ConversationHandler.END


def register_user_handlers(app):
    """Register all user command handlers."""
    from telegram.ext import CommandHandler, MessageHandler, filters, ConversationHandler
    from bot.filters import trusted_user_filter

    # Simple commands
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("url", url_command, filters=filters.Async(trusted_user_filter.filter_async)))
    app.add_handler(CommandHandler("key", key_command, filters=filters.Async(trusted_user_filter.filter_async)))
    app.add_handler(CommandHandler("usage", usage_command, filters=filters.Async(trusted_user_filter.filter_async)))
    app.add_handler(CommandHandler("key_add", key_add_command, filters=filters.Async(trusted_user_filter.filter_async)))
    app.add_handler(CommandHandler("start_coding", start_coding_command, filters=filters.Async(trusted_user_filter.filter_async)))

    # /key-del needs conversation
    key_del_conv = ConversationHandler(
        entry_points=[CommandHandler("key_del", key_del_command, filters=filters.Async(trusted_user_filter.filter_async))],
        states={
            "WAITING_KEY_DEL": [MessageHandler(filters.TEXT & ~filters.COMMAND, key_del_text_handler)],
        },
        fallbacks=[CommandHandler("cancel", lambda u, c: -1)],
    )
    app.add_handler(key_del_conv)

    # /set-coding needs conversation
    set_coding_conv = ConversationHandler(
        entry_points=[CommandHandler("set_coding", set_coding_start, filters=filters.Async(trusted_user_filter.filter_async))],
        states={
            SET_CODING_FALLBACK: [MessageHandler(filters.TEXT & ~filters.COMMAND, set_coding_fallback)],
            SET_CODING_MAX_RETRIES: [MessageHandler(filters.TEXT & ~filters.COMMAND, set_coding_max_retries)],
        },
        fallbacks=[CommandHandler("cancel", set_coding_cancel)],
    )
    app.add_handler(set_coding_conv)

    # /model_catch needs conversation (URL → optional key)
    model_catch_conv = ConversationHandler(
        entry_points=[CommandHandler("model_catch", model_catch_start, filters=filters.Async(trusted_user_filter.filter_async))],
        states={
            MODEL_CATCH_URL: [MessageHandler(filters.TEXT & ~filters.COMMAND, model_catch_url)],
            MODEL_CATCH_KEY: [MessageHandler(filters.TEXT & ~filters.COMMAND, model_catch_key)],
        },
        fallbacks=[CommandHandler("cancel", model_catch_cancel)],
    )
    app.add_handler(model_catch_conv)
