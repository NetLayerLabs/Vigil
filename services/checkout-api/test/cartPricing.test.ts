import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPromotions, authorizeCheckout, InventoryPool, toMinorUnits } from '../src/cartPricing.js';

test('USD standard checkout ($99.00) charges 10692 cents incl. 8% tax', () => {
  const r = authorizeCheckout(
    { cartId: 't_usd', currency: 'USD', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 99 }] },
    new InventoryPool(3),
  );
  assert.equal(r.chargeMinorUnits, 10692);
});

test('JPY zero-decimal checkout (¥9,600) charges ¥10368 with scale 1', () => {
  const r = authorizeCheckout(
    { cartId: 't_jpy', currency: 'JPY', items: [{ sku: 'PRO', qty: 2, unitPriceMajor: 4800 }] },
    new InventoryPool(3),
  );
  assert.equal(r.chargeMinorUnits, 10368);
});

test('KRW zero-decimal checkout (₩55,000) prices without throwing', () => {
  const r = authorizeCheckout(
    { cartId: 't_krw', currency: 'KRW', items: [{ sku: 'TEAM', qty: 1, unitPriceMajor: 55000 }] },
    new InventoryPool(3),
  );
  assert.equal(r.chargeMinorUnits, toMinorUnits(55000 * 1.08, 'KRW'));
});

test('Stacked and duplicate promo codes are deduplicated and floored, never negative', () => {
  const { discountedMajor, applied } = applyPromotions(29, ['VIP40', 'SAVE15', 'VIP40'], 'USD');
  assert.deepEqual(applied, ['VIP40', 'SAVE15']);
  assert.ok(discountedMajor >= 1, `floor violated: ${discountedMajor}`);
  const r = authorizeCheckout(
    {
      cartId: 't_promo',
      currency: 'USD',
      items: [{ sku: 'STARTER', qty: 1, unitPriceMajor: 29 }],
      promoCodes: ['VIP40', 'SAVE15', 'VIP40'],
    },
    new InventoryPool(3),
  );
  assert.ok(r.chargeMinorUnits >= 100, `charge below floor: ${r.chargeMinorUnits}`);
});

test('Fraud-declined checkouts release their inventory reservation (no semaphore leak)', () => {
  const pool = new InventoryPool(3);
  for (let i = 0; i < 4; i++) {
    assert.throws(
      () =>
        authorizeCheckout(
          {
            cartId: `t_fraud_${i}`,
            currency: 'USD',
            items: [{ sku: 'KEY', qty: 1, unitPriceMajor: 85 }],
            simulateFraudDecline: true,
          },
          pool,
        ),
      /FraudCheckDeclined|Fraud screen declined/,
    );
  }
  assert.equal(pool.activeLocks, 0, `leaked ${pool.activeLocks} slots`);
  // a 5th, legitimate checkout must still succeed
  const ok = authorizeCheckout(
    { cartId: 't_after', currency: 'USD', items: [{ sku: 'KEY', qty: 1, unitPriceMajor: 85 }] },
    pool,
  );
  assert.equal(ok.currency, 'USD');
});
