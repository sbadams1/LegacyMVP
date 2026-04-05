 // supabase/functions/ai-brain/core.ts
 //
 // Thin router that delegates to the turn pipeline. Keeping this file small makes future refactors safer.
  
  import { runTurnPipeline } from "./pipelines/turn.ts";
  import { createClient } from "@supabase/supabase-js";
 
// Build fingerprint: use this to prove which bundle is deployed.
const AI_BRAIN_BUILD_STAMP = "2026-02-18T06:30Z";

 export async function handler(req: Request): Promise<Response> {
   const reqClone = req.clone();
   const resp = await runTurnPipeline(req);
 
  // Optional debug logging (off by default): logs a SAFE preview of the response.
  // Enable by setting Supabase secret LOG_AI_BRAIN_REPLY=1.
  try {
    const flag = (Deno.env.get("LOG_AI_BRAIN_REPLY") ?? "").trim();
    if (flag === "1" || flag.toLowerCase() === "true") {
      const ct = resp.headers.get("content-type") ?? "";
      const status = resp.status;

      // Clone so we don't consume the real body stream.
      const text = await resp.clone().text();

      // Keep logs small.
      const previewLimit = 500;
      const preview = text.length > previewLimit ? text.slice(0, previewLimit) + "…(truncated)" : text;

      let parsedKind = "unknown";
      let replyPreview: string | null = null;
      let topLevelType: string | null = null;

      // If it's JSON-ish, try to parse to see whether it's an object vs string.
      const p = preview.trim();
      if (ct.includes("application/json") || p.startsWith("{") || p.startsWith("[") || p.startsWith("\"")) {        try {
          const parsed = JSON.parse(text);
          topLevelType = Array.isArray(parsed) ? "array" : typeof parsed;
          parsedKind = topLevelType;

          if (parsed && typeof parsed === "object") {
            // Common shapes: { reply_text: "..."} or { reply: "..."} etc.
            const rt =
              (parsed as any).reply_text ??
              (parsed as any).reply ??
              (parsed as any).text ??
              null;
            if (typeof rt === "string") replyPreview = rt.length > 200 ? rt.slice(0, 200) + "…(truncated)" : rt;
          } else if (typeof parsed === "string") {
            // This is the exact "non-object: String" situation.
            replyPreview = parsed.length > 200 ? parsed.slice(0, 200) + "…(truncated)" : parsed;
          }
        } catch {
          parsedKind = "json_parse_failed";
        }
      } else {
         parsedKind = "non_json";
       }
 
      // Best-effort legacy persistence when legacy UI is proxying to avatar brain.
      // This runs only when request.mode === "legacy" AND the returned agent looks like avatar.
      try {
        let reqJson: any = null;
        try { reqJson = await reqClone.json(); } catch { reqJson = null; }

        const reqMode = typeof reqJson?.mode === "string" ? String(reqJson.mode) : null;
        const looksLegacy = reqMode === "legacy";
        const respAgent = (topLevelType === "object" && (() => {
          try {
            const parsed = JSON.parse(text);
            return (parsed as any)?.agent ?? null;
          } catch {
            return null;
          }
        })()) ?? null;
        const looksAvatar = typeof respAgent === "string" && respAgent.toLowerCase().includes("avatar");

        if (looksLegacy && looksAvatar && status === 200) {
          const user_id = reqJson?.user_id;

          // memory_raw.conversation_id is NOT NULL, so guarantee a value.
          const conversation_id =
            (typeof reqJson?.conversation_id === "string" && reqJson.conversation_id.trim().length > 0)
              ? reqJson.conversation_id.trim()
              : (typeof reqJson?.conversationId === "string" && reqJson.conversationId.trim().length > 0)
              ? reqJson.conversationId.trim()
              : (typeof reqJson?.thread_id === "string" && reqJson.thread_id.trim().length > 0)
              ? reqJson.thread_id.trim()
              : (typeof reqJson?.session_id === "string" && reqJson.session_id.trim().length > 0)
              ? reqJson.session_id.trim()
              : crypto.randomUUID();        
          
          const message_text = reqJson?.message_text ?? reqJson?.text ?? reqJson?.q ?? "";

          // Extract reply text from the already-parsed preview if available, else parse full JSON once.
          let fullReply: string | null = replyPreview;
          if (fullReply == null) {
            try {
              const parsed = JSON.parse(text);
              const rt = (parsed as any)?.reply_text ?? (parsed as any)?.reply ?? (parsed as any)?.text ?? null;
              if (typeof rt === "string") fullReply = rt;
            } catch {
              // ignore
            }
          }

          if (typeof user_id === "string" && user_id.length > 10 && typeof message_text === "string" && message_text.trim().length > 0 && typeof fullReply === "string" && fullReply.trim().length > 0) {
            const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? Deno.env.get("SUPABASE_PROJECT_URL") ?? "").trim();
            const serviceKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "").trim();

             if (supabaseUrl && serviceKey) {
               const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
              const wordCount = (s: string) => {
                const t = (s ?? "").trim();
                if (!t) return 0;
                return t.split(/\s+/).filter(Boolean).length;
              };
              const mkTopicKeys = (s: string) => {
                // Very lightweight heuristic; real topic extraction still belongs in the pipeline.
                // Keep it deterministic and small to avoid schema surprises.
                const t = (s ?? "").toLowerCase();
                const keys: string[] = [];
                if (t.includes("story")) keys.push("story");
                if (t.includes("family") || t.includes("daughter") || t.includes("kids")) keys.push("family");
                if (t.includes("work") || t.includes("job") || t.includes("career")) keys.push("work");
                if (t.includes("health") || t.includes("workout") || t.includes("exercise")) keys.push("health");
                return Array.from(new Set(keys)).slice(0, 8);
              };

              const common = {
                // These are the fields you said were missing.
                tags: [] as string[],
                topic_keys: mkTopicKeys(message_text),
                context: {
                  mode: "legacy_proxy_avatar_brain",
                  agent: respAgent,
                  persisted_by: "ai-brain/core.ts",
                } as Record<string, unknown>,
              };
               const rows = [
                {
                  user_id,
                  conversation_id,
                  role: "user",
                  source: "legacy_user",
                  content: message_text,
                  word_count_estimate: wordCount(message_text),
                  ...common,
                },
                {
                  user_id,
                  conversation_id,
                  role: "assistant",
                  source: "legacy_ai",
                  content: fullReply,
                  word_count_estimate: wordCount(fullReply),
                  ...common,
                },
               ];
               const { error } = await sb.from("memory_raw").insert(rows);
               if (error) console.warn("LEGACY_PROXY_MEMORY_RAW_INSERT_FAILED", error);
             } else {
               console.warn("LEGACY_PROXY_MEMORY_RAW_SKIP_MISSING_ENV");
            }
          }
        }
      } catch (e) {
        console.warn("LEGACY_PROXY_MEMORY_RAW_FAILED", String(e));
      }
       console.log("AI_BRAIN_RESPONSE", {
         status,
         content_type: ct,
        parsed_kind: parsedKind,
        top_level_type: topLevelType,
        reply_preview: replyPreview,
        body_preview: replyPreview ? undefined : preview,
      });
    }
   } catch (e) {
     console.warn("AI_BRAIN_RESPONSE_LOG_FAILED", String(e));
   }
 
  // Return the same body but add a fingerprint header without consuming the stream.
  const h = new Headers(resp.headers);
  h.set("x-ai-brain-build", AI_BRAIN_BUILD_STAMP);
  return new Response(resp.body, { status: resp.status, headers: h });
 }
