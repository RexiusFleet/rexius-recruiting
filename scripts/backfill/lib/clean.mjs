// The cleanup rules moved to supabase/functions/_shared/clean.mjs in Phase 5 so the webhook
// Edge Function can bundle them (the Supabase CLI only packages files under supabase/functions).
// That file is canonical; this one re-exports it so the backfill and its tests keep importing
// ./lib/clean.mjs. Change the rules there, never here.
export * from "../../../supabase/functions/_shared/clean.mjs";
