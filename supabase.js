import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase-config.js";

const configured = Boolean(SUPABASE_URL.trim() && SUPABASE_PUBLISHABLE_KEY.trim());

export const supabase = configured
    ? createClient(SUPABASE_URL.trim(), SUPABASE_PUBLISHABLE_KEY.trim(), {
        auth: {
            autoRefreshToken: true,
            detectSessionInUrl: false,
            persistSession: true
        }
    })
    : null;

export const supabaseConfigured = configured;
