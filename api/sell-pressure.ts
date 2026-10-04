import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/sell-pressure?days=30 — where LINGO selling comes from.
 *
 * One bulk read of every LINGO Transfer and every pool Swap over the window
 * (plus a 30-day look-back), then everything is computed in memory:
 *
 *   VENUES   where LINGO left to be sold
 *     DEX       LINGO swapped INTO the LINGO/WETH pools. The seller is the
 *               address that LOST LINGO in that transaction (net delta), so a
 *               router, aggregator or smart wallet in between doesn't hide it.
 *     Exchange  LINGO sent to a known exchange hot wallet, or to one of its
 *               customer deposit addresses. A deposit address is found by its
 *               sweep: an unlabelled address whose LINGO goes ≥95% to one
 *               exchange's hot wallets. The depositor is whoever funded it.
 *     Bridge    LINGO sent to a bridge (mostly Wormhole → Solana).
 *
 *   ORIGINS  where each seller's LINGO came from in the 30 days before they
 *            sold, by value: unstaked, vesting claims, APY claims, community
 *            rewards, bought on the DEX, withdrawn from an exchange, bridged
 *            in, project wallets, or another wallet (followed one more hop).
 *            Sellers who mostly recycle — buy on the DEX and deposit to an
 *            exchange, or the reverse — are flagged as arbitrage: they move
 *            volume, not net supply.
 *
 * Admin/cron only (never on a page view); ~30–80 Alchemy requests per run.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const HIST_PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`;
const CRON_SECRET = process.env.CRON_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const LINGO = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const STAKING = '0x9af8c0dac726ccee2bfd6c0f3e21f320d42398ac';
const V3_POOL = '0x9399da51c1a85e64cce4b30b554875d2b89b2445';   // LINGO is token1
const V2_PAIR = '0xb08fefa8f0f01b9a224fdef416e919b1ceba0d84';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 86_400;
const BLOCKS_PER_DAY = 43_200;
const LOOKBACK_DAYS = 30;
const MAX_REQUESTS = 400;
const LOG_PAGE_LIMIT = 9500;
const INITIAL_CHUNK = 300_000;       // ~7 days per request; split only if refused
const DUST = 1;                      // < 1 LINGO is poisoning dust / zero-fee legs

// ─── Who is who (same lists as api/backfill-stake-sources.ts) ───────────

type Kind = 'pool' | 'router' | 'cex' | 'bridge' | 'staking' | 'apy' | 'vesting' | 'claim' | 'reward' | 'project' | 'onbehalf' | 'mint';
const ENTITIES: Record<string, { kind: Kind; name: string }> = {};
const add = (kind: Kind, m: Record<string, string>) => { for (const [a, n] of Object.entries(m)) ENTITIES[a] = { kind, name: n }; };
add('pool', {
  '0x9399da51c1a85e64cce4b30b554875d2b89b2445': 'LINGO/WETH V3', '0xb08fefa8f0f01b9a224fdef416e919b1ceba0d84': 'LINGO/WETH V2',
  '0x6d85d9f6d80b433ef9eed943e83868d71805a6cd': 'LINGO/WETH 1%', '0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap V4',
  '0x675177f8ede3f25f8149b4e9df7562798014467f': 'Aerodrome', '0x6d2205bd16d9f132713e00fb9e1da8ffb5150d37': 'Aerodrome',
  '0x1ba7301b43b69f1dc9a6d2017b090a52ff386478': 'Aerodrome', '0x0191fea2ff26116dec46ea699c65b8696020e766': 'Aerodrome',
});
add('router', {
  '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap', '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap', '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
  '0x6cb442acf35158d5eda88fe602221b67b400be3e': 'Aerodrome', '0x19ceead7105607cd444f5ad10dd51356436095a1': 'Odos',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch', '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap', '0xc7d3ab410d49b664d03fe5b1038852ac852b1b29': 'KyberSwap',
  '0x6a000f20005980200259b80c5102003040001068': 'ParaSwap', '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'ParaSwap',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW Swap', '0x6352a56caadc4f1e25cd6c75970fa768a3304e64': 'OpenOcean',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x/Matcha', '0x053bd88ae6fb19ad94d6ac781dcfc178a463436c': '0x/Matcha',
  '0xdb6f1920a889355780af7570773609bd8cb1f498': '0x/Matcha', '0x881d40237659c251811cec9c364ef91dc08d300c': 'MetaMask Swaps',
  '0x67d03631fe51b741c0c00c4e16eb662ac84381df': 'OKX DEX', '0x6b2c0c7be2048daa9b5527982c29f48062b34d58': 'OKX DEX',
  '0x5e8df5b010d57e525562791717011d496676552a': 'OKX DEX', '0x3d98f6f05e7940c056788ff8492a943a0904240d': 'OKX DEX',
  '0x69c236e021f5775b0d0328ded5eac708e3b869df': 'OKX DEX', '0x5e2f47bd7d4b357fcfd0bb224eb665773b1b9801': 'OKX DEX',
  '0x2bd541ab3b704f7d4c9dff79efadeaa85ec034f1': 'OKX DEX', '0xbc1d9760bd6ca468ca9fb5ff2cfbeac35d86c973': 'Bitget DEX',
  '0xb141f554188cf306fde443f6e991949636f80e49': 'Bitget Swap', '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': 'LI.FI/Jumper',
  '0x02e5be68d46dac0b524905bff209cf47ee6db2a9': 'a swap proxy', '0x411d2c093e4c2e69bf0d8e94be1bf13dadd879c6': 'an aggregator',
  '0xd688ab46dc476a05a093e4442d06ceb348adbda8': 'an aggregator',
  // Found by the first run as "collectors": swap contracts, not exchanges (Blockscout: BaseSettler = 0x Protocol).
  '0x7747f8d2a76bd6345cc29622a946a929647f2359': '0x Settler', '0x4f6f91599858bf0d19fabcf2c5d591fe13f7c059': '0x Settler',
  '0x0a2854fbbd9b3ef66f17d47284e7f899b9509330': 'a swap contract', '0x8f10b468b06c6fd214b65f87778827f7d113f996': 'a swap contract',
});
add('cex', {
  '0x18b0f4547a89fe4c5fe84f258bea3601fa281e9f': 'KuCoin', '0xb8e6d31e7b212b2b7250ee9c26c56cebbfbe6b23': 'KuCoin',
  '0x4e3ae00e8323558fa5cac04b152238924aa31b60': 'MEXC', '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate',
  '0x6596da8b65995d5feacff8c2936f0b7a2051b0d0': 'Gate', '0xc882b111a75c0c657fc507c04fbfcd2cc984f071': 'Gate',
  '0x7793cd85c11a924478d358d49b05b37e91b5810f': 'Gate', '0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c': 'Gate',
  '0x234ee9e35f8e9749a002fc42970d570db716453b': 'Gate', '0x05ee546c1a62f90d7acbffd6d846c9c54c7cf94c': 'Gate',
  '0x9c4fe1c3d5975e5c5e493f24352969aa280b7cfc': 'LBank', '0xbaed383ede0e5d9d72430661f3285daa77e9439f': 'Bybit',
  '0x2ded5ce31a0c61ecaf6429a1ba1a00b2bfe67099': 'Bybit', '0x0051ef9259c7ec0644a80e866ab748a2f30841b3': 'Bybit',
  '0xb5873e333161e5b45adac57379ec2b15d861178d': 'Bybit', '0x4ce053dfe58541e08f149c1050eb3df09d7a40bc': 'Bybit',
  '0x97b9d2102a9a65a26e1ee82d59e42d1b73b68689': 'Bitget', '0xffa8db7b38579e6a2d14f9b347a9ace4d044cd54': 'Bitget',
  '0x2b3bf74b29f59fb8dda41cf3d6a8da28cf8e7921': 'BingX', '0xd38cf87f114f2a0582c329fb9df4f7044ce71330': 'BingX',
  '0x406c22b8740ae955b04fd11c2061e053807e2a69': 'BingX', '0x74b0e133bee3384dfcfa60b31d85d8e2062de811': 'BingX',
  '0x6c69fa64ec451b1bc5b5fbaa56cf648a281634be': 'BingX', '0xaf1e33f8153f25e304dec5cb544b5b6ccc5520ed': 'BingX',
  '0xef317e433b0836f294866d43f67d6871b609b351': 'BingX', '0x1651d700cd4020334bd185ba4c6e0271ffc0c732': 'BingX',
  '0xdec815281519f6cb080090317e0ba3e446fafe43': 'BingX', '0xc4334a9af50c80a12c484de643149f6159bdd110': 'BingX',
  '0xb48c5ca99d33a8625e125f69ac8e07f3dffe34a0': 'BingX', '0xc3dcd744db3f114f0edf03682b807b78a227bf74': 'BingX',
  '0x7a8ba143f8866242782e5b3a5ad1410bb6722206': 'HTX', '0xdb861e302ef7b7578a448e951aede06302936c28': 'Phemex',
  '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a': 'Binance', '0x9430801ebaf509ad49202aabc5f5bc6fd8a3daf8': 'Binance',
  '0xe69f81b825d7dc31ee9becef4dbeab5cf30e3abb': 'Binance', '0x15ece0d7de25436bcfcf3d62a9085ddc7838aee9': 'Binance',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance', '0x1985ea6e9c68e1c272d8209f3b478ac2fdb25c87': 'Coinbase',
  '0x91d66b38ae24292e9e12dd962bbb3aecf4ab769a': 'Coinbase', '0x6dcbce46a8b494c885d0e7b6817d2b519df64467': 'Coinbase',
  '0x739120ade7ed878fca5bbdb806263a8258fe2360': 'Coinbase', '0x20fe51a9229eef2cf8ad9e89d91cab9312cf3b7a': 'Coinbase',
  '0xb4807865a786e9e9e26e6a9610f2078e7fc507fb': 'Coinbase', '0x40ebc1ac8d4fedd2e144b75fe9c0420be82750c6': 'Coinbase',
  '0xd34ea7278e6bd48defe656bbe263aef11101469c': 'Coinbase', '0xc5c10e7f6d31e3979d4466a099e2df4af8fa0208': 'Coinbase',
  '0x382ffce2287252f930e1c8dc9328dac5bf282ba1': 'Coinbase', '0xfd92f4e91d54b9ef91cc3f97c011a6af0c2a7eda': 'OKX',
  '0x39591e7c099a379fd7b349ebfecaeef439c40454': 'OKX', '0x10b7dfc30e290b77ded2550d66974c6a124dfa0d': 'OKX',
  '0x8db0f952b8b6a462445c732c41ec2937bcae9c35': 'OKX', '0x8744f9a43c22c804553835ba33c5c402af3c79d6': 'OKX',
  '0x42cf18596ee08e877d532df1b7cf763059a7ea57': 'OKX', '0xb4ec508adeb174610b4295e233a458b3475964f7': 'OKX',
  '0x6d046280c44c0fee770563614f7a7a71f156ca20': 'OKX', '0x64fa910048403c5d2243f471d63fca013ecb4d2b': 'OKX',
  '0xc215537e47a1d01058f3ba39dce6752d8f217bbd': 'OKX', '0x2ce910fbba65b454bbaf6a18c952a70f3bcd8299': 'OKX',
  '0xb604f2d512eaa32e06f1ac40362bc9157ce5da96': 'Kraken', '0xa6e5f4b57869b4a12e83e98bbcbccf0480c20861': 'Kraken',
  '0xbb2e8648035b760836c16ebb14f6b666f9ea1010': 'Kraken', '0x94dbf04e273d87e6d9bed68c616f43bf86560c74': 'Kraken',
  '0x50afe53eb8123d33061ae5b16c1ad2ce995f82a0': 'Kraken', '0x60e942f97fd46ab7a0dd5dced40ef2796c043c7d': 'Kraken',
  '0xae45a8240147e6179ec7c9f92c5a18f9a97b3fca': 'Crypto.com', '0xb7333d779c6ecdfc4507a53706b0e173bd086a18': 'Crypto.com',
});
add('bridge', {
  '0x7c91baca69ad289ec5de46b0b36287770a1ea91e': 'Wormhole', '0xfcb443fd643a09f4740214bc1895b0f31a109f3d': 'Wormhole',
  '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f': 'Relay', '0xa5f565650890fba1824ee0f21ebbbf660a179934': 'Relay',
  '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be': 'Relay', '0x4cd00e387622c35bddb9b4c962c136462338bc31': 'Relay',
  '0xf70da97812cb96acdf810712aa562db8dfa3dbef': 'Relay', '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64': 'Across',
  '0x3a23f943181408eac424116af7b7790c94cb97a5': 'Socket/Bungee', '0xe7351fd770a37282b91d153ee690b63579d6dd7f': 'deBridge',
  '0x7e7a0e201fd38d3adaa9523da6c109a07118c96a': 'Synapse', '0x4200000000000000000000000000000000000010': 'Base bridge',
  '0x80c67432656d59144ceff962e8faf8926599bcf8': 'Orbiter', '0xe4edb277e41dc89ab076a1f049f4a3efa700bce8': 'Orbiter',
});
add('staking', { [STAKING]: 'Staking contract' });
add('apy', { '0x2f26621e931c32542579cf8860d7e8616df32e0e': 'APY rewards' });
add('vesting', { '0xad11f733e401e16c72033c5decaf05dcc0e1beb8': 'Vesting', '0x8001b2029782bbf1b3c85c3a23ecae60e3fa0447': 'Vesting (Decubate)' });
add('claim', { '0x610111763a4a6c64dd8926c12ca3e52fb7b7897c': 'Token claim' });
add('reward', { '0xffc781ddfa8d1358ce8c7dda7ced1e56e922aea6': 'Reward wallet', '0x64967c0dd5605dd3efc6a9bb148b2687a532c15f': 'Previous reward wallet' });
add('project', {
  '0x0e0bc2919540119fc22a502842a74af4d81502b6': 'Treasury', '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513': 'Team Buybacks',
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb': 'Team Buybacks', '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58': 'Team Multisig',
  '0x0fe275fdfde7eb75a15c0ae8971450dd6f06e7f8': 'Project Safe', '0x8557ef53d037408d225479dd8544dffb06c88d46': 'Liquidity Locker',
  '0x3ea37aa113b092dd14dfada7118efb919c092d0d': 'Liquidity Locker', '0xc588e4415ab61aa8a9496efbe9d715de75550e2a': 'Deployer',
  '0xe8313a4b7a6aaea9e92a8d4acbb08034cb39bf2f': 'Team wallet', '0x2bd8fc849f7c91ce2d3e9c78dd85792a0b14da6d': 'Buy-and-stake wallet',
});
add('onbehalf', { '0x53a78a339262e374950c491884b0954323b616ef': 'Lingo direct buy' });
add('mint', { [ZERO]: 'Mint' });
const entityOf = (a: string) => ENTITIES[a] ?? null;

// ─── Pure analysis (exported for tests) ──────────────────────────────────

export interface Transfer { ts: number; block: number; logIndex: number; tx: string; from: string; to: string; lingo: number }
export interface Swap { ts: number; tx: string; pool: 'v3' | 'v2'; lingoIntoPool: number; wethAbs: number }

export type Origin = 'unstaked' | 'vesting' | 'apy' | 'claim' | 'rewards' | 'dex_buy' | 'cex_withdrawal' | 'bridged_in' | 'project' | 'wallet' | 'held';
const ORIGIN_OF_KIND: Partial<Record<Kind, Origin>> = {
  staking: 'unstaked', vesting: 'vesting', mint: 'vesting', apy: 'apy', claim: 'claim', reward: 'rewards',
  pool: 'dex_buy', router: 'dex_buy', cex: 'cex_withdrawal', bridge: 'bridged_in', project: 'project', onbehalf: 'project',
};

export interface SellEvent { ts: number; tx: string; venue: string; seller: string; lingo: number; usd: number; via: 'dex' | 'deposit_address' | 'hot_wallet' | 'bridge' }

export interface AnalyzeInput {
  transfers: Transfer[];          // window + look-back, any order
  swaps: Swap[];                  // window + look-back
  ethPriceAt: (day: number) => number | null;
  windowStart: number;            // unix seconds
  windowEnd: number;
  /** All-time LINGO received by the biggest sellers, by funding source — catches project-funded wallets. */
  allTime?: Map<string, Record<string, number>>;
}

const r0 = (n: number) => Math.round(n);

export function analyze(input: AnalyzeInput) {
  const { windowStart, windowEnd } = input;
  const transfers = input.transfers.filter(t => t.lingo >= DUST).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const inWindow = (ts: number) => ts >= windowStart && ts < windowEnd;

  // ── LINGO/USD by day from the V3 pool itself (WETH side × ETH/USD) ──
  const acc = new Map<number, { usd: number; lingo: number }>();
  for (const s of input.swaps) {
    if (s.pool !== 'v3') continue;
    const d = Math.floor(s.ts / DAY); const eth = input.ethPriceAt(d);
    if (eth == null || s.lingoIntoPool === 0) continue;
    const a = acc.get(d) ?? { usd: 0, lingo: 0 };
    a.usd += s.wethAbs * eth; a.lingo += Math.abs(s.lingoIntoPool); acc.set(d, a);
  }
  const priceDays = [...acc.keys()].sort((a, b) => a - b);
  const priceAt = (ts: number) => {
    const d = Math.floor(ts / DAY);
    const exact = acc.get(d); if (exact) return exact.usd / exact.lingo;
    let best: number | undefined;
    for (const pd of priceDays) { if (pd <= d) best = pd; else { if (best === undefined) best = pd; break; } }
    const a = best !== undefined ? acc.get(best) : undefined;
    return a ? a.usd / a.lingo : 0;
  };

  // ── Per-sender destinations, one pass (unlabelled senders only) ──
  const outDest = new Map<string, Map<string, number>>();
  for (const t of transfers) {
    if (entityOf(t.from)) continue;
    const m = outDest.get(t.from) ?? new Map<string, number>();
    m.set(t.to, (m.get(t.to) ?? 0) + t.lingo); outDest.set(t.from, m);
  }
  // Exchange deposit addresses: unlabelled, and ≥95% of their LINGO goes to one
  // exchange's hot wallets. On EVM chains exchanges credit customers only via
  // per-customer deposit addresses, so this is the sweep pattern.
  const depositExchange = new Map<string, string>();
  for (const [addr, m] of outDest) {
    let total = 0; const byEx = new Map<string, number>();
    for (const [to, v] of m) { total += v; const e = entityOf(to); if (e?.kind === 'cex') byEx.set(e.name, (byEx.get(e.name) ?? 0) + v); }
    for (const [ex, v] of byEx) if (v >= 0.95 * total) depositExchange.set(addr, ex);
  }

  // ── Sell events in the window ──
  const events: SellEvent[] = [];
  const byTx = new Map<string, Transfer[]>();
  for (const t of transfers) { const l = byTx.get(t.tx) ?? []; l.push(t); byTx.set(t.tx, l); }
  const swapsByTx = new Map<string, Swap[]>();
  for (const s of input.swaps) { const l = swapsByTx.get(s.tx) ?? []; l.push(s); swapsByTx.set(s.tx, l); }

  let dexBuyLingo = 0, dexBuyUsd = 0, arbLingo = 0;
  for (const [tx, swaps] of swapsByTx) {
    const ts = swaps[0].ts;
    if (!inWindow(ts)) continue;
    const into = swaps.reduce((a, s) => a + Math.max(0, s.lingoIntoPool), 0);
    const out = swaps.reduce((a, s) => a + Math.max(0, -s.lingoIntoPool), 0);
    dexBuyLingo += out; dexBuyUsd += out * priceAt(ts);
    if (into <= 0) continue;
    const net = new Map<string, number>();
    for (const t of byTx.get(tx) ?? []) {
      net.set(t.from, (net.get(t.from) ?? 0) - t.lingo);
      net.set(t.to, (net.get(t.to) ?? 0) + t.lingo);
    }
    let seller = '', worst = 0;
    for (const [a, v] of net) if (entityOf(a)?.kind !== 'pool' && v < worst) { worst = v; seller = a; }
    // Nobody lost at least half of what went into the pool: an arbitrage loop, not a seller.
    if (!seller || -worst < 0.5 * into) { arbLingo += into; seller = 'arbitrage / routed'; }
    events.push({ ts, tx, venue: 'DEX', seller, lingo: into, usd: into * priceAt(ts), via: 'dex' });
  }

  // A source contract sending straight into an exchange/bridge is credited to
  // that source ("straight from Staking contract" = unstaked straight to the
  // exchange), not to a wallet.
  const directKind = new Map<string, Kind>();
  for (const t of transfers) {
    if (!inWindow(t.ts)) continue;
    const fromEnt = entityOf(t.from);
    if (fromEnt?.kind === 'cex' || depositExchange.has(t.from)) continue;   // exchange sweeps / internal moves
    const to = entityOf(t.to);
    let venue: string | null = null; let via: SellEvent['via'] = 'hot_wallet';
    if (to?.kind === 'cex') { venue = to.name; via = 'hot_wallet'; }
    else if (depositExchange.has(t.to)) { venue = depositExchange.get(t.to)!; via = 'deposit_address'; }
    else if (to?.kind === 'bridge') { venue = `Bridge: ${to.name}`; via = 'bridge'; }
    if (!venue) continue;
    let seller = t.from;
    if (fromEnt && fromEnt.kind !== 'project' && fromEnt.kind !== 'onbehalf') {
      seller = fromEnt.kind === 'pool' || fromEnt.kind === 'router' ? 'DEX buy sent straight to an exchange' : `straight from ${fromEnt.name}`;
      directKind.set(seller, fromEnt.kind);
    }
    events.push({ ts: t.ts, tx: t.tx, venue, seller, lingo: t.lingo, usd: t.lingo * priceAt(t.ts), via });
  }

  // ── Where each seller's LINGO came from (30 days before their last sale) ──
  const inflows = new Map<string, Transfer[]>();
  for (const t of transfers) { const l = inflows.get(t.to) ?? []; l.push(t); inflows.set(t.to, l); }
  const originMix = (addr: string, before: number, hops: number): Map<Origin, number> => {
    const mix = new Map<Origin, number>();
    for (const t of inflows.get(addr) ?? []) {
      if (t.ts >= before || t.ts < before - LOOKBACK_DAYS * DAY) continue;
      const e = entityOf(t.from);
      let o: Origin | undefined = e ? ORIGIN_OF_KIND[e.kind] : depositExchange.has(t.from) ? 'cex_withdrawal' : undefined;
      if (!o && hops > 0) {
        // Another wallet: follow it once, so "unstaked in wallet A, sold from wallet B" still reads as unstaked.
        const up = originMix(t.from, t.ts + 1, hops - 1);
        const upTotal = [...up.values()].reduce((a, b) => a + b, 0);
        if (upTotal > 0) { for (const [k, v] of up) mix.set(k, (mix.get(k) ?? 0) + t.lingo * v / upTotal); continue; }
      }
      o = o ?? 'wallet';
      mix.set(o, (mix.get(o) ?? 0) + t.lingo);
    }
    return mix;
  };

  const sellers = new Map<string, { lingo: number; usd: number; sells: number; venues: Map<string, number>; first: number; last: number }>();
  for (const e of events) {
    const s = sellers.get(e.seller) ?? { lingo: 0, usd: 0, sells: 0, venues: new Map(), first: e.ts, last: e.ts };
    s.lingo += e.lingo; s.usd += e.usd; s.sells++;
    s.venues.set(e.venue, (s.venues.get(e.venue) ?? 0) + e.lingo);
    s.first = Math.min(s.first, e.ts); s.last = Math.max(s.last, e.ts);
    sellers.set(e.seller, s);
  }

  // DEX buys per wallet in the window, to spot DEX→exchange arbitrage.
  const dexBought = new Map<string, number>();
  for (const t of transfers) {
    if (!inWindow(t.ts)) continue;
    const k = entityOf(t.from)?.kind;
    if (k === 'pool' || k === 'router') dexBought.set(t.to, (dexBought.get(t.to) ?? 0) + t.lingo);
  }

  type Row = { address: string; label: string | null; class: string; lingo: number; usd: number; sells: number; venues: Record<string, number>; origins: Record<string, number>; feeders: number; allTime?: Record<string, number>; first: string; last: string };
  const feederCount = (addr: string, before: number) => new Set((inflows.get(addr) ?? []).filter(t => t.ts < before && t.ts >= before - LOOKBACK_DAYS * DAY && !entityOf(t.from)).map(t => t.from)).size;
  const rows: Row[] = [];
  for (const [addr, s] of sellers) {
    const synthetic = addr === 'arbitrage / routed' || directKind.has(addr);
    const mix = synthetic ? new Map<Origin, number>() : originMix(addr, s.last + 1, 1);
    const total = [...mix.values()].reduce((a, b) => a + b, 0);
    const exchangeSold = [...s.venues.entries()].filter(([v]) => v !== 'DEX' && !v.startsWith('Bridge')).reduce((a, [, v]) => a + v, 0);
    const dexSold = s.venues.get('DEX') ?? 0;
    let cls: string;
    if (addr === 'arbitrage / routed') cls = 'arbitrage';
    else if (directKind.has(addr)) {
      const k = directKind.get(addr)!;
      cls = k === 'pool' || k === 'router' ? 'arbitrage (DEX → exchange)' : (ORIGIN_OF_KIND[k] ?? 'wallet');
    }
    else if (exchangeSold > 0 && (dexBought.get(addr) ?? 0) >= 0.5 * exchangeSold) cls = 'arbitrage (DEX → exchange)';
    else if (dexSold > 0 && (mix.get('cex_withdrawal') ?? 0) >= 0.5 * total && total > 0) cls = 'arbitrage (exchange → DEX)';
    else if (dexSold > 0 && (dexBought.get(addr) ?? 0) >= 0.5 * dexSold) cls = 'trader (buys and sells on the DEX)';
    else if (dexSold > 0 && (mix.get('bridged_in') ?? 0) >= 0.5 * total && total > 0) cls = 'cross-chain arbitrage (bridged in, sold here)';
    else if (s.venues.size && [...s.venues.keys()].every(v => v.startsWith('Bridge')) && (dexBought.get(addr) ?? 0) >= 0.5 * s.lingo) cls = 'cross-chain arbitrage (bought here, bridged out)';
    else if (total === 0) cls = 'held (no LINGO received in the 30 days before)';
    else cls = [...mix.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const feeders = synthetic ? 0 : feederCount(addr, s.last + 1);
    if (!synthetic && feeders >= 20 && !cls.startsWith('arbitrage') && !cls.startsWith('trader')) cls = `wallet farm (${feeders} feeder wallets) — ${cls}`;
    // All-time funding beats the 30-day window for big sellers: a wallet the
    // project funded months ago is moving inventory, not dumping.
    const at = input.allTime?.get(addr);
    if (at) {
      const atTotal = Object.values(at).reduce((a, b) => a + b, 0);
      if (atTotal > 0 && (at.project ?? 0) >= 0.5 * atTotal) cls = 'project-funded wallet (team / market maker?)';
    }
    const ent = entityOf(addr);
    rows.push({
      address: addr,
      label: ent ? `${ent.name}` : null,
      feeders,
      allTime: at,
      class: ent?.kind === 'project' || ent?.kind === 'reward' ? `project (${ent.name})` : cls,
      lingo: r0(s.lingo), usd: r0(s.usd), sells: s.sells,
      venues: Object.fromEntries([...s.venues.entries()].map(([k, v]) => [k, r0(v)])),
      origins: total > 0 ? Object.fromEntries([...mix.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / total * 100)])) : {},
      first: new Date(s.first * 1000).toISOString().slice(0, 10),
      last: new Date(s.last * 1000).toISOString().slice(0, 10),
    });
  }
  rows.sort((a, b) => b.usd - a.usd);

  // ── Aggregations ──
  const sum = (f: (e: SellEvent) => boolean) => {
    const sel = events.filter(f);
    return { lingo: r0(sel.reduce((a, e) => a + e.lingo, 0)), usd: r0(sel.reduce((a, e) => a + e.usd, 0)), events: sel.length, sellers: new Set(sel.map(e => e.seller)).size };
  };
  const venues = [...new Set(events.map(e => e.venue))].map(v => ({ venue: v, ...sum(e => e.venue === v) })).sort((a, b) => b.usd - a.usd);
  const byClass = new Map<string, { lingo: number; usd: number; sellers: number }>();
  for (const r of rows) {
    const c = byClass.get(r.class) ?? { lingo: 0, usd: 0, sellers: 0 };
    c.lingo += r.lingo; c.usd += r.usd; c.sellers++; byClass.set(r.class, c);
  }
  const daily = new Map<string, Record<string, number>>();
  for (const e of events) {
    const d = new Date(e.ts * 1000).toISOString().slice(0, 10);
    const row = daily.get(d) ?? {};
    const key = e.venue === 'DEX' ? 'dex' : e.venue.startsWith('Bridge') ? 'bridge' : 'exchanges';
    row[key] = r0((row[key] ?? 0) + e.usd); daily.set(d, row);
  }

  // Unlabelled addresses that collect from many pass-through senders: likely exchange
  // hot wallets we don't know yet (e.g. other MEXC wallets).
  const passThrough = new Map<string, Set<string>>();
  for (const [addr, m] of outDest) {
    let total = 0; for (const v of m.values()) total += v;
    if (total <= 0) continue;
    for (const [to, v] of m) if (!entityOf(to) && v >= 0.95 * total) {
      const set = passThrough.get(to) ?? new Set<string>(); set.add(addr); passThrough.set(to, set);
    }
  }
  const hotWalletCandidates = [...passThrough.entries()]
    .filter(([, s]) => s.size >= 5)
    .map(([addr, s]) => ({ address: addr, passThroughSenders: s.size }))
    .sort((a, b) => b.passThroughSenders - a.passThroughSenders)
    .slice(0, 15);

  const totalSell = sum(() => true);
  return {
    window: { from: new Date(windowStart * 1000).toISOString(), to: new Date(windowEnd * 1000).toISOString() },
    totals: {
      sold: totalSell,
      dexBuys: { lingo: r0(dexBuyLingo), usd: r0(dexBuyUsd) },
      arbitrageLoopsOnDex: r0(arbLingo),
    },
    venues,
    byClass: [...byClass.entries()].map(([k, v]) => ({ class: k, lingo: r0(v.lingo), usd: r0(v.usd), sellers: v.sellers })).sort((a, b) => b.usd - a.usd),
    topSellers: rows.slice(0, 40),
    sellerCount: rows.length,
    daily: [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, ...v })),
    depositAddresses: Object.entries([...depositExchange.values()].reduce<Record<string, number>>((a, ex) => { a[ex] = (a[ex] ?? 0) + 1; return a; }, {})),
    hotWalletCandidates,
  };
}

// ─── Chain reads ─────────────────────────────────────────────────────────

interface RawLog { topics: string[]; data: string; blockNumber: string; blockTimestamp?: string; transactionHash: string; logIndex: string }
const budget = { left: MAX_REQUESTS, used: 0 };

async function rpc<T>(method: string, params: unknown[]): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (budget.left-- <= 0) return { ok: false, error: 'request budget exhausted' };
    budget.used++;
    try {
      const res = await fetch(ALCHEMY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      if (data.error) return { ok: false, error: JSON.stringify(data.error).slice(0, 200) };
      return { ok: true, result: data.result as T };
    } catch (e) { if (attempt === 3) return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' }; }
  }
  return { ok: false, error: 'retries exhausted' };
}

async function getAllLogs(filter: Record<string, unknown>, from: number, to: number): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const stack: Array<[number, number]> = [];
  for (let hi = to; hi >= from; hi -= INITIAL_CHUNK) stack.push([Math.max(from, hi - INITIAL_CHUNK + 1), hi]);
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    const r = await rpc<RawLog[]>('eth_getLogs', [{ ...filter, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]);
    if (!r.ok && r.error === 'request budget exhausted') throw new Error('Request budget exhausted');
    if (!r.ok || r.result.length >= LOG_PAGE_LIMIT) {
      if (lo === hi) throw new Error(`getLogs failed at ${lo}: ${r.ok ? 'page full' : r.error}`);
      const mid = Math.floor((lo + hi) / 2);
      stack.push([mid + 1, hi], [lo, mid]);
      continue;
    }
    out.push(...r.result);
  }
  return out;
}

async function ethDailyPrices(startTs: number, endTs: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let from = startTs; from <= endTs; from += 360 * DAY) {
    if (budget.left-- <= 0) break;
    budget.used++;
    try {
      const res = await fetch(HIST_PRICES_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'ETH', startTime: new Date(from * 1000).toISOString(), endTime: new Date(Math.min(endTs, from + 360 * DAY) * 1000).toISOString(), interval: '1d' }),
      });
      const json = await res.json();
      for (const d of json?.data ?? []) {
        const v = Number(d?.value); const t = Date.parse(d?.timestamp ?? '');
        if (Number.isFinite(v) && v > 0 && Number.isFinite(t)) out.set(Math.floor(t / 1000 / DAY), v);
      }
    } catch { /* forward-filled below */ }
  }
  return out;
}

const WEI = 10n ** 18n;
const toLingo = (w: bigint) => Number(w / WEI) + Number(w % WEI) / 1e18;
const int256 = (h: string) => { const v = BigInt('0x' + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const pw = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isAdmin = !!ADMIN_PASSWORD && pw === ADMIN_PASSWORD;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALCHEMY_API_KEY) return res.status(200).json({ error: 'ALCHEMY_API_KEY not set' });

  const days = Number(req.query.days ?? 30);
  if (![7, 14, 30, 60, 90].includes(days)) return res.status(400).json({ error: 'days must be 7, 14, 30, 60 or 90' });
  budget.left = MAX_REQUESTS; budget.used = 0;
  const t0 = Date.now();

  try {
    const head = await rpc<string>('eth_blockNumber', []);
    if (!head.ok) return res.status(200).json({ error: head.error });
    const headBlock = parseInt(head.result, 16);
    const headTs = Math.floor(Date.now() / 1000);
    const windowStart = headTs - days * DAY;
    const fromBlock = Math.max(0, headBlock - (days + LOOKBACK_DAYS + 1) * BLOCKS_PER_DAY);
    const tsOf = (l: RawLog) => l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : headTs - (headBlock - parseInt(l.blockNumber, 16)) * 2;

    const transferLogs = await getAllLogs({ address: LINGO, topics: [TRANSFER_TOPIC] }, fromBlock, headBlock);
    const v3Logs = await getAllLogs({ address: V3_POOL, topics: [V3_SWAP] }, fromBlock, headBlock);
    const v2Logs = await getAllLogs({ address: V2_PAIR, topics: [V2_SWAP] }, fromBlock, headBlock);
    const eth = await ethDailyPrices(windowStart - (LOOKBACK_DAYS + 1) * DAY, headTs);
    const ethDays = [...eth.keys()].sort((a, b) => a - b);
    const ethPriceAt = (d: number) => eth.get(d) ?? (ethDays.length ? eth.get(ethDays.filter(x => x <= d).pop() ?? ethDays[0]) ?? null : null);

    const transfers: Transfer[] = transferLogs.filter(l => l.topics.length >= 3).map(l => ({
      ts: tsOf(l), block: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16), tx: l.transactionHash,
      from: '0x' + l.topics[1].slice(26).toLowerCase(), to: '0x' + l.topics[2].slice(26).toLowerCase(),
      lingo: toLingo(BigInt(l.data)),
    }));
    const swaps: Swap[] = [
      ...v3Logs.filter(l => l.data.length >= 130).map(l => {
        const a0 = int256(l.data.slice(2, 66)), a1 = int256(l.data.slice(66, 130));   // token0 = WETH, token1 = LINGO
        return { ts: tsOf(l), tx: l.transactionHash, pool: 'v3' as const, lingoIntoPool: Number(a1) / 1e18, wethAbs: Math.abs(Number(a0)) / 1e18 };
      }),
      ...v2Logs.filter(l => l.data.length >= 258).map(l => {
        // Swap(amount0In, amount1In, amount0Out, amount1Out). token0 = WETH (0x4200… sorts first), token1 = LINGO.
        const d = l.data.slice(2); const [a0i, a1i, a0o, a1o] = [0, 64, 128, 192].map(o => Number(BigInt('0x' + d.slice(o, o + 64))) / 1e18);
        return { ts: tsOf(l), tx: l.transactionHash, pool: 'v2' as const, lingoIntoPool: a1i - a1o, wethAbs: a0i + a0o };
      }),
    ];

    const base = { transfers, swaps, ethPriceAt, windowStart, windowEnd: headTs + 1 };
    const first = analyze(base);
    // Second pass: all-time LINGO funding of the 30 biggest real sellers (one
    // alchemy_getAssetTransfers each), so project-funded wallets are labelled.
    const big = first.topSellers.filter(r => /^0x[0-9a-f]{40}$/.test(r.address) && !r.label).slice(0, 30);
    const allTime = new Map<string, Record<string, number>>();
    for (const r of big) {
      const got = await rpc<{ transfers: Array<{ from: string; value: number | null }> }>('alchemy_getAssetTransfers', [{
        toAddress: r.address, contractAddresses: [LINGO], category: ['erc20'], maxCount: '0x3e8', order: 'desc', excludeZeroValue: true,
      }]);
      if (!got.ok) continue;
      const mix: Record<string, number> = {};
      for (const t of got.result.transfers) {
        const e = entityOf(t.from.toLowerCase());
        const k = e ? (ORIGIN_OF_KIND[e.kind] ?? 'wallet') : 'wallet';
        mix[k] = (mix[k] ?? 0) + (t.value ?? 0);
      }
      allTime.set(r.address, Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, Math.round(v)])));
    }
    const report = analyze({ ...base, allTime });
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json({ days, ...report, requests: budget.used, transfersRead: transfers.length, swapsRead: swaps.length, elapsedMs: Date.now() - t0 });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error', requests: budget.used, elapsedMs: Date.now() - t0 });
  }
}
