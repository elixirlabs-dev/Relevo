//! Elivo receipt registry: an issuer (a grant programme, a payroll platform, a payout provider)
//! publishes its receipt keys and anchors the hash of each receipt it signs for payouts made outside
//! the escrow, on any rail. Testnet prototype. Contract unaudited.
//!
//! - Keys are versioned per issuer. Each anchor records the key version in force, so rotating keys
//!   never changes how an older receipt verifies.
//! - An issuer can add an ML-DSA-65 (FIPS 204) public key beside its ed25519 key; receipts it signs
//!   then carry both signatures.
//! - An anchor can't be replaced. The caller pays for the storage it adds; the rest is refunded.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CurveType, NearToken, PanicOnDefault, Promise,
    PublicKey,
};

pub const MLDSA65_PK_LEN: usize = 1952;
pub const MAX_RECEIPT_ID_LEN: usize = 64;

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct KeySet {
    pub ed25519: [u8; 32],
    pub mldsa65: Option<Vec<u8>>,
    pub set_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Anchor {
    pub receipt_hash: [u8; 32],
    pub key_version: u32,
    pub anchored_at_ns: u64,
}

#[near(serializers = [json])]
pub struct KeySetView {
    pub version: u32,
    pub receipt_pk: String,
    pub mldsa65_pk: Option<Base64VecU8>,
    pub set_at_ns: U64,
}

#[near(serializers = [json])]
pub struct AnchorView {
    pub issuer: AccountId,
    pub receipt_id: String,
    /// base58(sha256(canonical JSON of the signed receipt))
    pub receipt_hash: String,
    pub key_version: u32,
    pub receipt_pk: String,
    pub mldsa65_pk: Option<Base64VecU8>,
    pub anchored_at_ns: U64,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    KeyCount,
    Keys,
    Anchors,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    key_count: LookupMap<AccountId, u32>,
    keys: LookupMap<(AccountId, u32), KeySet>,
    anchors: LookupMap<(AccountId, String), Anchor>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let body =
        json!({ "standard": "elivo-registry", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

fn valid_receipt_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_RECEIPT_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

#[near]
impl Registry {
    #[init]
    pub fn new() -> Self {
        Self {
            key_count: LookupMap::new(StorageKey::KeyCount),
            keys: LookupMap::new(StorageKey::Keys),
            anchors: LookupMap::new(StorageKey::Anchors),
        }
    }

    /// Publishes a new key version for the caller and returns its number (versions start at 1).
    #[payable]
    pub fn set_keys(&mut self, receipt_pk: PublicKey, mldsa65_pk: Option<Base64VecU8>) -> u32 {
        let before = env::storage_usage();
        require!(
            receipt_pk.curve_type() == CurveType::ED25519,
            "ed25519 key required"
        );
        if let Some(k) = &mldsa65_pk {
            require!(k.0.len() == MLDSA65_PK_LEN, "bad_mldsa65_key_length");
        }
        let issuer = env::predecessor_account_id();
        let version = self.key_count.get(&issuer).copied().unwrap_or(0) + 1;
        let ed25519: [u8; 32] = receipt_pk.as_bytes()[1..].try_into().expect("ed25519 key");
        let has_mldsa65 = mldsa65_pk.is_some();
        self.keys.insert(
            (issuer.clone(), version),
            KeySet {
                ed25519,
                mldsa65: mldsa65_pk.map(|k| k.0),
                set_at_ns: env::block_timestamp(),
            },
        );
        self.key_count.insert(issuer.clone(), version);
        emit(
            "keys_set",
            json!({ "issuer": issuer, "version": version,
                    "receipt_pk": String::from(&receipt_pk), "mldsa65": has_mldsa65 }),
        );
        self.settle_storage(before);
        version
    }

    /// Anchors the hash of a receipt the caller signed with its current keys.
    #[payable]
    pub fn anchor(&mut self, receipt_id: String, receipt_hash: Base58CryptoHash) {
        let before = env::storage_usage();
        require!(valid_receipt_id(&receipt_id), "bad_receipt_id");
        let issuer = env::predecessor_account_id();
        let key_version = match self.key_count.get(&issuer) {
            Some(v) => *v,
            None => env::panic_str("no_keys"),
        };
        let key = (issuer.clone(), receipt_id.clone());
        require!(!self.anchors.contains_key(&key), "already_anchored");
        let hash: [u8; 32] = receipt_hash.into();
        self.anchors.insert(
            key,
            Anchor {
                receipt_hash: hash,
                key_version,
                anchored_at_ns: env::block_timestamp(),
            },
        );
        emit(
            "receipt_anchored",
            json!({ "issuer": issuer, "receipt_id": receipt_id, "key_version": key_version,
                    "receipt_hash": near_sdk::bs58::encode(hash).into_string() }),
        );
        self.settle_storage(before);
    }

    /// The issuer's keys: the given version, or the current one.
    pub fn get_keys(&self, issuer: AccountId, version: Option<u32>) -> Option<KeySetView> {
        let v = match version {
            Some(v) => v,
            None => *self.key_count.get(&issuer)?,
        };
        self.keys.get(&(issuer, v)).map(|k| KeySetView {
            version: v,
            receipt_pk: ed25519_string(&k.ed25519),
            mldsa65_pk: k.mldsa65.clone().map(Base64VecU8),
            set_at_ns: U64(k.set_at_ns),
        })
    }

    /// An anchored receipt, with the keys that were in force when it was anchored.
    pub fn get_receipt(&self, issuer: AccountId, receipt_id: String) -> Option<AnchorView> {
        let a = self.anchors.get(&(issuer.clone(), receipt_id.clone()))?;
        let k = self.keys.get(&(issuer.clone(), a.key_version))?;
        Some(AnchorView {
            issuer,
            receipt_id,
            receipt_hash: near_sdk::bs58::encode(a.receipt_hash).into_string(),
            key_version: a.key_version,
            receipt_pk: ed25519_string(&k.ed25519),
            mldsa65_pk: k.mldsa65.clone().map(Base64VecU8),
            anchored_at_ns: U64(a.anchored_at_ns),
        })
    }
}

fn ed25519_string(bytes: &[u8; 32]) -> String {
    String::from(&PublicKey::from_parts(CurveType::ED25519, bytes.to_vec()).expect("ed25519"))
}

impl Registry {
    /// Charges the caller for the bytes this call added and refunds the rest of the deposit.
    fn settle_storage(&mut self, before: u64) {
        self.key_count.flush();
        self.keys.flush();
        self.anchors.flush();
        let added = env::storage_usage().saturating_sub(before) as u128;
        let cost = added * env::storage_byte_cost().as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        if attached < cost {
            env::panic_str(&format!("storage_deposit_required: {cost} yoctoNEAR"));
        }
        if attached > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
    }
}

#[cfg(test)]
mod tests;
