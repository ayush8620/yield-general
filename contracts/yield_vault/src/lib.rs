#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String,
};

/// Phase 1 uses a deterministic ledger-time simulation instead of a real
/// yield source. This must only be used for Stellar Testnet development.
pub const SIMULATED_YIELD: bool = true;
pub const SIM_APY_BPS: i128 = 800;
pub const BPS_DENOM: i128 = 10_000;
pub const SIM_YEAR: i128 = 31_536_000;
pub const PRICE_SCALE: i128 = 1_000_000_000_000_000_000;
pub const MAX_DECIMALS: u32 = 18;

const YIELD_DENOM: i128 = BPS_DENOM * SIM_YEAR;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    AlreadyInit = 1,
    NotInit = 2,
    BadAdmin = 3,
    BadAsset = 4,
    BadName = 5,
    BadSymbol = 6,
    BadDecimal = 7,
    BadAmount = 8,
    NoShares = 9,
    NoLiquidity = 10,
    NoAssets = 11,
    ZeroShares = 12,
    Overflow = 13,
    Paused = 14,
    NotPaused = 15,
    RoundEmpty = 16,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    pub asset: Address,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    /// Always true in Phase 1; this is not real T-Bill/RWA yield.
    pub simulation: bool,
}

#[contracttype]
#[derive(Clone)]
struct Accounting {
    principal: i128,
    accrued: i128,
    rem: i128,
    shares: i128,
    last_ts: u64,
    paused: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct VaultState {
    pub admin: Address,
    pub asset: Address,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub simulation: bool,
    pub principal: i128,
    pub accrued: i128,
    pub assets: i128,
    pub shares: i128,
    /// Price scaled by `PRICE_SCALE` and rounded down.
    pub price: i128,
    pub last_ts: u64,
    pub paused: bool,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Accounting,
    Shares(Address),
}

#[contract]
pub struct YieldVault;

#[contractimpl]
impl YieldVault {
    /// Initialize the vault once with an arbitrary SEP-41-compatible asset.
    ///
    /// Requires the chosen `admin` to authorize via `admin.require_auth()`. A
    /// caller may propose any address, but only that address can approve
    /// installing itself — so a front-runner cannot capture a fresh vault with
    /// an admin it does not control. Re-initialization still returns
    /// `AlreadyInit`. Binding a specific deployer at creation time is out of
    /// scope for this guarantee (self-installation by a caller who signs for
    /// themselves remains possible until initialization completes).
    ///
    /// Phase 1's simulated yield is deliberately always enabled. This
    /// contract must only be used on Testnet until a production yield source
    /// is designed, implemented, and reviewed in a later phase.
    pub fn initialize(
        env: Env,
        admin: Address,
        asset: Address,
        name: String,
        symbol: String,
        decimals: u32,
    ) -> Result<(), VaultError> {
        // Cheap idempotency check first so re-init keeps returning AlreadyInit.
        if env.storage().instance().has(&DataKey::Config) {
            return Err(VaultError::AlreadyInit);
        }

        // Auth before metadata validation: reject unauthorized callers before
        // spending work on name/symbol/decimals checks, and before writing.
        admin.require_auth();

        if name.is_empty() || name.len() > 32 {
            return Err(VaultError::BadName);
        }
        if symbol.is_empty() || symbol.len() > 32 {
            return Err(VaultError::BadSymbol);
        }
        if decimals > MAX_DECIMALS {
            return Err(VaultError::BadDecimal);
        }

        let config = Config {
            admin: admin.clone(),
            asset: asset.clone(),
            name: name.clone(),
            symbol: symbol.clone(),
            decimals,
            simulation: SIMULATED_YIELD,
        };
        let accounting = Accounting {
            principal: 0,
            accrued: 0,
            rem: 0,
            shares: 0,
            last_ts: env.ledger().timestamp(),
            paused: false,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::Accounting, &accounting);
        env.events().publish(
            ("initialize",),
            (admin, asset, name, symbol, decimals, SIMULATED_YIELD),
        );
        Ok(())
    }

    /// Deposit underlying assets and mint proportional vault shares.
    pub fn deposit(env: Env, user: Address, assets: i128) -> Result<i128, VaultError> {
        user.require_auth();
        Self::not_paused(&env)?;
        Self::accrue_internal(&env)?;
        if assets <= 0 {
            return Err(VaultError::BadAmount);
        }

        let mut accounting = Self::accounting(&env)?;
        let total_assets = Self::total_accounted(&accounting)?;
        let shares = if accounting.shares == 0 {
            assets
        } else {
            Self::mul_div_floor(assets, accounting.shares, total_assets)?
        };
        if shares <= 0 {
            return Err(VaultError::ZeroShares);
        }

        let config = Self::config(&env)?;
        let token_client = token::TokenClient::new(&env, &config.asset);
        if token_client.balance(&user) < assets {
            return Err(VaultError::NoAssets);
        }
        token_client.transfer(&user, &env.current_contract_address(), &assets);

        accounting.principal = Self::add(accounting.principal, assets)?;
        accounting.shares = Self::add(accounting.shares, shares)?;
        Self::set_accounting(&env, &accounting);
        Self::add_shares(&env, &user, shares)?;

        env.events()
            .publish(("deposit", user.clone()), (assets, shares));
        env.events().publish(("share_mint", user), shares);
        Ok(shares)
    }

    /// Burn exactly `shares` and return its proportional underlying assets.
    /// Asset conversion rounds down, protecting the vault from overpayment.
    pub fn redeem(env: Env, user: Address, shares: i128) -> Result<i128, VaultError> {
        user.require_auth();
        Self::not_paused(&env)?;
        Self::accrue_internal(&env)?;
        Self::redeem_internal(&env, &user, shares)
    }

    /// Withdraw exactly `assets`, burning the rounded-up share amount.
    /// Rounding applies only to shares; the token transfer equals `assets`.
    pub fn withdraw(env: Env, user: Address, assets: i128) -> Result<i128, VaultError> {
        user.require_auth();
        Self::not_paused(&env)?;
        Self::accrue_internal(&env)?;
        if assets <= 0 {
            return Err(VaultError::BadAmount);
        }

        let accounting = Self::accounting(&env)?;
        let total_assets = Self::total_accounted(&accounting)?;
        if assets > total_assets {
            return Err(VaultError::NoAssets);
        }
        if accounting.shares <= 0 {
            return Err(VaultError::NoShares);
        }
        let shares = Self::mul_div_ceil(assets, accounting.shares, total_assets)?;
        if shares == accounting.shares && assets < total_assets {
            return Err(VaultError::RoundEmpty);
        }
        Self::withdraw_internal(&env, &user, assets, shares)
    }

    /// Crystallize deterministic, ledger-time-based simulated yield.
    ///
    /// No oracle, strategy, Treasury Bill, RWA integration, or token mint is
    /// performed. Any token liquidity needed for a simulated yield redemption
    /// must be supplied separately by the testnet operator.
    pub fn accrue_yield(env: Env) -> Result<i128, VaultError> {
        Self::not_paused(&env)?;
        Self::accrue_internal(&env)
    }

    pub fn pause(env: Env) -> Result<(), VaultError> {
        let config = Self::config(&env)?;
        config.admin.require_auth();
        let mut accounting = Self::accounting(&env)?;
        if accounting.paused {
            return Err(VaultError::Paused);
        }
        accounting.paused = true;
        Self::set_accounting(&env, &accounting);
        env.events().publish(("pause",), config.admin);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), VaultError> {
        let config = Self::config(&env)?;
        config.admin.require_auth();
        let mut accounting = Self::accounting(&env)?;
        if !accounting.paused {
            return Err(VaultError::NotPaused);
        }
        accounting.paused = false;
        Self::set_accounting(&env, &accounting);
        env.events().publish(("unpause",), config.admin);
        Ok(())
    }

    pub fn get_vault_state(env: Env) -> Result<VaultState, VaultError> {
        let config = Self::config(&env)?;
        let accounting = Self::accounting(&env)?;
        let pending = Self::pending_yield(&env, &accounting)?;
        let accrued = Self::add(accounting.accrued, pending)?;
        let assets = Self::add(accounting.principal, accrued)?;
        Ok(VaultState {
            admin: config.admin,
            asset: config.asset,
            name: config.name,
            symbol: config.symbol,
            decimals: config.decimals,
            simulation: config.simulation,
            principal: accounting.principal,
            accrued,
            assets,
            shares: accounting.shares,
            price: Self::price_from(assets, accounting.shares)?,
            last_ts: accounting.last_ts,
            paused: accounting.paused,
        })
    }

    pub fn admin(env: Env) -> Result<Address, VaultError> {
        Ok(Self::config(&env)?.admin)
    }

    pub fn asset(env: Env) -> Result<Address, VaultError> {
        Ok(Self::config(&env)?.asset)
    }

    pub fn name(env: Env) -> Result<String, VaultError> {
        Ok(Self::config(&env)?.name)
    }

    pub fn symbol(env: Env) -> Result<String, VaultError> {
        Ok(Self::config(&env)?.symbol)
    }

    pub fn decimals(env: Env) -> Result<u32, VaultError> {
        Ok(Self::config(&env)?.decimals)
    }

    pub fn balance_of(env: Env, user: Address) -> Result<i128, VaultError> {
        Self::config(&env)?;
        Ok(Self::share_balance(&env, &user))
    }

    pub fn underlying_balance_of(env: Env, user: Address) -> Result<i128, VaultError> {
        let config = Self::config(&env)?;
        Ok(token::TokenClient::new(&env, &config.asset).balance(&user))
    }

    pub fn available_liquidity(env: Env) -> Result<i128, VaultError> {
        let config = Self::config(&env)?;
        Ok(token::TokenClient::new(&env, &config.asset).balance(&env.current_contract_address()))
    }

    pub fn total_assets(env: Env) -> Result<i128, VaultError> {
        let accounting = Self::accounting(&env)?;
        Self::total_current(&env, &accounting)
    }

    pub fn total_shares(env: Env) -> Result<i128, VaultError> {
        Ok(Self::accounting(&env)?.shares)
    }

    /// Share price scaled by `PRICE_SCALE` (1e18), rounded down.
    pub fn share_price(env: Env) -> Result<i128, VaultError> {
        let accounting = Self::accounting(&env)?;
        Self::price_from(Self::total_current(&env, &accounting)?, accounting.shares)
    }

    pub fn is_paused(env: Env) -> Result<bool, VaultError> {
        Ok(Self::accounting(&env)?.paused)
    }

    /// Whether the vault has been initialized.
    ///
    /// This view cannot fail, so callers can tell "not initialized" apart from
    /// a genuine read error on the other getters.
    pub fn is_initialized(env: Env) -> bool {
        env.storage().instance().has(&DataKey::Config)
    }

    pub fn convert_to_shares(env: Env, assets: i128) -> Result<i128, VaultError> {
        if assets < 0 {
            return Err(VaultError::BadAmount);
        }
        let accounting = Self::accounting(&env)?;
        let total_assets = Self::total_current(&env, &accounting)?;
        if accounting.shares == 0 {
            return Ok(assets);
        }
        Self::mul_div_floor(assets, accounting.shares, total_assets)
    }

    pub fn convert_to_assets(env: Env, shares: i128) -> Result<i128, VaultError> {
        if shares < 0 {
            return Err(VaultError::BadAmount);
        }
        let accounting = Self::accounting(&env)?;
        let total_assets = Self::total_current(&env, &accounting)?;
        if accounting.shares == 0 {
            return Ok(0);
        }
        Self::mul_div_floor(shares, total_assets, accounting.shares)
    }

    fn redeem_internal(env: &Env, user: &Address, shares: i128) -> Result<i128, VaultError> {
        if shares <= 0 {
            return Err(VaultError::BadAmount);
        }
        let mut accounting = Self::accounting(env)?;
        let user_shares = Self::share_balance(env, user);
        if shares > user_shares || accounting.shares <= 0 {
            return Err(VaultError::NoShares);
        }

        let total_assets = Self::total_accounted(&accounting)?;
        let assets = Self::mul_div_floor(shares, total_assets, accounting.shares)?;
        if assets <= 0 {
            return Err(VaultError::NoAssets);
        }
        Self::settle_redemption(env, user, assets, shares, &mut accounting)?;
        Ok(assets)
    }

    fn withdraw_internal(
        env: &Env,
        user: &Address,
        assets: i128,
        shares: i128,
    ) -> Result<i128, VaultError> {
        let mut accounting = Self::accounting(env)?;
        let user_shares = Self::share_balance(env, user);
        if shares > user_shares || accounting.shares <= 0 {
            return Err(VaultError::NoShares);
        }
        Self::settle_redemption(env, user, assets, shares, &mut accounting)?;
        Ok(assets)
    }

    fn settle_redemption(
        env: &Env,
        user: &Address,
        assets: i128,
        shares: i128,
        accounting: &mut Accounting,
    ) -> Result<(), VaultError> {
        let total_assets = Self::total_accounted(accounting)?;
        let config = Self::config(env)?;
        let token_client = token::TokenClient::new(env, &config.asset);
        if token_client.balance(&env.current_contract_address()) < assets {
            return Err(VaultError::NoLiquidity);
        }

        // Split the requested payout between principal and accrued yield.
        // A full redemption uses the exact stored components; partial
        // redemptions use floor rounding while preserving both components.
        let (principal_out, yield_out) = if assets == total_assets {
            (accounting.principal, accounting.accrued)
        } else {
            let yield_out = Self::mul_div_floor(assets, accounting.accrued, total_assets)?;
            let principal_out = assets.checked_sub(yield_out).ok_or(VaultError::Overflow)?;
            (principal_out, yield_out)
        };
        let original_principal = accounting.principal;
        let remaining_principal = original_principal
            .checked_sub(principal_out)
            .ok_or(VaultError::Overflow)?;
        accounting.principal = remaining_principal;
        accounting.accrued = accounting
            .accrued
            .checked_sub(yield_out)
            .ok_or(VaultError::Overflow)?;
        let remaining_shares = accounting
            .shares
            .checked_sub(shares)
            .ok_or(VaultError::Overflow)?;
        accounting.rem = if remaining_principal == 0 || original_principal == 0 {
            0
        } else {
            // The fractional yield remainder belongs to the principal base,
            // so scale it with principal rather than with share supply.
            Self::mul_div_floor(accounting.rem, remaining_principal, original_principal)?
        };
        accounting.shares = remaining_shares;

        token_client.transfer(&env.current_contract_address(), user, &assets);
        Self::set_accounting(env, accounting);
        Self::sub_shares(env, user, shares)?;
        env.events()
            .publish(("withdraw", user.clone()), (assets, shares));
        env.events().publish(("share_burn", user.clone()), shares);
        Ok(())
    }

    fn accrue_internal(env: &Env) -> Result<i128, VaultError> {
        let mut accounting = Self::accounting(env)?;
        let now = env.ledger().timestamp();
        if !SIMULATED_YIELD {
            accounting.last_ts = now;
            Self::set_accounting(env, &accounting);
            return Ok(0);
        }
        if now <= accounting.last_ts || accounting.principal == 0 {
            if now > accounting.last_ts {
                accounting.last_ts = now;
                Self::set_accounting(env, &accounting);
            }
            return Ok(0);
        }

        let elapsed = (now - accounting.last_ts) as i128;
        let (yield_amount, remainder) =
            Self::simulated_yield_parts(accounting.principal, elapsed, accounting.rem)?;
        accounting.rem = remainder;
        accounting.accrued = Self::add(accounting.accrued, yield_amount)?;
        accounting.last_ts = now;
        Self::set_accounting(env, &accounting);
        if yield_amount > 0 {
            env.events().publish(("yield",), (yield_amount, now));
        }
        Ok(yield_amount)
    }

    fn pending_yield(env: &Env, accounting: &Accounting) -> Result<i128, VaultError> {
        if !SIMULATED_YIELD || accounting.principal == 0 {
            return Ok(0);
        }
        let now = env.ledger().timestamp();
        if now <= accounting.last_ts {
            return Ok(0);
        }
        let elapsed = (now - accounting.last_ts) as i128;
        Ok(Self::simulated_yield_parts(accounting.principal, elapsed, accounting.rem)?.0)
    }

    fn simulated_yield_parts(
        principal: i128,
        elapsed: i128,
        remainder: i128,
    ) -> Result<(i128, i128), VaultError> {
        let rate_elapsed = Self::mul(SIM_APY_BPS, elapsed)?;
        let (whole, base_remainder) = Self::mul_div_parts(principal, rate_elapsed, YIELD_DENOM)?;
        if base_remainder >= YIELD_DENOM - remainder {
            Ok((
                Self::add(whole, 1)?,
                base_remainder - (YIELD_DENOM - remainder),
            ))
        } else {
            Ok((whole, Self::add(base_remainder, remainder)?))
        }
    }

    fn total_accounted(accounting: &Accounting) -> Result<i128, VaultError> {
        Self::add(accounting.principal, accounting.accrued)
    }

    fn total_current(env: &Env, accounting: &Accounting) -> Result<i128, VaultError> {
        Self::add(
            Self::total_accounted(accounting)?,
            Self::pending_yield(env, accounting)?,
        )
    }

    fn price_from(assets: i128, shares: i128) -> Result<i128, VaultError> {
        if shares == 0 {
            return Ok(PRICE_SCALE);
        }
        Self::mul_div_floor(assets, PRICE_SCALE, shares)
    }

    fn config(env: &Env) -> Result<Config, VaultError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(VaultError::NotInit)
    }

    fn accounting(env: &Env) -> Result<Accounting, VaultError> {
        env.storage()
            .instance()
            .get(&DataKey::Accounting)
            .ok_or(VaultError::NotInit)
    }

    fn set_accounting(env: &Env, accounting: &Accounting) {
        env.storage()
            .instance()
            .set(&DataKey::Accounting, accounting);
    }

    fn share_balance(env: &Env, user: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Shares(user.clone()))
            .unwrap_or(0)
    }

    fn add_shares(env: &Env, user: &Address, shares: i128) -> Result<(), VaultError> {
        let balance = Self::add(Self::share_balance(env, user), shares)?;
        env.storage()
            .persistent()
            .set(&DataKey::Shares(user.clone()), &balance);
        Ok(())
    }

    fn sub_shares(env: &Env, user: &Address, shares: i128) -> Result<(), VaultError> {
        let balance = Self::share_balance(env, user);
        let remaining = balance.checked_sub(shares).ok_or(VaultError::NoShares)?;
        if remaining == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::Shares(user.clone()));
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::Shares(user.clone()), &remaining);
        }
        Ok(())
    }

    fn not_paused(env: &Env) -> Result<(), VaultError> {
        if Self::accounting(env)?.paused {
            Err(VaultError::Paused)
        } else {
            Ok(())
        }
    }

    fn add(left: i128, right: i128) -> Result<i128, VaultError> {
        left.checked_add(right).ok_or(VaultError::Overflow)
    }

    fn mul(left: i128, right: i128) -> Result<i128, VaultError> {
        left.checked_mul(right).ok_or(VaultError::Overflow)
    }

    fn mul_div_floor(left: i128, right: i128, denominator: i128) -> Result<i128, VaultError> {
        Ok(Self::mul_div_parts(left, right, denominator)?.0)
    }

    fn mul_div_ceil(left: i128, right: i128, denominator: i128) -> Result<i128, VaultError> {
        let (floor, remainder) = Self::mul_div_parts(left, right, denominator)?;
        if remainder == 0 {
            Ok(floor)
        } else {
            Self::add(floor, 1)
        }
    }

    /// Returns `(floor(left * right / denominator), left * right % denominator)`
    /// without creating an unchecked intermediate product.
    fn mul_div_parts(
        left: i128,
        right: i128,
        denominator: i128,
    ) -> Result<(i128, i128), VaultError> {
        if left < 0 || right < 0 || denominator <= 0 {
            return Err(VaultError::Overflow);
        }

        // Represent each doubled binary term as q * denominator + r. Every
        // addition and multiplication below is checked, including the case
        // where the final quotient itself cannot fit in i128.
        let mut term_q = left / denominator;
        let mut term_r = left % denominator;
        let mut result_q = 0i128;
        let mut result_r = 0i128;
        let mut multiplier = right;

        while multiplier > 0 {
            if multiplier % 2 == 1 {
                result_q = Self::add(result_q, term_q)?;
                if term_r >= denominator - result_r {
                    result_q = Self::add(result_q, 1)?;
                    result_r = term_r - (denominator - result_r);
                } else {
                    result_r = Self::add(result_r, term_r)?;
                }
            }
            multiplier /= 2;
            if multiplier == 0 {
                break;
            }

            let carry = if term_r >= denominator - term_r { 1 } else { 0 };
            term_r = if carry == 1 {
                term_r - (denominator - term_r)
            } else {
                Self::add(term_r, term_r)?
            };
            term_q = Self::add(Self::mul(term_q, 2)?, carry)?;
        }

        Ok((result_q, result_r))
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Address, Env, String,
    };

    fn setup() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let vault = env.register_contract(None, YieldVault);
        let client = YieldVaultClient::new(&env, &vault);
        client.initialize(
            &admin,
            &asset,
            &String::from_str(&env, "YieldAnchor Vault"),
            &String::from_str(&env, "yVAULT"),
            &6,
        );

        let asset_admin = StellarAssetClient::new(&env, &asset);
        asset_admin.mint(&alice, &1_000_000);
        asset_admin.mint(&bob, &1_000_000);
        (env, vault, asset, admin, alice, bob)
    }

    #[test]
    fn initializes_metadata_and_empty_state() {
        let (env, vault, asset, admin, _, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        assert!(client.is_initialized());
        let state = client.get_vault_state();
        assert_eq!(state.admin, admin);
        assert_eq!(state.asset, asset);
        assert_eq!(state.name, String::from_str(&env, "YieldAnchor Vault"));
        assert_eq!(state.symbol, String::from_str(&env, "yVAULT"));
        assert_eq!(state.decimals, 6);
        assert!(state.simulation);
        assert_eq!(state.assets, 0);
        assert_eq!(state.shares, 0);
        assert_eq!(state.price, PRICE_SCALE);
        assert!(!state.paused);
    }

    #[test]
    fn initialization_validates_metadata_and_is_one_time() {
        let (env, vault, asset, admin, _, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        assert_eq!(
            client.try_initialize(
                &admin,
                &asset,
                &String::from_str(&env, "Other"),
                &String::from_str(&env, "OTHER"),
                &6,
            ),
            Err(Ok(VaultError::AlreadyInit))
        );

        let fresh = Env::default();
        fresh.mock_all_auths();
        let fresh_admin = Address::generate(&fresh);
        let fresh_asset = fresh
            .register_stellar_asset_contract_v2(fresh_admin.clone())
            .address();
        let fresh_vault = fresh.register_contract(None, YieldVault);
        let fresh_client = YieldVaultClient::new(&fresh, &fresh_vault);
        assert!(!fresh_client.is_initialized());
        assert_eq!(
            fresh_client.try_initialize(
                &fresh_admin,
                &fresh_asset,
                &String::from_str(&fresh, ""),
                &String::from_str(&fresh, "Y"),
                &6,
            ),
            Err(Ok(VaultError::BadName))
        );
        assert_eq!(
            fresh_client.try_initialize(
                &fresh_admin,
                &fresh_asset,
                &String::from_str(&fresh, "Yield"),
                &String::from_str(&fresh, ""),
                &6,
            ),
            Err(Ok(VaultError::BadSymbol))
        );
        assert_eq!(
            fresh_client.try_initialize(
                &fresh_admin,
                &fresh_asset,
                &String::from_str(&fresh, "Yield"),
                &String::from_str(&fresh, "Y"),
                &(MAX_DECIMALS + 1),
            ),
            Err(Ok(VaultError::BadDecimal))
        );
        assert_eq!(
            fresh_client.try_total_assets(),
            Err(Ok(VaultError::NotInit))
        );
        assert_eq!(
            fresh_client.try_initialize(
                &fresh_admin,
                &fresh_asset,
                &String::from_str(&fresh, "123456789012345678901234567890123"),
                &String::from_str(&fresh, "Y"),
                &6,
            ),
            Err(Ok(VaultError::BadName))
        );
    }

    #[test]
    fn deposits_transfer_assets_and_mint_one_to_one_initial_shares() {
        let (env, vault, _, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        assert_eq!(client.deposit(&alice, &100), 100);
        assert_eq!(client.balance_of(&alice), 100);
        assert_eq!(client.total_assets(), 100);
        assert_eq!(client.total_shares(), 100);
        assert_eq!(client.available_liquidity(), 100);
        assert_eq!(client.underlying_balance_of(&alice), 999_900);
        assert_eq!(client.convert_to_shares(&100), 100);
        assert_eq!(client.convert_to_assets(&100), 100);
        assert_eq!(
            client.try_deposit(&alice, &0),
            Err(Ok(VaultError::BadAmount))
        );
        assert_eq!(
            client.try_deposit(&alice, &-1),
            Err(Ok(VaultError::BadAmount))
        );
        assert_eq!(
            client.try_deposit(&alice, &1_000_001),
            Err(Ok(VaultError::NoAssets))
        );
        assert_eq!(
            client.try_convert_to_shares(&-1),
            Err(Ok(VaultError::BadAmount))
        );
        assert_eq!(
            client.try_convert_to_assets(&-1),
            Err(Ok(VaultError::BadAmount))
        );
    }

    #[test]
    fn multiple_users_receive_proportional_shares() {
        let (env, vault, _, _, alice, bob) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        assert_eq!(client.deposit(&alice, &100), 100);
        assert_eq!(client.deposit(&bob, &300), 300);
        assert_eq!(client.balance_of(&alice), 100);
        assert_eq!(client.balance_of(&bob), 300);
        assert_eq!(client.total_assets(), 400);
        assert_eq!(client.total_shares(), 400);
    }

    #[test]
    fn simulated_yield_uses_ledger_time_without_double_accrual() {
        let (env, vault, _, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.deposit(&alice, &1000);
        env.ledger().set_timestamp(SIM_YEAR as u64);
        assert_eq!(client.total_assets(), 1080);
        assert_eq!(client.get_vault_state().accrued, 80);
        assert_eq!(client.share_price(), 1_080_000_000_000_000_000);
        assert_eq!(client.accrue_yield(), 80);
        assert_eq!(client.accrue_yield(), 0);
        assert_eq!(client.total_assets(), 1080);
    }

    #[test]
    fn deposits_after_yield_use_current_price_and_floor_rounding() {
        let (env, vault, _, _, alice, bob) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.deposit(&alice, &100);
        env.ledger().set_timestamp(SIM_YEAR as u64);
        client.accrue_yield();
        assert_eq!(client.deposit(&bob, &100), 92);
        assert_eq!(client.total_assets(), 208);
        assert_eq!(client.total_shares(), 192);
        assert_eq!(client.convert_to_shares(&1), 0);
        assert_eq!(client.share_price(), 1_083_333_333_333_333_333);
    }

    #[test]
    fn yield_remainder_is_retained_until_a_whole_asset_unit_exists() {
        let (env, vault, _, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.deposit(&alice, &1);
        env.ledger().set_timestamp(SIM_YEAR as u64);
        assert_eq!(client.accrue_yield(), 0);
        env.ledger().set_timestamp((SIM_YEAR * 13) as u64);
        assert_eq!(client.accrue_yield(), 1);
        assert_eq!(client.total_assets(), 2);
    }

    #[test]
    fn redeem_burns_shares_and_returns_proportional_assets() {
        let (env, vault, asset, _, alice, bob) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.deposit(&alice, &100);
        client.deposit(&bob, &300);
        env.ledger().set_timestamp(SIM_YEAR as u64);
        client.accrue_yield();
        StellarAssetClient::new(&env, &asset).mint(&vault, &32);
        assert_eq!(client.redeem(&alice, &100), 108);
        assert_eq!(client.balance_of(&alice), 0);
        assert_eq!(client.total_assets(), 324);
        assert_eq!(client.total_shares(), 300);
        assert_eq!(client.available_liquidity(), 324);
        assert_eq!(client.redeem(&bob, &300), 324);
        assert_eq!(client.total_assets(), 0);
        assert_eq!(client.total_shares(), 0);
        assert_eq!(client.available_liquidity(), 0);
    }

    #[test]
    fn redeem_checks_shares_and_underlying_liquidity() {
        let (env, vault, _, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.deposit(&alice, &100);
        assert_eq!(
            client.try_redeem(&alice, &0),
            Err(Ok(VaultError::BadAmount))
        );
        assert_eq!(
            client.try_redeem(&alice, &-1),
            Err(Ok(VaultError::BadAmount))
        );
        assert_eq!(
            client.try_redeem(&alice, &101),
            Err(Ok(VaultError::NoShares))
        );
        env.ledger().set_timestamp(SIM_YEAR as u64);
        client.accrue_yield();
        assert_eq!(
            client.try_redeem(&alice, &100),
            Err(Ok(VaultError::NoLiquidity))
        );
    }

    #[test]
    fn withdraw_uses_ceil_share_rounding_and_exact_asset_amount() {
        let (env, vault, asset, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.deposit(&alice, &100);
        env.ledger().set_timestamp(SIM_YEAR as u64);
        client.accrue_yield();
        StellarAssetClient::new(&env, &asset).mint(&vault, &8);
        assert_eq!(
            client.try_withdraw(&alice, &109),
            Err(Ok(VaultError::NoAssets))
        );
        assert_eq!(client.withdraw(&alice, &54), 54);
        assert_eq!(client.balance_of(&alice), 50);
        assert_eq!(client.total_assets(), 54);
        assert_eq!(
            client.try_withdraw(&alice, &0),
            Err(Ok(VaultError::BadAmount))
        );
    }

    #[test]
    fn withdrawal_rounding_cannot_empty_a_user_for_a_partial_payout() {
        let (env, vault, _, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.deposit(&alice, &1);
        env.ledger().set_timestamp((SIM_YEAR * 13) as u64);
        client.accrue_yield();
        assert_eq!(
            client.try_withdraw(&alice, &1),
            Err(Ok(VaultError::RoundEmpty))
        );
    }

    #[test]
    fn pause_blocks_mutating_financial_operations_and_unpause_restores_them() {
        let (env, vault, _, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        client.pause();
        assert_eq!(client.try_pause(), Err(Ok(VaultError::Paused)));
        assert!(client.is_paused());
        assert_eq!(
            client.try_deposit(&alice, &100),
            Err(Ok(VaultError::Paused))
        );
        assert_eq!(client.try_redeem(&alice, &1), Err(Ok(VaultError::Paused)));
        assert_eq!(client.try_withdraw(&alice, &1), Err(Ok(VaultError::Paused)));
        assert_eq!(client.try_accrue_yield(), Err(Ok(VaultError::Paused)));
        // Pausing blocks mutations only; read-only views stay available.
        assert_eq!(client.total_assets(), 0);
        assert_eq!(client.total_shares(), 0);
        client.unpause();
        assert_eq!(client.try_unpause(), Err(Ok(VaultError::NotPaused)));
        assert!(!client.is_paused());
        assert_eq!(client.deposit(&alice, &100), 100);
    }

    #[test]
    fn authorization_is_required_for_initialization_users_and_admin() {
        let (env, vault, _, _, alice, _) = setup();
        let client = YieldVaultClient::new(&env, &vault);
        env.set_auths(&[]);
        assert!(client.try_pause().is_err());
        assert!(client.try_deposit(&alice, &100).is_err());

        let fresh = Env::default();
        let fresh_admin = Address::generate(&fresh);
        let fresh_asset = fresh
            .register_stellar_asset_contract_v2(fresh_admin.clone())
            .address();
        let fresh_vault = fresh.register_contract(None, YieldVault);
        let fresh_client = YieldVaultClient::new(&fresh, &fresh_vault);
        assert!(fresh_client
            .try_initialize(
                &fresh_admin,
                &fresh_asset,
                &String::from_str(&fresh, "Yield"),
                &String::from_str(&fresh, "Y"),
                &6,
            )
            .is_err());
    }

    /// Front-runner holds only their own credentials. Even with a fully
    /// authorized `initialize` invoke for the attacker address, installing a
    /// different admin must fail and leave the vault uninitialized. The
    /// residual honest case: the attacker can only ever install themselves.
    #[test]
    fn initialize_rejects_front_runner_installing_foreign_admin() {
        use soroban_sdk::{
            testutils::{MockAuth, MockAuthInvoke},
            vec, IntoVal,
        };

        let env = Env::default();
        let intended_admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(intended_admin.clone())
            .address();
        let vault = env.register_contract(None, YieldVault);
        let client = YieldVaultClient::new(&env, &vault);
        let name = String::from_str(&env, "Yield");
        let symbol = String::from_str(&env, "Y");

        env.mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &vault,
                fn_name: "initialize",
                args: vec![
                    &env,
                    attacker.into_val(&env),
                    asset.into_val(&env),
                    name.into_val(&env),
                    symbol.into_val(&env),
                    6u32.into_val(&env),
                ],
                sub_invokes: &[],
            },
        }]);
        assert!(client
            .try_initialize(&intended_admin, &asset, &name, &symbol, &6)
            .is_err());
        assert!(!client.is_initialized());

        client.initialize(&attacker, &asset, &name, &symbol, &6);
        assert!(client.is_initialized());
        assert_eq!(client.admin(), attacker);
    }

    /// Without admin auth, initialize must fail at require_auth — it must not
    /// surface a metadata VaultError such as BadName.
    #[test]
    fn initialize_requires_auth_before_metadata_validation() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let vault = env.register_contract(None, YieldVault);
        let client = YieldVaultClient::new(&env, &vault);

        let res = client.try_initialize(
            &admin,
            &asset,
            &String::from_str(&env, ""),
            &String::from_str(&env, "yVAULT"),
            &6,
        );
        assert!(res.is_err());
        assert_ne!(res, Err(Ok(VaultError::BadName)));
        assert!(!client.is_initialized());
    }

    #[test]
    #[should_panic]
    fn initialize_panics_without_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let vault = env.register_contract(None, YieldVault);
        let client = YieldVaultClient::new(&env, &vault);

        // No mock_all_auths: require_auth must abort.
        client.initialize(
            &admin,
            &asset,
            &String::from_str(&env, "YieldAnchor Vault"),
            &String::from_str(&env, "yVAULT"),
            &6,
        );
    }
}
