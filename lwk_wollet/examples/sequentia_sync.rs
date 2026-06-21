//! SEQUENTIA: end-to-end watch-only sync against the live Sequentia explorer.
//!
//! Proves the full path: connect to the Sequentia esplora, fetch the (anchored)
//! tip header, scan the descriptor's history, and compute a balance — using the
//! vendored rust-elements `sequentia` serialization.
//!
//!   cargo run -p lwk_wollet --example sequentia_sync
use std::str::FromStr;

use lwk_wollet::blocking::{BlockchainBackend, EsploraClient};
use lwk_wollet::{Network, WolletBuilder, WolletDescriptor};

const ESPLORA_URL: &str = "http://159.195.15.140/api";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let network = Network::sequentia_testnet();

    // A watch-only CT descriptor. No funds are expected on it — the point is to
    // exercise the sync path against real Sequentia data (anchored headers).
    let desc = WolletDescriptor::from_str(
        "ct(slip77(ab5824f4477b4ebb00a132adfd8eb0b7935cf24f6ac151add5d1913db374ce92),\
         elwpkh([759db348/84'/1'/0']tpubDCRMaF33e44pcJj534LXVhFbHibPbJ5vuLhSSPFAw57kYURv4tzXFL6LSnd78bkjqdmE3USedkbpXJUPA1tdzKfuYSL7PianceqAhwL2UkA/<0;1>/*))#cch6wrnp",
    )?;

    let mut wollet = WolletBuilder::new(network, desc).build()?;
    let mut client = EsploraClient::new(ESPLORA_URL, network)?;

    println!("network: {}", network.as_str());
    println!("policy asset (tSEQ): {}", network.policy_asset());
    println!("syncing against {ESPLORA_URL} ...");

    let update = client.full_scan(&wollet)?;
    if let Some(update) = update {
        wollet.apply_update(update)?;
    }

    let tip = wollet.tip();
    println!("tip: height={} hash={}", tip.height(), tip.hash());
    println!("balance: {:?}", wollet.balance()?);
    println!("OK — synced a Sequentia watch-only wallet end to end.");
    Ok(())
}
