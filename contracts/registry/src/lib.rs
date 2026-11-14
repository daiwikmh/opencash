use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue};

const MAX_ID: usize = 100;
const MAX_TX: usize = 200;

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum InvoiceStatus {
    Open,
    Pending,
    Paid,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub id: String,
    pub company: AccountId,
    pub amount: U128,
    pub details_hash: String,
    pub status: InvoiceStatus,
    pub created_at_ms: u64,
    pub paid_at_ms: Option<u64>,
    pub settle_tx: Option<String>,
    pub payer: Option<AccountId>,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn on_invoice_forwarded(&mut self, id: String, received: U128, excess: U128, previous: InvoiceStatus) -> U128;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    operator: AccountId,
    usdc: AccountId,
    invoices: LookupMap<String, Invoice>,
    by_company: LookupMap<AccountId, Vec<String>>,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

#[near]
impl Registry {
    #[init]
    pub fn new(operator: AccountId, usdc: AccountId) -> Self {
        Self { operator, usdc, invoices: LookupMap::new(b"i"), by_company: LookupMap::new(b"b") }
    }

    fn only_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "operator only");
    }

    pub fn create_invoice(&mut self, id: String, company: AccountId, amount: U128, details_hash: String) -> Invoice {
        self.only_operator();
        require!(id.len() <= MAX_ID && id.starts_with(&format!("{company}-")), "invoice id must start with the company account");
        require!(self.invoices.get(&id).is_none(), "invoice id already exists");
        require!(amount.0 > 0, "invoice total must be above zero");
        require!(is_sha256_hex(&details_hash), "details_hash must be a lowercase SHA-256 hex string");
        let invoice = Invoice {
            id: id.clone(),
            company: company.clone(),
            amount,
            details_hash,
            status: InvoiceStatus::Open,
            created_at_ms: now_ms(),
            paid_at_ms: None,
            settle_tx: None,
            payer: None,
        };
        self.by_company.entry(company).or_default().push(id.clone());
        self.invoices.insert(id.clone(), invoice.clone());
        env::log_str(&format!("invoice created: {id}"));
        invoice
    }

    pub fn attest_invoice(&mut self, id: String, status: InvoiceStatus, settle_tx: Option<String>) -> Invoice {
        self.only_operator();
        let invoice = self.invoices.get_mut(&id).expect("unknown invoice");
        require!(invoice.status != InvoiceStatus::Paid, "invoice already paid");
        if let Some(tx) = settle_tx {
            require!(!tx.is_empty() && tx.len() <= MAX_TX, "settle_tx is too long");
            invoice.settle_tx = Some(tx);
        }
        invoice.status = status;
        if status == InvoiceStatus::Paid {
            invoice.paid_at_ms = Some(now_ms());
        }
        env::log_str(&format!("invoice {id}: {status:?}"));
        invoice.clone()
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc {
            return PromiseOrValue::Value(amount);
        }
        let id = msg.trim().to_string();
        let Some(invoice) = self.invoices.get_mut(&id) else {
            return PromiseOrValue::Value(amount);
        };
        if !matches!(invoice.status, InvoiceStatus::Open | InvoiceStatus::Pending) || amount.0 < invoice.amount.0 {
            return PromiseOrValue::Value(amount);
        }
        let due = invoice.amount;
        let excess = U128(amount.0 - due.0);
        let previous = invoice.status;
        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at_ms = Some(now_ms());
        invoice.payer = Some(sender_id.clone());
        let company = invoice.company.clone();
        env::log_str(&format!("invoice {id} paid by {sender_id} from a NEAR wallet"));
        PromiseOrValue::Promise(
            ext_ft::ext(self.usdc.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(15))
                .ft_transfer(company, due, Some(format!("opencash invoice {id}")))
                .then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15)).on_invoice_forwarded(id, amount, excess, previous)),
        )
    }

    #[private]
    pub fn on_invoice_forwarded(
        &mut self,
        #[callback_result] forwarded: Result<(), PromiseError>,
        id: String,
        received: U128,
        excess: U128,
        previous: InvoiceStatus,
    ) -> U128 {
        self.settle_forward(forwarded.is_ok(), &id, received, excess, previous)
    }

    fn settle_forward(&mut self, forwarded: bool, id: &str, received: U128, excess: U128, previous: InvoiceStatus) -> U128 {
        if forwarded {
            return excess;
        }
        if let Some(invoice) = self.invoices.get_mut(id) {
            invoice.status = previous;
            invoice.paid_at_ms = None;
            invoice.payer = None;
        }
        env::log_str(&format!("invoice {id}: forwarding failed, payment returned to the payer"));
        received
    }

    pub fn record_settlement(&mut self, id: String, settle_tx: String) -> Invoice {
        self.only_operator();
        let invoice = self.invoices.get_mut(&id).expect("unknown invoice");
        require!(invoice.status == InvoiceStatus::Paid, "invoice is not paid");
        require!(invoice.settle_tx.is_none(), "settlement already recorded");
        require!(!settle_tx.is_empty() && settle_tx.len() <= MAX_TX, "settle_tx is too long");
        invoice.settle_tx = Some(settle_tx);
        invoice.clone()
    }

    pub fn get_usdc(&self) -> AccountId {
        self.usdc.clone()
    }

    pub fn get_operator(&self) -> AccountId {
        self.operator.clone()
    }

    pub fn get_invoice(&self, id: String) -> Option<Invoice> {
        self.invoices.get(&id).cloned()
    }

    pub fn list_invoices(&self, account_id: AccountId, from: Option<u32>, limit: Option<u32>) -> Vec<Invoice> {
        let Some(ids) = self.by_company.get(&account_id) else { return Vec::new() };
        ids.iter()
            .rev()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|id| self.invoices.get(id).cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const USDC: &str = "usdc.near";
    const HASH: &str = "4f8b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

    fn as_caller(id: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(id.parse().unwrap()).block_timestamp(1_700_000_000_000_000_000).build());
    }

    fn registry() -> Registry {
        as_caller("opencash.near");
        Registry::new("opencash.near".parse().unwrap(), USDC.parse().unwrap())
    }

    fn issue(r: &mut Registry, id: &str, company: &str, amount: u128) -> Invoice {
        as_caller("opencash.near");
        r.create_invoice(id.into(), company.parse().unwrap(), U128(amount), HASH.into())
    }

    fn refunded(result: PromiseOrValue<U128>) -> Option<u128> {
        match result {
            PromiseOrValue::Value(v) => Some(v.0),
            PromiseOrValue::Promise(_) => None,
        }
    }

    #[test]
    fn operator_issues_a_slim_record_with_a_details_hash() {
        let mut r = registry();
        let inv = issue(&mut r, "acmestudio.near-1", "acmestudio.near", 100_000_000);
        assert_eq!(inv.status, InvoiceStatus::Open);
        assert_eq!(inv.details_hash, HASH);
        assert_eq!(r.list_invoices("acmestudio.near".parse().unwrap(), None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "operator only")]
    fn businesses_cannot_write_records_themselves() {
        let mut r = registry();
        as_caller("acmestudio.near");
        r.create_invoice("acmestudio.near-1".into(), "acmestudio.near".parse().unwrap(), U128(1), HASH.into());
    }

    #[test]
    #[should_panic(expected = "must start with the company account")]
    fn ids_belong_to_their_company() {
        let mut r = registry();
        issue(&mut r, "other.near-1", "acmestudio.near", 1);
    }

    #[test]
    #[should_panic(expected = "already exists")]
    fn ids_are_never_overwritten() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 10);
        issue(&mut r, "ada.near-1", "ada.near", 99);
    }

    #[test]
    #[should_panic(expected = "SHA-256")]
    fn details_hash_is_checked() {
        let mut r = registry();
        as_caller("opencash.near");
        r.create_invoice("ada.near-1".into(), "ada.near".parse().unwrap(), U128(1), "not-a-hash".into());
    }

    #[test]
    #[should_panic(expected = "above zero")]
    fn zero_invoices_are_refused() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 0);
    }

    #[test]
    fn same_first_name_businesses_keep_separate_records() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 10);
        issue(&mut r, "ada.business.near-1", "ada.business.near", 20);
        assert_eq!(r.get_invoice("ada.near-1".into()).unwrap().amount, U128(10));
        assert_eq!(r.get_invoice("ada.business.near-1".into()).unwrap().amount, U128(20));
    }

    #[test]
    fn attestations_move_status_and_paid_is_final() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 10);
        as_caller("opencash.near");
        assert_eq!(r.attest_invoice("ada.near-1".into(), InvoiceStatus::Pending, None).status, InvoiceStatus::Pending);
        assert_eq!(r.attest_invoice("ada.near-1".into(), InvoiceStatus::Open, None).status, InvoiceStatus::Open);
        let paid = r.attest_invoice("ada.near-1".into(), InvoiceStatus::Paid, Some("TxHash".into()));
        assert_eq!(paid.settle_tx.as_deref(), Some("TxHash"));
        assert!(paid.paid_at_ms.is_some());
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn paid_cannot_be_changed() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 10);
        as_caller("opencash.near");
        r.attest_invoice("ada.near-1".into(), InvoiceStatus::Paid, None);
        r.attest_invoice("ada.near-1".into(), InvoiceStatus::Refunded, None);
    }

    #[test]
    #[should_panic(expected = "operator only")]
    fn businesses_cannot_mark_paid() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 10);
        as_caller("ada.near");
        r.attest_invoice("ada.near-1".into(), InvoiceStatus::Paid, None);
    }

    #[test]
    fn wallet_payment_marks_paid_and_forwards() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 100_000_000);
        as_caller(USDC);
        assert_eq!(refunded(r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), "ada.near-1".into())), None);
        let inv = r.get_invoice("ada.near-1".into()).unwrap();
        assert_eq!(inv.status, InvoiceStatus::Paid);
        assert_eq!(inv.payer.unwrap().as_str(), "payer.near");
    }

    #[test]
    fn wallet_payment_refuses_wrong_token_short_amount_unknown_and_paid() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 100_000_000);
        as_caller("fake-usdc.near");
        assert_eq!(refunded(r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), "ada.near-1".into())), Some(100_000_000));
        as_caller(USDC);
        assert_eq!(refunded(r.ft_on_transfer("payer.near".parse().unwrap(), U128(99_999_999), "ada.near-1".into())), Some(99_999_999));
        assert_eq!(refunded(r.ft_on_transfer("payer.near".parse().unwrap(), U128(5), "nope-1".into())), Some(5));
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), "ada.near-1".into());
        assert_eq!(refunded(r.ft_on_transfer("second.near".parse().unwrap(), U128(100_000_000), "ada.near-1".into())), Some(100_000_000));
    }

    #[test]
    fn overpayment_returns_the_excess_after_forwarding() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 100_000_000);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(130_000_000), "ada.near-1".into());
        assert_eq!(r.settle_forward(true, "ada.near-1", U128(130_000_000), U128(30_000_000), InvoiceStatus::Open).0, 30_000_000);
        assert_eq!(r.get_invoice("ada.near-1".into()).unwrap().status, InvoiceStatus::Paid);
    }

    #[test]
    fn failed_forward_reverts_invoice_and_refunds_everything() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 100_000_000);
        as_caller("opencash.near");
        r.attest_invoice("ada.near-1".into(), InvoiceStatus::Pending, None);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), "ada.near-1".into());
        assert_eq!(r.settle_forward(false, "ada.near-1", U128(100_000_000), U128(0), InvoiceStatus::Pending).0, 100_000_000);
        let inv = r.get_invoice("ada.near-1".into()).unwrap();
        assert_eq!(inv.status, InvoiceStatus::Pending);
        assert!(inv.payer.is_none() && inv.paid_at_ms.is_none());
    }

    #[test]
    fn settlement_tx_is_recorded_once() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 100_000_000);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), "ada.near-1".into());
        as_caller("opencash.near");
        assert_eq!(r.record_settlement("ada.near-1".into(), "TxHash".into()).settle_tx.as_deref(), Some("TxHash"));
    }

    #[test]
    #[should_panic(expected = "settlement already recorded")]
    fn settlement_tx_cannot_be_overwritten() {
        let mut r = registry();
        issue(&mut r, "ada.near-1", "ada.near", 100_000_000);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), "ada.near-1".into());
        as_caller("opencash.near");
        r.record_settlement("ada.near-1".into(), "TxHash".into());
        r.record_settlement("ada.near-1".into(), "Other".into());
    }
}
