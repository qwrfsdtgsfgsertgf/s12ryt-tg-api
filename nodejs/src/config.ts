import dotenv from "dotenv";
import { getConfiguredMemoryMB } from "./memory.js";
dotenv.config();

export interface Config {
  BOT_TOKEN: string;
  ADMIN_ID: number;
  API_PORT: number;
  DATABASE_PATH: string;
  DEFAULT_API_URL: string;
  MEMORY_LIMIT_MB: number | null;
  CLOUDFLARE_TUNNEL: string;
  CLOUDFLARE_TOKEN: string;
  GITHUB_MIRROR: string;
  NPM_REGISTRY: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config: Config = {
  BOT_TOKEN: requireEnv("BOT_TOKEN"),
  ADMIN_ID: parseInt(requireEnv("ADMIN_ID"), 10),
  API_PORT: parseInt(process.env.API_PORT ?? "8000", 10),
  DATABASE_PATH: process.env.DATABASE_PATH ?? "./data/bot.db",
  DEFAULT_API_URL: process.env.DEFAULT_API_URL ?? "http://localhost:8000",
  MEMORY_LIMIT_MB: getConfiguredMemoryMB(),
  CLOUDFLARE_TUNNEL: process.env.CLOUDFLARE_TUNNEL ?? "",
  CLOUDFLARE_TOKEN: process.env.CLOUDFLARE_TOKEN ?? "",
  GITHUB_MIRROR: process.env.GITHUB_MIRROR ?? "",
  NPM_REGISTRY: process.env.NPM_REGISTRY ?? "",
};
