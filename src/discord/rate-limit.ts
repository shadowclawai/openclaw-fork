/**
 * Per-agent rate limit tracker for Discord messages.
 * Enforces 3 messages per 2 minutes per agent by delaying sends when budget is exhausted.
 */

type RateLimitBucket = {
  timestamps: number[];
  /** Promise chain to serialize all operations on this bucket */
  operationChain: Promise<void>;
};

const RATE_LIMIT_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const RATE_LIMIT_MAX_MESSAGES = 3;

/**
 * Global registry tracking message timestamps per agent.
 * Key: agentId, Value: bucket with timestamps and pending delay promise
 */
const agentBuckets = new Map<string, RateLimitBucket>();

/**
 * Get or create rate limit bucket for an agent.
 */
function getBucket(agentId: string): RateLimitBucket {
  let bucket = agentBuckets.get(agentId);
  if (!bucket) {
    bucket = { timestamps: [], operationChain: Promise.resolve() };
    agentBuckets.set(agentId, bucket);
  }
  return bucket;
}

/**
 * Remove timestamps outside the current rate limit window.
 */
function pruneOldTimestamps(bucket: RateLimitBucket, now: number): void {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  bucket.timestamps = bucket.timestamps.filter((ts) => ts > cutoff);
}

/**
 * Calculate how long to wait before the next message can be sent.
 * Returns 0 if budget is available, otherwise milliseconds to wait.
 */
function calculateDelayMs(bucket: RateLimitBucket, now: number): number {
  pruneOldTimestamps(bucket, now);

  if (bucket.timestamps.length < RATE_LIMIT_MAX_MESSAGES) {
    return 0; // Budget available
  }

  // Budget exhausted - wait until oldest timestamp expires
  const oldestTimestamp = bucket.timestamps[0];
  if (!oldestTimestamp) {
    return 0;
  }

  const expiresAt = oldestTimestamp + RATE_LIMIT_WINDOW_MS;
  const delayMs = Math.max(0, expiresAt - now);
  return delayMs;
}

/**
 * Enforce per-agent rate limit by delaying if necessary.
 * Returns a promise that resolves when the message can be sent.
 *
 * @param agentId - Agent identifier (e.g., "claw", "developer", "reviewer")
 * @returns Promise that resolves when rate limit budget is available
 */
export async function enforceAgentRateLimit(agentId: string): Promise<void> {
  const bucket = getBucket(agentId);

  // Chain this operation onto the bucket's promise chain to prevent race conditions
  const operationPromise = bucket.operationChain.then(async () => {
    const now = Date.now();
    pruneOldTimestamps(bucket, now);

    // Calculate delay needed before this message can send
    const delayMs = calculateDelayMs(bucket, now);

    if (delayMs > 0) {
      // Wait until rate limit budget is available
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      // Prune again after delay
      pruneOldTimestamps(bucket, Date.now());
    }

    // Record this message timestamp
    bucket.timestamps.push(Date.now());
  });

  // Update the chain so next call waits for this one
  bucket.operationChain = operationPromise;

  // Wait for this operation to complete
  await operationPromise;
}

/**
 * Get current rate limit status for an agent.
 * Useful for monitoring/debugging.
 */
export function getAgentRateLimitStatus(agentId: string): {
  messagesInWindow: number;
  budgetRemaining: number;
  nextAvailableAt: number | null;
} {
  const bucket = getBucket(agentId);
  const now = Date.now();
  pruneOldTimestamps(bucket, now);

  const messagesInWindow = bucket.timestamps.length;
  const budgetRemaining = Math.max(0, RATE_LIMIT_MAX_MESSAGES - messagesInWindow);

  let nextAvailableAt: number | null = null;
  if (budgetRemaining === 0 && bucket.timestamps.length > 0) {
    const oldestTimestamp = bucket.timestamps[0];
    if (oldestTimestamp) {
      nextAvailableAt = oldestTimestamp + RATE_LIMIT_WINDOW_MS;
    }
  }

  return {
    messagesInWindow,
    budgetRemaining,
    nextAvailableAt,
  };
}

/**
 * Clear rate limit history for an agent.
 * Useful for testing or manual reset.
 */
export function clearAgentRateLimit(agentId: string): void {
  agentBuckets.delete(agentId);
}

/**
 * Get all agents currently being rate-limited.
 * Useful for monitoring/debugging.
 */
export function getAllAgentRateLimitStatus(): Record<
  string,
  {
    messagesInWindow: number;
    budgetRemaining: number;
    nextAvailableAt: number | null;
  }
> {
  const result: Record<string, ReturnType<typeof getAgentRateLimitStatus>> = {};
  for (const agentId of agentBuckets.keys()) {
    result[agentId] = getAgentRateLimitStatus(agentId);
  }
  return result;
}
