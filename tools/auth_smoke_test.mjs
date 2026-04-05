import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  TEST_EMAIL,
  TEST_PASSWORD,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TEST_EMAIL || !TEST_PASSWORD) {
  console.error("Missing env vars.");
  console.error({
    SUPABASE_URL,
    SUPABASE_ANON_KEY: Boolean(SUPABASE_ANON_KEY),
    TEST_EMAIL,
    TEST_PASSWORD: Boolean(TEST_PASSWORD),
  });
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await sb.auth.signInWithPassword({
  email: TEST_EMAIL,
  password: TEST_PASSWORD,
});

console.log("error:", error);
console.log("user_id:", data?.user?.id ?? null);
console.log("has_session:", Boolean(data?.session?.access_token));
