import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_CONFIG } from "../core/supabaseConfig.js";

let client = null;

function assertBrowserConfig() {
  const { url, publishableKey } = SUPABASE_CONFIG;
  const hasPlaceholder =
    !url ||
    !publishableKey ||
    url.includes("YOUR_PROJECT_REF") ||
    publishableKey.includes("YOUR_SUPABASE_PUBLISHABLE_KEY");

  if (hasPlaceholder) {
    throw new Error(
      "Supabase is not configured. Set url and publishableKey in js/core/supabaseConfig.js."
    );
  }

  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
    throw new Error("SUPABASE_CONFIG.url is not a valid Supabase project URL.");
  }

  if (/service_role|sb_secret_/i.test(publishableKey)) {
    throw new Error("A secret/service_role key must never be used in browser source code.");
  }
}

export function getSupabaseClient() {
  if (client) {
    return client;
  }

  assertBrowserConfig();

  client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  });

  return client;
}
