use std::str::FromStr;

use bech32::Hrp;
use elements::hashes::{sha256, Hash};
use elements::{AddressParams, AssetId, BlockHash};
use serde::{Deserialize, Deserializer, Serialize};

use crate::Error;

/// SEQUENTIA: address parameters for the Sequentia testnet (`chain=test`).
/// base58 p2pkh 111 / p2sh 196 / blinded 70; bech32 `tb`; blech32 `tsqb`
/// (see Sequentia's chainparams.cpp). Built as a `const` like elements' own
/// `AddressParams::LIQUID_TESTNET`, so `address_params()` can return a
/// `&'static` reference.
pub const SEQUENTIA_TESTNET_ADDRESS_PARAMS: AddressParams = AddressParams {
    p2pkh_prefix: 111,
    p2sh_prefix: 196,
    blinded_prefix: 70,
    bech_hrp: Hrp::parse_unchecked("tb"),
    blech_hrp: Hrp::parse_unchecked("tsqb"),
};

const LIQUID_TESTNET_POLICY_ASSET: &AssetId = &AssetId::from_inner(sha256::Midstate([
    0x49, 0x9a, 0x81, 0x85, 0x45, 0xf6, 0xba, 0xe3, 0x9f, 0xc0, 0x3b, 0x63, 0x7f, 0x2a, 0x4e, 0x1e,
    0x64, 0xe5, 0x90, 0xca, 0xc1, 0xbc, 0x3a, 0x6f, 0x6d, 0x71, 0xaa, 0x44, 0x43, 0x65, 0x4c, 0x14,
]));

const LIQUID_REGTEST_POLICY_ASSET: &AssetId = &AssetId::from_inner(sha256::Midstate([
    0x25, 0xb2, 0x51, 0x07, 0x0e, 0x29, 0xca, 0x19, 0x04, 0x3c, 0xf3, 0x3c, 0xcd, 0x73, 0x24, 0xe2,
    0xdd, 0xab, 0x03, 0xec, 0xc4, 0xae, 0x0b, 0x5e, 0x77, 0xc4, 0xfc, 0x0e, 0x5c, 0xf6, 0xc9, 0x5a,
]));

// Note these are binary format, not display format which is reversed.
// Taken and adapted from jade network.c.
const GENESIS_LIQUID: [u8; 32] = [
    0x03, 0x60, 0x20, 0x8a, 0x88, 0x96, 0x92, 0x37, 0x2c, 0x8d, 0x68, 0xb0, 0x84, 0xa6, 0x2e, 0xfd,
    0xf6, 0x0e, 0xa1, 0xa3, 0x59, 0xa0, 0x4c, 0x94, 0xb2, 0x0d, 0x22, 0x36, 0x58, 0x27, 0x66, 0x14,
];
const GENESIS_LIQUID_TESTNET: [u8; 32] = [
    0xc1, 0xb1, 0x6a, 0xe2, 0x4f, 0x24, 0x23, 0xae, 0xa2, 0xea, 0x34, 0x55, 0x22, 0x92, 0x79, 0x3b,
    0x5b, 0x5e, 0x82, 0x99, 0x9a, 0x1e, 0xed, 0x81, 0xd5, 0x6a, 0xee, 0x52, 0x8e, 0xda, 0x71, 0xa7,
];
pub const GENESIS_LIQUID_REGTEST: [u8; 32] = [
    0x21, 0xca, 0xb1, 0xe5, 0xda, 0x47, 0x18, 0xea, 0x14, 0x0d, 0x97, 0x16, 0x93, 0x17, 0x02, 0x42,
    0x2f, 0x0e, 0x6a, 0xd9, 0x15, 0xc8, 0xd9, 0xb5, 0x83, 0xca, 0xc2, 0x70, 0x6b, 0x2a, 0x90, 0x00,
];

/// The builder for custom Elements network parameters
#[derive(Default)]
pub struct ElementsParamsBuilder {
    policy_asset: Option<AssetId>,
    genesis_hash: Option<BlockHash>,
    address_params: Option<&'static AddressParams>,
    name: Option<&'static str>,
}

impl ElementsParamsBuilder {
    /// Create builder for custom Elements network parameters
    pub fn new() -> Self {
        Self::default()
    }

    /// Specify policy asset.
    pub fn with_policy_asset(mut self, policy_asset: AssetId) -> Self {
        self.policy_asset = Some(policy_asset);
        self
    }

    /// Specify genesis hash.
    pub fn with_genesis_hash(mut self, genesis_hash: BlockHash) -> Self {
        self.genesis_hash = Some(genesis_hash);
        self
    }

    /// Specify the address parameters (base58/bech32/blech32 prefixes) used to
    /// derive addresses. Defaults to the generic Elements params.
    pub fn with_address_params(mut self, address_params: &'static AddressParams) -> Self {
        self.address_params = Some(address_params);
        self
    }

    /// Specify the short network name (e.g. "sequentia-testnet"). Defaults to
    /// "liquid-regtest" for generic custom networks.
    pub fn with_name(mut self, name: &'static str) -> Self {
        self.name = Some(name);
        self
    }

    /// Build Elements network parameters.
    ///
    /// Unspecified values would defined as default Liquid regtest parameters
    pub fn build(self) -> Result<ElementsParams, Error> {
        Ok(ElementsParams {
            policy_asset: self.policy_asset.unwrap_or(*LIQUID_REGTEST_POLICY_ASSET),
            genesis_hash: self
                .genesis_hash
                .unwrap_or(BlockHash::from_byte_array(GENESIS_LIQUID_REGTEST)),
            address_params: self.address_params.unwrap_or(&AddressParams::ELEMENTS),
            name: self.name.unwrap_or("liquid-regtest"),
        })
    }
}

/// Paramaters for custom Elements network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ElementsParams {
    policy_asset: AssetId,
    genesis_hash: BlockHash,
    /// Address parameters used to derive addresses for this network.
    address_params: &'static AddressParams,
    /// Short network name (e.g. "sequentia-testnet").
    name: &'static str,
}

/// The network of the elements blockchain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    /// Liquid mainnet
    Liquid,
    /// Liquid testnet
    TestnetLiquid,
    /// Elements network with custom parameters
    CustomElements(ElementsParams),
}

impl Network {
    /// Return true if the network is mainnet.
    pub fn is_mainnet(&self) -> bool {
        self == &Self::Liquid
    }

    /// Return the policy asset for this network.
    pub fn policy_asset(&self) -> &AssetId {
        match self {
            Network::Liquid => &AssetId::LIQUID_BTC,
            Network::TestnetLiquid => LIQUID_TESTNET_POLICY_ASSET,
            Network::CustomElements(params) => &params.policy_asset,
        }
    }

    /// Return the genesis block hash for this network.
    pub fn genesis_hash(&self) -> BlockHash {
        match self {
            Network::Liquid => BlockHash::from_byte_array(GENESIS_LIQUID),
            Network::TestnetLiquid => BlockHash::from_byte_array(GENESIS_LIQUID_TESTNET),
            Network::CustomElements(params) => params.genesis_hash,
        }
    }

    /// Return the address parameters for this network to generate addresses compatible for this network.
    pub fn address_params(&self) -> &'static AddressParams {
        match self {
            Network::Liquid => &AddressParams::LIQUID,
            Network::TestnetLiquid => &AddressParams::LIQUID_TESTNET,
            Network::CustomElements(params) => params.address_params,
        }
    }

    /// Return the Sequentia testnet (`chain=test`) network.
    ///
    /// Sequentia is an Elements chain, modelled here as a custom Elements
    /// network carrying Sequentia's policy (native) asset, genesis hash, and
    /// address parameters (base58 111/196/70, bech32 `tb`, blech32 `tsqb`).
    pub fn sequentia_testnet() -> Self {
        let policy_asset = AssetId::from_str(
            "c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40",
        )
        .expect("valid Sequentia policy asset id");
        let genesis_hash = BlockHash::from_str(
            "c2a0a99b4c307e8423b98140af1f539aa4e1feec25c62d655d91d8df51c7dfba",
        )
        .expect("valid Sequentia genesis hash");
        Network::CustomElements(
            ElementsParamsBuilder::new()
                .with_policy_asset(policy_asset)
                .with_genesis_hash(genesis_hash)
                .with_address_params(&SEQUENTIA_TESTNET_ADDRESS_PARAMS)
                .with_name("sequentia-testnet")
                .build()
                .expect("valid Sequentia params"),
        )
    }

    /// Return Elements network with default parameters
    pub fn default_regtest() -> Self {
        Network::CustomElements(
            ElementsParamsBuilder::new()
                .build()
                .expect("default parameters"),
        )
    }

    /// Return the string representation of this network.
    pub fn as_str(&self) -> &'static str {
        match self {
            Network::Liquid => "liquid",
            Network::TestnetLiquid => "liquid-testnet",
            Network::CustomElements(params) => params.name,
        }
    }

    /// Return the dynamic epoch length of this network
    pub fn dynamic_epoch_length(&self) -> u32 {
        // taken from elements chainparams.cpp
        // TODO upstream to rust elements
        match self {
            Network::Liquid => 20160,
            Network::TestnetLiquid => 1000,
            Network::CustomElements(_) => 10,
        }
    }

    /// Return the dynamic epoch length of this network
    pub fn total_valid_epochs(&self) -> u32 {
        // taken from elements chainparams.cpp
        // TODO upstream to rust elements
        match self {
            Network::Liquid => 2,
            Network::TestnetLiquid => 0,
            Network::CustomElements(_) => 0,
        }
    }
}

impl std::fmt::Display for Network {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Network::Liquid => write!(f, "liquid"),
            Network::TestnetLiquid => write!(f, "testnet-liquid"),
            Network::CustomElements(params) => write!(f, "{}", params.name),
        }
    }
}

impl FromStr for Network {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "liquid" => Ok(Network::Liquid),
            "testnet-liquid" => Ok(Network::TestnetLiquid),
            "localtest-liquid" | "liquid-regtest" => Ok(Network::default_regtest()),
            "sequentia-testnet" => Ok(Network::sequentia_testnet()),
            _ => Err(
                "invalid network, possible value are: 'liquid', 'testnet-liquid', 'localtest-liquid', 'sequentia-testnet'"
                    .to_string(),
            ),
        }
    }
}

impl Serialize for Network {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Network {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let string = String::deserialize(d)?;
        string.parse().map_err(serde::de::Error::custom)
    }
}

// A custom implementation of `Hash` is used here because we want the same
// hash values as in the old `lwk_wollet::ElementsNetwork`.
impl core::hash::Hash for Network {
    fn hash<H: core::hash::Hasher>(&self, state: &mut H) {
        core::mem::discriminant(self).hash(state);
        if let Network::CustomElements(params) = self {
            params.policy_asset.hash(state);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::hash_map::DefaultHasher,
        hash::{Hash, Hasher},
    };

    use super::*;

    #[test]
    fn sequentia_testnet_network() {
        let n = Network::sequentia_testnet();
        // policy (native) asset + genesis match the Sequentia testnet
        assert_eq!(
            n.policy_asset().to_string(),
            "c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40"
        );
        assert_eq!(
            n.genesis_hash().to_string(),
            "c2a0a99b4c307e8423b98140af1f539aa4e1feec25c62d655d91d8df51c7dfba"
        );
        // address params are Sequentia's, not the generic Elements defaults
        let p = n.address_params();
        assert_eq!(p.p2pkh_prefix, 111);
        assert_eq!(p.p2sh_prefix, 196);
        assert_eq!(p.blinded_prefix, 70);
        assert_eq!(p.bech_hrp.to_string(), "tb");
        assert_eq!(p.blech_hrp.to_string(), "tsqb");
        assert_ne!(p, &AddressParams::ELEMENTS);
        // identifies as sequentia-testnet (not liquid-regtest), and round-trips
        assert_eq!(n.as_str(), "sequentia-testnet");
        assert_eq!(n.to_string(), "sequentia-testnet");
        assert_eq!(Network::from_str("sequentia-testnet").unwrap(), n);
    }

    #[test]
    fn network_constants_regression() {
        // Policy asset display matches expected hex
        assert_eq!(
            Network::Liquid.policy_asset().to_string(),
            "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d"
        );
        assert_eq!(
            Network::TestnetLiquid.policy_asset().to_string(),
            "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49"
        );
        assert_eq!(
            Network::default_regtest().policy_asset().to_string(),
            "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225"
        );

        // Genesis block hash display (reversed hex) as seen on explorers/nodes
        // Took from: https://github.com/ElementsProject/elements/blob/6bb916a57fa8b677bd8060491ea7ab28b77794ff/src/chainparams.cpp#L1323
        assert_eq!(
            Network::Liquid.genesis_hash().to_string(),
            "1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003"
        );
        assert_eq!(
            Network::TestnetLiquid.genesis_hash().to_string(),
            "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1"
        );
        assert_eq!(
            Network::default_regtest().genesis_hash().to_string(),
            "00902a6b70c2ca83b5d9c815d96a0e2f4202179316970d14ea1847dae5b1ca21"
        );
    }

    #[test]
    fn test_hash_regression() {
        #[derive(Hash)]
        pub enum ElementsNetwork {
            Liquid,
            LiquidTestnet,
            ElementsRegtest { policy_asset: AssetId },
        }

        impl ElementsNetwork {
            fn default_regtest() -> Self {
                Self::ElementsRegtest {
                    policy_asset: *LIQUID_REGTEST_POLICY_ASSET,
                }
            }
        }

        // Mainnet hash
        let mut hasher = DefaultHasher::new();
        let network = Network::Liquid;
        network.hash(&mut hasher);
        assert_eq!(13646096770106105413, hasher.finish());

        let mut hasher = DefaultHasher::new();
        let network = ElementsNetwork::Liquid;
        network.hash(&mut hasher);
        assert_eq!(13646096770106105413, hasher.finish());

        // Testnet hash
        let mut hasher = DefaultHasher::new();
        let network = Network::TestnetLiquid;
        network.hash(&mut hasher);
        assert_eq!(2206609067086327257, hasher.finish());

        let mut hasher = DefaultHasher::new();
        let network = ElementsNetwork::LiquidTestnet;
        network.hash(&mut hasher);
        assert_eq!(2206609067086327257, hasher.finish());

        // Default regtest hash
        let mut hasher = DefaultHasher::new();
        let network = Network::default_regtest();
        network.hash(&mut hasher);
        assert_eq!(16314752282728042941, hasher.finish());

        let mut hasher = DefaultHasher::new();
        let network = ElementsNetwork::default_regtest();
        network.hash(&mut hasher);
        assert_eq!(16314752282728042941, hasher.finish());
    }
}
