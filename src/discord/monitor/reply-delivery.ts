import type { RequestClient } from "@buape/carbon";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { RuntimeEnv } from "../../runtime.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { enforceAgentRateLimit } from "../rate-limit.js";
import { sendMessageDiscord } from "../send.js";

export async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  agentId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
}) {
  const chunkLimit = Math.min(params.textLimit, 2000);
  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }
    const replyTo = params.replyToId?.trim() || undefined;

    if (mediaList.length === 0) {
      let isFirstChunk = true;
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
      });
      if (!chunks.length && text) {
        chunks.push(text);
      }
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) {
          continue;
        }

        // Enforce per-agent rate limit (delays if budget exhausted)
        if (params.agentId) {
          await enforceAgentRateLimit(params.agentId);
        }

        try {
          await sendMessageDiscord(params.target, trimmed, {
            token: params.token,
            rest: params.rest,
            accountId: params.accountId,
            replyTo: isFirstChunk ? replyTo : undefined,
          });
          isFirstChunk = false;
        } catch (err) {
          // Log chunk send failure but don't drop remaining chunks
          params.runtime.logger?.error("Discord chunk send failed", {
            error: err,
            chunkIndex: chunks.indexOf(chunk),
            totalChunks: chunks.length,
            agentId: params.agentId,
          });
          // Continue to next chunk instead of breaking entire delivery
        }
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }

    // Enforce per-agent rate limit before first media message
    if (params.agentId) {
      await enforceAgentRateLimit(params.agentId);
    }

    try {
      await sendMessageDiscord(params.target, text, {
        token: params.token,
        rest: params.rest,
        mediaUrl: firstMedia,
        accountId: params.accountId,
        replyTo,
      });
    } catch (err) {
      params.runtime.logger?.error("Discord media send failed (first)", {
        error: err,
        agentId: params.agentId,
      });
    }

    for (const extra of mediaList.slice(1)) {
      // Enforce rate limit for each additional media message
      if (params.agentId) {
        await enforceAgentRateLimit(params.agentId);
      }

      try {
        await sendMessageDiscord(params.target, "", {
          token: params.token,
          rest: params.rest,
          mediaUrl: extra,
          accountId: params.accountId,
        });
      } catch (err) {
        params.runtime.logger?.error("Discord media send failed (extra)", {
          error: err,
          mediaIndex: mediaList.indexOf(extra),
          totalMedia: mediaList.length,
          agentId: params.agentId,
        });
      }
    }
  }
}
