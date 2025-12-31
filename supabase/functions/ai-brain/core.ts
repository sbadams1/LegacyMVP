// supabase/functions/ai-brain/core.ts
//
// Thin router that delegates to the turn pipeline. Keeping this file small makes future refactors safer.

import { runTurnPipeline } from "./pipelines/turn.ts";

export async function handler(req: Request): Promise<Response> {
  return runTurnPipeline(req);
}
