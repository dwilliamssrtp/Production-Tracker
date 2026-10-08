// SRTP Production Tracker — photo upload gatekeeper
//
// The browser cannot write to the reel-photos bucket: it has no insert policy, and the
// anon key that ships in index.html grants no storage write at all. To upload, the page
// asks here for permission. This function checks the caller's session the same way every
// other action does, and only then hands back a one-time upload link.
//
// Why it exists: the whole point of leaving the Google Sheet was closing the hole where
// edit access to the file bypassed every login and role check in the app. Letting anyone
// holding the public key upload into storage would have reintroduced a smaller version of
// exactly that. Photos now obey the same rule as readings and thickness checks.
//
// verify_jwt is off deliberately: this app does not use Supabase Auth, so there is no JWT
// to verify. Authentication is the app's own session token, checked below against the
// sessions table — so the function is NOT unauthenticated, it just authenticates
// differently. Remove that check and this becomes an open upload endpoint.
//
// Deploy with: supabase functions deploy photo-upload-url --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BUCKET = 'reel-photos';

// Only what the bucket accepts, mapped to the extension we store it under.
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { token?: string; pipeCode?: string; contentType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Bad request body' }, 400);
  }

  const token = (body.token ?? '').trim();
  const pipeCode = (body.pipeCode ?? '').trim();
  const contentType = (body.contentType ?? '').toLowerCase();

  if (!token) return json({ error: 'Not signed in' }, 401);
  if (!pipeCode) return json({ error: 'pipeCode is required' }, 400);

  const ext = EXT[contentType];
  if (!ext) {
    return json({ error: `That file type can't be uploaded (${contentType || 'unknown'})` }, 400);
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // One source of truth for "is this session valid": the same function every other call
  // goes through. It raises if the token is dead, expired or belongs to a disabled
  // account, so there is no second copy of the rule here to drift out of step.
  const { error: authErr } = await admin.rpc('api_ping', { p_token: token });
  if (authErr) return json({ error: 'Not signed in', code: 'session_invalid' }, 401);

  // The reel must exist. Checked before issuing a link so a bad code can't leave an
  // orphaned object sitting in the bucket with nothing pointing at it.
  const { data: pipe, error: pipeErr } = await admin
    .from('pipes')
    .select('pipe_code')
    .eq('pipe_code', pipeCode)
    .maybeSingle();
  if (pipeErr) return json({ error: pipeErr.message }, 500);
  if (!pipe) return json({ error: `Reel not found: ${pipeCode}` }, 404);

  // Foldered by reel so the bucket stays navigable, and named with a UUID so one upload
  // can never overwrite another.
  const path = `${pipeCode}/${crypto.randomUUID()}.${ext}`;

  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (signErr) return json({ error: signErr.message }, 500);

  // supabase-js v2 returns signedUrl absolute. It returned a bare path in older versions
  // and the first deploy of this function prepended the storage base unconditionally,
  // producing a doubled ".../storage/v1https://.../storage/v1/..." that 404d. Handle both
  // rather than depending on which shape the pinned client happens to give back.
  const signedUrl = signed.signedUrl;
  const uploadUrl = /^https?:\/\//i.test(signedUrl)
    ? signedUrl
    : `${url}/storage/v1${signedUrl.startsWith('/') ? '' : '/'}${signedUrl}`;

  return json({
    path,
    uploadUrl,
    publicUrl: `${url}/storage/v1/object/public/${BUCKET}/${path}`,
  });
});
