import { createClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase-config.js";

const configured = Boolean(SUPABASE_URL.trim() && SUPABASE_PUBLISHABLE_KEY.trim());

export const supabase = configured
    ? createClient(SUPABASE_URL.trim(), SUPABASE_PUBLISHABLE_KEY.trim(), {
        auth: {
            autoRefreshToken: true,
            detectSessionInUrl: true,
            persistSession: true
        }
    })
    : null;

export const supabaseConfigured = configured;
