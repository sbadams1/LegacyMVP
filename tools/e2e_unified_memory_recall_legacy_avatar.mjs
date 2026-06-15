import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

let USER_ID = null;

const BASE_URL = process.env.BASE_URL || "https://qhlnfgtnqtepwuwbloai.supabase.co/functions/v1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SB_SECRET_KEY;
const EMAIL = process.env.TEST_USER_EMAIL;
const PASSWORD = process.env.TEST_USER_PASSWORD;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase();

const RUN_ID = randomUUID().slice(0, 8);
const factContainer = `cobalt travel sleeve ${RUN_ID}`;
const factItem = `brass border-entry card ${RUN_ID}`;
const storyPlace = `Harborbell ${RUN_ID}`;
const storyObject = `ivory pocket map ${RUN_ID}`;
const storyObstacle = `blue tram receipt ${RUN_ID}`;

 function fail(msg, details = {}) {
   console.error("FAIL:", msg);
   console.error("details:", details);
   process.exit(1);
 }

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

 async function login() {
  const { data, error } = await client.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });

  if (error) fail("Login failed", error.message);
  USER_ID = data.session.user.id;
  return data.session.access_token;
 }

 async function aiCall(token, mode, message, conversation_id = null) {
   const res = await fetch(`${BASE_URL}/ai-brain`, {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
     },
     body: JSON.stringify({
      user_id: USER_ID,
      message_text: message,
       conversation_id,
      mode,
      op: "e2e_no_proxy",
      preferred_locale: "en",
     }),
   });
   const json = await res.json();
   if (!res.ok || json?.error) {
     fail("ai-brain call failed", { status: res.status, json });
   }
   return json;
  }

function isBadReply(text) {
  const t = norm(text);
  return (
    t.includes("i do not recall") ||
    t.includes("i don't recall") ||
    t.includes("i do not remember") ||
    t.includes("i don't remember") ||
    t.includes("i do not have") ||
    t.includes("i don't have") ||
    t.includes("can you remind me") ||
    t.includes("could you remind me") ||
    t.includes("?") ||
    t.includes("i likely") ||
    t.includes("perhaps") ||
    t.includes("maybe")
  );
}

function requireContent(label, text, required) {
  const t = norm(text);
  const hits = required.filter((x) => t.includes(norm(x)));
  console.log(`${label} hits:`, hits);

  if (hits.length === 0) {
fail(`${label} missing required recall content`, {
  reply_text: text,
});
  }

  if (isBadReply(text)) {
    fail(`${label} produced denial/speculative/question reply`, { text });
   }
 }

function requireExactRecall(label, text, required) {
  const t = norm(text);
  const missing = required.filter((x) => !t.includes(norm(x)));
  console.log(`${label} exact required:`, required);

  if (missing.length > 0) {
    fail(`${label} missing exact seeded recall values`, {
      reply_text: text,
      missing,
      required,
    });
  }

  if (isBadReply(text)) {
    fail(`${label} produced denial/speculative/question reply`, { text });
  }
}

function rejectPromptEcho(label, replyText, promptText) {
  const reply = norm(replyText).replace(/\s+/g, " ").trim();
  const prompt = norm(promptText).replace(/\s+/g, " ").trim();

  if (reply === prompt || reply.includes(prompt)) {
    fail(`${label} echoed the prompt instead of recalling stored memory`, {
      reply_text: replyText,
      prompt_text: promptText,
    });
  }
}

(async () => {
  console.log("Logging in...");
  const token = await login();
  console.log("JWT acquired ✔");

  // -----------------------------
  // STEP 1: Seed memory
  // -----------------------------
  console.log("Seeding memory...");

   const seed = await aiCall(
     token,
     "legacy",
     `Remember this:

My travel papers are kept in a ${factContainer}, and inside it I keep a ${factItem}.
 
 Also:
Last Saturday in ${storyPlace}, I crossed a glass footbridge during heavy rain, dropped my ${storyObstacle}, recovered it beside the clock tower, and used my ${storyObject} to find the south gate.`
   );

   const seedConversationId = seed.conversation_id;
  if (!seedConversationId) {
    fail("Seed call did not return conversation_id", { seed });
  }

  await aiCall(token, "legacy", "__END_SESSION__", seedConversationId);

  // -----------------------------
  // STEP 2: Wait for memory via DB truth, not model phrasing
  // -----------------------------
  console.log("Waiting for memory to persist...");

  let factsReady = false;
  let storyReady = false;
  let latestSummary = null;
  let matchedStoryKey = null;

  for (let i = 0; i < 60; i++) {
    await sleep(1000);

    const ms = await admin
      .from("memory_summary")
      .select("*")
      .eq("conversation_id", seedConversationId)
      .order("created_at", { ascending: false })
      .limit(1);

    const sr = await admin
      .from("story_recall")
      .select("id, title, synopsis, conversation_id")
      .eq("conversation_id", seedConversationId)
      .order("created_at", { ascending: false })
      .limit(1);

    const uk = await admin
      .from("user_knowledge")
      .select("facts")
      .eq("user_id", USER_ID)
      .maybeSingle();

    latestSummary = ms.data?.[0] ?? null;
    const storyRow = sr.data?.[0] ?? null;
    const facts = uk.data?.facts ?? null;

    const insights =
      latestSummary?.session_insights ??
      latestSummary?.extras?.session_insights ??
      null;

    const phaseBDoneInline =
      String(insights?.phase ?? "").trim().toUpperCase() === "B" &&
      (
        String(insights?.extra?.job_id ?? "").startsWith("inline:") ||
        Number(insights?.counts?.facts_items ?? 0) > 0
      );

    const nonStoryFacts =
      facts && typeof facts === "object"
        ? Object.entries(facts).filter(([k]) => !String(k).startsWith("stories."))
        : [];

     factsReady = nonStoryFacts.some(([k, v]) => {
       const hay = `${k} ${JSON.stringify(v)}`.toLowerCase();
       return (
        hay.includes(norm(factContainer)) &&
        hay.includes(norm(factItem))
       );
     });

    if (storyRow && facts && typeof facts === "object") {
      const keys = Object.keys(facts).filter((k) => String(k).startsWith("stories."));
      const titleNorm = norm(storyRow.title);
      const synopsisNorm = norm(storyRow.synopsis);

      matchedStoryKey =
        keys.find((k) => {
           const kn = norm(k);
           return (
            kn.includes(norm(storyPlace)) ||
            kn.includes(norm(storyObject)) ||
            kn.includes(norm(storyObstacle)) ||
             (titleNorm && kn.includes(titleNorm)) ||
             (synopsisNorm && (
              synopsisNorm.includes(norm(storyPlace)) ||
              synopsisNorm.includes(norm(storyObject)) ||
              synopsisNorm.includes(norm(storyObstacle))
             ))
           );
         }) ?? null;
    }

    storyReady = !!matchedStoryKey;

    console.log(
      `poll ${i}: memory_summary=${latestSummary ? 1 : 0} factsReady=${factsReady} storyReady=${storyReady} phase=${insights?.phase ?? "?"}`,
    );

    if (phaseBDoneInline && factsReady && storyReady) {
      break;
    }
  }

  if (!factsReady || !storyReady) {
    fail("Memory did not persist in time", {
      seed_conversation_id: seedConversationId,
      latest_memory_summary_id: latestSummary?.id ?? null,
      latest_short_summary: latestSummary?.short_summary ?? null,
      factsReady,
      storyReady,
      matchedStoryKey,
    });
  }

  console.log("Memory ready ✔", { matchedStoryKey });

  // -----------------------------
  // STEP 3: FACT RECALL
  // -----------------------------
  console.log("Testing fact recall...");

  const factPrompt = "What sleeve do I use for my travel papers, and what card is inside it?";

  const legacyFact = await aiCall(token, "legacy", factPrompt);
  const avatarFact = await aiCall(token, "avatar", factPrompt);
console.log("RAW legacyFact:", JSON.stringify(legacyFact, null, 2));
console.log("RAW avatarFact:", JSON.stringify(avatarFact, null, 2));

function getReplyText(resp) {
  return (
    resp?.reply_text ??
    resp?.text ??
    resp?.reply?.text ??
    resp?.message ??
    resp?.data?.reply_text ??
    resp?.data?.text ??
    ""
  );
}

requireExactRecall("avatar fact", getReplyText(avatarFact), [factContainer, factItem]);
 
  // -----------------------------
  // STEP 4: STORY RECALL
  // -----------------------------
  console.log("Testing story recall...");

   const storyPrompt = `Tell me the story about ${storyPlace}, the footbridge, and the rain.`;
 
   const legacyStory = await aiCall(token, "legacy", storyPrompt);
   const avatarStory = await aiCall(token, "avatar", storyPrompt);
 
  rejectPromptEcho("legacy story", getReplyText(legacyStory), storyPrompt);
  rejectPromptEcho("avatar story", getReplyText(avatarStory), storyPrompt);

  requireExactRecall("legacy story", getReplyText(legacyStory), [storyPlace, storyObject, storyObstacle, "rain", "footbridge"]);
  requireExactRecall("avatar story", getReplyText(avatarStory), [storyPlace, storyObject, storyObstacle, "rain", "footbridge"]);
  // -----------------------------
  // FINAL
  // -----------------------------
  console.log("\nPASS ✅ Unified memory recall verified");
  console.log("run_id:", RUN_ID);
  console.log("seed conversation_id:", seedConversationId);
  console.log("legacy fact:", legacyFact.reply_text);
  console.log("avatar fact:", avatarFact.reply_text);
  console.log("legacy story:", legacyStory.reply_text);
  console.log("avatar story:", avatarStory.reply_text);
})();