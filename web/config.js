// Supabase connection for the tracker frontend. Both values are public by design: the URL is
// where the API lives and the publishable (anon) key only identifies the project. Row-level
// security in schema `recruiting` decides what a signed-in user can see. Never put a
// service-role or sb_secret_ key here or anywhere else in web/.
//
// These are the LOCAL Docker stack values printed by `npx supabase status` (every local stack
// uses the same ones). For the hosted project (Phase 8) replace them with:
//   supabaseUrl: "https://hibjqcgitqtgmkurghlw.supabase.co"
//   supabaseKey: the publishable key from Dashboard -> Project Settings -> API Keys
//                (sb_publishable_..., or the legacy anon key)
// and make sure schema `recruiting` is in the Data API's exposed schemas and the page's URL is
// registered under Authentication -> URL Configuration (README.md steps 5 and 6).
window.RECRUITER_CONFIG = {
  supabaseUrl: "http://127.0.0.1:54321",
  supabaseKey: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"
};
