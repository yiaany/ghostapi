import { Redis } from "@upstash/redis";
import type { HostedConfig } from "./config.js";

export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Rate limit exceeded.");
  }
}

export class RateLimitUnavailableError extends Error {
  constructor() {
    super("Rate limit service is unavailable.");
  }
}

export function createRateLimiter(config: HostedConfig) {
  const redis = new Redis({ url: config.redisUrl, token: config.redisToken });
  const increment = redis.createScript<[number, number]>(`
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
    return { count, redis.call('PTTL', KEYS[1]) }
  `);

  return {
    async ping(): Promise<void> {
      try {
        const response = await redis.ping();
        if (response !== "PONG")
          throw new Error("Unexpected Redis ping response.");
      } catch {
        throw new RateLimitUnavailableError();
      }
    },
    async consume(key: string, limit: number, windowMs: number): Promise<void> {
      if (
        !/^[a-z0-9:_-]{1,160}$/.test(key) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        !Number.isInteger(windowMs) ||
        windowMs < 1_000
      )
        throw new Error("Rate limit input is invalid.");
      try {
        const [count, ttl] = await increment.exec([key], [String(windowMs)]);
        if (count > limit)
          throw new RateLimitError(
            Math.max(1, Math.ceil(Math.max(0, ttl) / 1_000)),
          );
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        throw new RateLimitUnavailableError();
      }
    },
  };
}
