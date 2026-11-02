import test from 'node:test';
import assert from 'node:assert/strict';

const { getApprovedCyfurMintAddress } = await import('../server/lib/solana-deposit.js');
const { serviceRequest } = await import('../server/lib/wallet.js');

test('missing approved CYFUR mint is treated as unconfigured', () => {
  const original = process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS;
  delete process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS;

  try {
    assert.equal(getApprovedCyfurMintAddress(), null);
  } finally {
    if (original === undefined) delete process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS;
    else process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS = original;
  }
});

test('trusted wallet database failures surface the backend status and Supabase code', async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;

  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  global.fetch = async () => new Response(
    JSON.stringify({ code: 'PGRST301', message: 'permission denied' }),
    { status: 403 }
  );

  try {
    await assert.rejects(
      () => serviceRequest('wallet_system_config?select=id'),
      (error) => {
        assert.equal(error.message, 'Trusted wallet database request failed.');
        assert.equal(error.status, 403);
        assert.equal(error.code, 'PGRST301');
        return true;
      }
    );
  } finally {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;

    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;

    global.fetch = originalFetch;
  }
});
