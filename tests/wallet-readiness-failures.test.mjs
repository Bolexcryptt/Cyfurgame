import test from 'node:test';
import assert from 'node:assert/strict';

const {
  getApprovedCyfurMintAddress,
  getSolanaNetwork,
  getSolanaRpcUrl,
  isDepositSettingEnabled,
  RELICGRID_CYFUR_MINT_ADDRESS
} = await import('../server/lib/solana-deposit.js');
const { serviceRequest } = await import('../server/lib/wallet.js');

test('deposit switches default closed and require explicit true configuration', () => {
  const names = [
    'SOLANA_NETWORK',
    'SOLANA_RPC_URL',
    'WALLET_APPROVED_CYFUR_MINT_ADDRESS',
    'WALLET_DIRECT_TREASURY_READY',
    'WALLET_DEPOSITS_ENABLED',
    'WALLET_MAINNET_DEPOSITS_ENABLED'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];

  try {
    assert.equal(getSolanaNetwork(), 'mainnet-beta');
    assert.equal(getSolanaRpcUrl(), 'https://api.mainnet-beta.solana.com');
    assert.equal(getApprovedCyfurMintAddress(), RELICGRID_CYFUR_MINT_ADDRESS);
    for (const name of names.slice(3)) {
      assert.equal(isDepositSettingEnabled(name), false);
      process.env[name] = '';
      assert.equal(isDepositSettingEnabled(name), false);
      process.env[name] = 'true';
      assert.equal(isDepositSettingEnabled(name), true);
      delete process.env[name];
    }
    process.env.WALLET_DEPOSITS_ENABLED = 'false';
    assert.equal(isDepositSettingEnabled('WALLET_DEPOSITS_ENABLED'), false);
    process.env.WALLET_DEPOSITS_ENABLED = 'TRUE';
    assert.equal(isDepositSettingEnabled('WALLET_DEPOSITS_ENABLED'), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('missing approved CYFUR mint is treated as unconfigured', () => {
  const original = process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS;
  const originalNetwork = process.env.SOLANA_NETWORK;
  delete process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS;
  process.env.SOLANA_NETWORK = 'devnet';

  try {
    assert.equal(getApprovedCyfurMintAddress(), null);
  } finally {
    if (original === undefined) delete process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS;
    else process.env.WALLET_APPROVED_CYFUR_MINT_ADDRESS = original;
    if (originalNetwork === undefined) delete process.env.SOLANA_NETWORK;
    else process.env.SOLANA_NETWORK = originalNetwork;
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
