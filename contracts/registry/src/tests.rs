//! Unit tests (near-sdk mocked blockchain).
use crate::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, CurveType, NearToken, PublicKey};

const T0: u64 = 1_800_000_000_000_000_000;
const HASH_A: &str = "FLVmyFmHJurb5da3eT9de3to5Vw1mydzcbuB2goichKK";
const HASH_B: &str = "Dka7UhGkFnR1EdFgfVMD9VbmTWHNxv48XTbmaf81drRJ";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn issuer() -> AccountId {
    acc("payroll.near")
}
fn ed(seed: u8) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![seed; 32]).unwrap()
}
fn ctx(pred: &AccountId, deposit: NearToken, now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("registry.near"))
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred.clone())
        .attached_deposit(deposit)
        .block_timestamp(now)
        .account_balance(NearToken::from_near(10));
    testing_env!(b.build());
}
fn hash(s: &str) -> Base58CryptoHash {
    s.parse().unwrap()
}
const ENOUGH: NearToken = NearToken::from_millinear(100);

fn with_keys(mldsa: Option<Vec<u8>>) -> Registry {
    ctx(&issuer(), ENOUGH, T0);
    let mut r = Registry::new();
    assert_eq!(r.set_keys(ed(7), mldsa.map(Base64VecU8)), 1);
    r
}

#[test]
fn anchors_a_receipt_with_the_issuers_current_keys() {
    let mut r = with_keys(None);
    ctx(&issuer(), ENOUGH, T0 + 5);
    r.anchor("nov-payroll".into(), hash(HASH_A));
    let logs = get_logs();
    assert!(logs
        .iter()
        .any(|l| l.contains("\"event\":\"receipt_anchored\"")
            && l.contains("\"receipt_id\":\"nov-payroll\"")
            && l.contains(HASH_A)));
    let v = r.get_receipt(issuer(), "nov-payroll".into()).unwrap();
    assert_eq!(v.receipt_hash, HASH_A);
    assert_eq!(v.key_version, 1);
    assert_eq!(v.receipt_pk, String::from(&ed(7)));
    assert!(v.mldsa65_pk.is_none());
    assert_eq!(v.anchored_at_ns.0, T0 + 5);
    assert!(r.get_receipt(issuer(), "other".into()).is_none());
    assert!(r
        .get_receipt(acc("someone.near"), "nov-payroll".into())
        .is_none());
}

#[test]
fn keeps_the_key_version_a_receipt_was_anchored_under() {
    let mut r = with_keys(None);
    ctx(&issuer(), ENOUGH, T0);
    r.anchor("one".into(), hash(HASH_A));
    ctx(&issuer(), ENOUGH, T0);
    assert_eq!(r.set_keys(ed(8), None), 2);
    ctx(&issuer(), ENOUGH, T0);
    r.anchor("two".into(), hash(HASH_B));
    assert_eq!(
        r.get_receipt(issuer(), "one".into()).unwrap().receipt_pk,
        String::from(&ed(7))
    );
    assert_eq!(
        r.get_receipt(issuer(), "two".into()).unwrap().receipt_pk,
        String::from(&ed(8))
    );
    assert_eq!(r.get_keys(issuer(), None).unwrap().version, 2);
    assert_eq!(
        r.get_keys(issuer(), Some(1)).unwrap().receipt_pk,
        String::from(&ed(7))
    );
    assert!(r.get_keys(issuer(), Some(3)).is_none());
}

#[test]
fn stores_a_post_quantum_key_beside_the_ed25519_key() {
    let pq = vec![9u8; MLDSA65_PK_LEN];
    let mut r = with_keys(Some(pq.clone()));
    ctx(&issuer(), ENOUGH, T0);
    r.anchor("pq".into(), hash(HASH_A));
    assert_eq!(
        r.get_receipt(issuer(), "pq".into())
            .unwrap()
            .mldsa65_pk
            .unwrap()
            .0,
        pq
    );
}

#[test]
#[should_panic(expected = "bad_mldsa65_key_length")]
fn rejects_a_post_quantum_key_of_the_wrong_length() {
    with_keys(Some(vec![1u8; 100]));
}

#[test]
#[should_panic(expected = "ed25519 key required")]
fn rejects_a_non_ed25519_receipt_key() {
    ctx(&issuer(), ENOUGH, T0);
    let mut r = Registry::new();
    r.set_keys(
        PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap(),
        None,
    );
}

#[test]
#[should_panic(expected = "no_keys")]
fn an_issuer_without_keys_cannot_anchor() {
    ctx(&issuer(), ENOUGH, T0);
    let mut r = Registry::new();
    r.anchor("x".into(), hash(HASH_A));
}

#[test]
#[should_panic(expected = "already_anchored")]
fn an_anchored_receipt_cannot_be_replaced() {
    let mut r = with_keys(None);
    ctx(&issuer(), ENOUGH, T0);
    r.anchor("x".into(), hash(HASH_A));
    ctx(&issuer(), ENOUGH, T0);
    r.anchor("x".into(), hash(HASH_B));
}

#[test]
fn two_issuers_can_use_the_same_receipt_id() {
    let mut r = with_keys(None);
    ctx(&issuer(), ENOUGH, T0);
    r.anchor("x".into(), hash(HASH_A));
    let other = acc("grants.near");
    ctx(&other, ENOUGH, T0);
    r.set_keys(ed(3), None);
    ctx(&other, ENOUGH, T0);
    r.anchor("x".into(), hash(HASH_B));
    assert_eq!(
        r.get_receipt(other, "x".into()).unwrap().receipt_hash,
        HASH_B
    );
    assert_eq!(
        r.get_receipt(issuer(), "x".into()).unwrap().receipt_hash,
        HASH_A
    );
}

#[test]
fn rejects_bad_receipt_ids() {
    let mut r = with_keys(None);
    for bad in [
        "",
        "has space",
        "slash/no",
        &"a".repeat(MAX_RECEIPT_ID_LEN + 1),
    ] {
        ctx(&issuer(), ENOUGH, T0);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            r.anchor(bad.to_string(), hash(HASH_A))
        }));
        assert!(res.is_err(), "accepted {bad:?}");
    }
}

#[test]
#[should_panic(expected = "storage_deposit_required")]
fn the_caller_pays_for_the_storage_it_adds() {
    let mut r = with_keys(None);
    ctx(&issuer(), NearToken::from_yoctonear(0), T0);
    r.anchor("x".into(), hash(HASH_A));
}

fn anchored() -> Registry {
    let mut r = with_keys(None);
    ctx(&issuer(), ENOUGH, T0);
    r.anchor("nov-payroll".into(), hash(HASH_A));
    r
}
fn attest_as(r: &mut Registry, who: &str, now: u64) {
    ctx(&acc(who), ENOUGH, now);
    r.attest(issuer(), "nov-payroll".into(), hash(HASH_A));
}

#[test]
fn attests_in_order_and_logs_the_event() {
    let mut r = anchored();
    assert!(r
        .get_attestations(issuer(), "nov-payroll".into())
        .is_empty());
    attest_as(&mut r, "auditor.near", T0 + 10);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"receipt_attested\"")
            && l.contains("\"attester\":\"auditor.near\"")
            && l.contains("\"receipt_id\":\"nov-payroll\"")));
    attest_as(&mut r, "dao-member.near", T0 + 20);
    let v = r.get_attestations(issuer(), "nov-payroll".into());
    assert_eq!(v.len(), 2);
    assert_eq!(v[0].attester, acc("auditor.near"));
    assert_eq!(v[0].attested_at_ns.0, T0 + 10);
    assert_eq!(v[1].attester, acc("dao-member.near"));
    assert!(r.get_attestations(issuer(), "other".into()).is_empty());
}

#[test]
#[should_panic(expected = "not_anchored")]
fn cannot_attest_an_unanchored_receipt() {
    let mut r = anchored();
    ctx(&acc("auditor.near"), ENOUGH, T0);
    r.attest(issuer(), "nope".into(), hash(HASH_A));
}

#[test]
#[should_panic(expected = "hash_mismatch")]
fn cannot_attest_a_different_hash() {
    let mut r = anchored();
    ctx(&acc("auditor.near"), ENOUGH, T0);
    r.attest(issuer(), "nov-payroll".into(), hash(HASH_B));
}

#[test]
#[should_panic(expected = "already_attested")]
fn cannot_attest_twice() {
    let mut r = anchored();
    attest_as(&mut r, "auditor.near", T0);
    attest_as(&mut r, "auditor.near", T0 + 1);
}

#[test]
#[should_panic(expected = "too_many_attestations")]
fn caps_attestations_at_one_hundred() {
    let mut r = anchored();
    for i in 0..MAX_ATTESTATIONS {
        attest_as(&mut r, &format!("a{i}.near"), T0 + i as u64);
    }
    assert_eq!(
        r.get_attestations(issuer(), "nov-payroll".into()).len(),
        MAX_ATTESTATIONS
    );
    attest_as(&mut r, "one-too-many.near", T0 + 1000);
}

#[test]
#[should_panic(expected = "storage_deposit_required")]
fn the_attester_pays_for_the_storage_it_adds() {
    let mut r = anchored();
    ctx(&acc("auditor.near"), NearToken::from_yoctonear(0), T0);
    r.attest(issuer(), "nov-payroll".into(), hash(HASH_A));
}

#[test]
fn refunds_the_unused_attest_deposit() {
    let mut r = anchored();
    ctx(&acc("auditor.near"), ENOUGH, T0);
    r.attest(issuer(), "nov-payroll".into(), hash(HASH_A));
    let refund: u128 = near_sdk::test_utils::get_created_receipts()
        .iter()
        .flat_map(|rc| rc.actions.iter())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .sum();
    assert!(refund > 0 && refund < ENOUGH.as_yoctonear());
}
