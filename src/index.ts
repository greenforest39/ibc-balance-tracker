import {appendFileSync, writeFileSync} from 'fs';
import {toHex, toUtf8, toBech32, fromBech32} from '@cosmjs/encoding';
import {sha256} from '@cosmjs/crypto';
import {StargateClient, Coin} from '@cosmjs/stargate';

const chainNameToIdMap: {[key: string]: string} = {
  neutron: 'neutron-1',
  osmosis: 'osmosis-1',
  terra: 'phoenix-1',
  stargaze: 'stargaze-1',
  cosmoshub: 'cosmoshub-4',
  stride: 'stride-1',
};

type ChainName = keyof typeof chainNameToIdMap;

const chainNames = Object.keys(chainNameToIdMap);

const RpcUrls: {[key: ChainName]: string} = {
  neutron: 'https://neutron-rpc.publicnode.com:443',
  osmosis: 'https://rpc.osmosis.zone',
  terra: 'https://terra-rpc.publicnode.com:443',
  stargaze: 'https://stargaze-rpc.publicnode.com:443',
  cosmoshub: 'https://cosmos-rpc.publicnode.com:443',
  stride: 'https://stride-rpc.publicnode.com:443',
};

const chainPrefix: {[key: ChainName]: string} = {
  neutron: 'neutron',
  osmosis: 'osmo',
  terra: 'terra',
  stargaze: 'stars',
  cosmoshub: 'cosmos',
  stride: 'stride',
};

const IBCMap: {[key: string]: {[key: string]: string}} = {
  'neutron-1': {
    'osmosis-1': 'channel-10',
    'phoenix-1': 'channel-25',
    'stargaze-1': 'channel-18',
    'cosmoshub-4': 'channel-1',
    'stride-1': 'channel-8',
  },
  'osmosis-1': {
    'neutron-1': 'channel-874',
    'phoenix-1': 'channel-251',
    'stargaze-1': 'channel-75',
    'cosmoshub-4': 'channel-0',
    'stride-1': 'channel-326',
  },
  'phoenix-1': {
    'neutron-1': 'channel-229',
    'osmosis-1': 'channel-1',
    'stargaze-1': 'channel-324',
    'cosmoshub-4': 'channel-0',
    'stride-1': 'channel-46',
  },
  'stargaze-1': {
    'neutron-1': 'channel-191',
    'osmosis-1': 'channel-0',
    'phoenix-1': 'channel-266',
    'cosmoshub-4': 'channel-239',
    'stride-1': 'channel-106',
  },
  'cosmoshub-4': {
    'neutron-1': 'channel-569',
    'osmosis-1': 'channel-141',
    'phoenix-1': 'channel-339',
    'stargaze-1': 'channel-730',
    'stride-1': 'channel-391',
  },
  'stride-1': {
    'neutron-1': 'channel-123',
    'osmosis-1': 'channel-5',
    'phoenix-1': 'channel-52',
    'stargaze-1': 'channel-19',
    'cosmoshub-4': 'channel-0',
  },
};

type DenomTrace = {
  denom: string;
  trace: string;
};

type BalanceRecord = {
  denom: string;
  originDenom: string;
  balance: number;
  path: string[];
};

/**
 * Converts string to capitalized string.
 * @param {string} address - The lowercase string to convert.
 * @returns {string} - The capitalized string.
 */
function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Calculates sha256 for given string.
 * @param {string} s - The string to convert.
 * @returns {string} - The sha256(s) value.
 */
function hash(s: string): string {
  return toHex(sha256(toUtf8(s)));
}

/**
 * Converts a Bech32 address to another Bech32 address with a different prefix.
 * @param {string} address - The original Bech32 address.
 * @param {string} newPrefix - The new prefix for the Bech32 address.
 * @returns {string} - The new Bech32 address with the specified prefix.
 */
function convertAddressPrefix(address: string, newPrefix: string): string {
  if (newPrefix === 'terra') {
    return 'terra1w7mtx2g478kkhs6pgynpcjpt6aw4930q34j36v';
  }
  const {data} = fromBech32(address);
  return toBech32(newPrefix, data);
}

/**
 * Calculates denom on the destination chain after IBC transfer.
 * @param {ChainName} srcChain - The source chain name.
 * @param {ChainName} destChain - The destination chain name.
 * @param {DenomTrace} baseDenomTrace - DenomTrace info on the source chain.
 * @returns {DenomTrace} - The new DenomTrace on the destination chain.
 */
function getDenom(
  srcChain: ChainName,
  destChain: ChainName,
  baseDenomTrace: DenomTrace
): DenomTrace {
  const srcChainId = chainNameToIdMap[srcChain];
  const destChainId = chainNameToIdMap[destChain];
  const channelId = IBCMap[destChainId][srcChainId];
  const trace = `transfer/${channelId}/${baseDenomTrace.trace}`;
  return {
    denom: 'ibc/' + hash(trace).toUpperCase(),
    trace,
  };
}

/**
 * Gets all coin balances for account on the given chain.
 * @param {ChainName} chainName - The chain name.
 * @param {string} account - The account address.
 * @returns {readonly Coin[]} - The array of coin balances.
 */
async function getAllBalances(
  chainName: ChainName,
  account: string
): Promise<readonly Coin[]> {
  const rpc = RpcUrls[chainName];
  const client = await StargateClient.connect(rpc);
  return await client.getAllBalances(account);
}

/**
 * Tracks token balances of the user across several chains.
 * @param {string} denom - The original token denom.
 * @param {string} account - The account address.
 * @returns {Object} - Token balances mapping.
 */
async function trackBalances(
  denom: string,
  account: string
): Promise<{
  [key: ChainName]: BalanceRecord[];
}> {
  console.log(
    `Tracking ${denom} balances across neutron, osmosis, terra, stargaze, cosmos hub and stride for ${account}`
  );
  const allBalances: {
    [key: ChainName]: readonly Coin[];
  } = {};

  await Promise.all(
    chainNames.map(async chain => {
      allBalances[chain] = await getAllBalances(
        chain,
        convertAddressPrefix(account, chainPrefix[chain])
      );
    })
  );

  const balances: {
    [key: ChainName]: BalanceRecord[];
  } = {};

  const baseDenomTrace: DenomTrace = {
    denom,
    trace: denom,
  };

  const DFS = (path: string[], denomTrace: DenomTrace) => {
    const currentChain = path[path.length - 1];
    const balance = parseFloat(
      allBalances[currentChain].find(
        accountBalance => accountBalance.denom === denomTrace.denom
      )?.amount || '0'
    );
    if (balance && balance > 0) {
      if (!balances[currentChain]) {
        balances[currentChain] = [];
      }
      balances[currentChain].push({
        denom: denomTrace.denom,
        originDenom: denom,
        balance,
        path,
      });
    }

    chainNames.map(async chain => {
      if (!path.slice(1).includes(chain) && currentChain !== chain) {
        DFS([...path, chain], getDenom(currentChain, chain, denomTrace));
      }
    });
  };

  DFS(['neutron'], baseDenomTrace);

  console.log('Tracking finished!');

  return balances;
}

/**
 * Entry point
 * @param {string} account The account address
 */
async function main(account: string) {
  const FILE = 'output.txt';
  writeFileSync(FILE, '');

  const dAssetDenom =
    'factory/neutron1lzecpea0qxw5xae92xkm3vaddeszr278k7w20c/dAsset';
  const lAssetDenom =
    'factory/neutron1lzecpea0qxw5xae92xkm3vaddeszr278k7w20c/lAsset';
  const dAssetBalances = await trackBalances(dAssetDenom, account);
  const lAssetBalances = await trackBalances(lAssetDenom, account);
  const balances: {
    [key: ChainName]: BalanceRecord[];
  } = {};
  let dAssetTotal = 0;
  let lAssetTotal = 0;
  for (const chain of chainNames) {
    dAssetTotal += dAssetBalances[chain]
      ? dAssetBalances[chain].reduce((prev, cur) => prev + cur.balance, 0)
      : 0;
    lAssetTotal += lAssetBalances[chain]
      ? lAssetBalances[chain].reduce((prev, cur) => prev + cur.balance, 0)
      : 0;
    if (dAssetBalances[chain] && lAssetBalances[chain]) {
      balances[chain] = [...dAssetBalances[chain], ...lAssetBalances[chain]];
    } else if (dAssetBalances[chain]) {
      balances[chain] = dAssetBalances[chain];
    } else if (lAssetBalances[chain]) {
      balances[chain] = lAssetBalances[chain];
    }

    if (balances[chain]) {
      appendFileSync(FILE, capitalize(chain) + ':\n');
      for (const record of balances[chain]) {
        appendFileSync(
          FILE,
          `${record.denom}, ${record.originDenom}, ${record.balance}, [${record.path.join(', ')}]\n`
        );
      }
    }
  }

  appendFileSync(FILE, '\nTOTAL AMOUNTS:\n');
  appendFileSync(FILE, `${dAssetDenom}, ${dAssetTotal}\n`);
  appendFileSync(FILE, `${lAssetDenom}, ${lAssetTotal}\n`);

  console.log('Results exported to output.txt');
}

main('neutron1lzecpea0qxw5xae92xkm3vaddeszr278k7w20c');
