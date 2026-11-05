/**
 * checkout-api — cart pricing engine
 *
 * Pure domain logic for the checkout service: ISO-4217 minor-unit scaling, promotion ledger,
 * inventory reservation semaphore, fraud screening and the final charge computation.
 * The HTTP layer lives in server.ts. Tests live in ../test/cartPricing.test.ts.
 */

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'KRW';

export interface CartItem {
  sku: string;
  qty: number;
  unitPriceMajor: number;
}

export interface CheckoutRequest {
  cartId: string;
  currency: CurrencyCode;
  items: CartItem[];
  promoCodes?: string[];
  simulateFraudDecline?: boolean;
}

export interface CheckoutResult {
  cartId: string;
  currency: CurrencyCode;
  subtotalMinorUnits: number;
  discountMinorUnits: number;
  taxMinorUnits: number;
  chargeMinorUnits: number;
  promoCodesApplied: string[];
  inventoryReservationId: string;
}

export class CheckoutError extends Error {
  public readonly statusCode: number;
  constructor(name: string, message: string, statusCode: number) {
    super(message);
    this.name = name;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------------------------
// Currency scale table (ISO-4217 minor units). Zero-decimal currencies have a scale of 1.
// ---------------------------------------------------------------------------------------------
const CURRENCY_SCALE_MAP: Record<CurrencyCode, { minorScale: number }> = {
  USD: { minorScale: 100 },
  EUR: { minorScale: 100 },
  GBP: { minorScale: 100 },
  JPY: { minorScale: 1 },
  KRW: { minorScale: 1 },
};

export function toMinorUnits(amountMajor: number, currency: CurrencyCode): number {
  const scale = CURRENCY_SCALE_MAP[currency].minorScale;
  return Math.round(amountMajor * scale);
}

// ---------------------------------------------------------------------------------------------
// Promotions ledger
// ---------------------------------------------------------------------------------------------
const PROMOS: Record<string, number> = {
  VIP40: 40,
  SAVE15: 15,
  WELCOME5: 5,
};

/**
 * Applies promotion codes to a subtotal. Codes are deduplicated so a stacked duplicate cannot be
 * redeemed twice, and the result is floored so a cart can never be charged a negative amount.
 */
export function applyPromotions(
  subtotalMajor: number,
  codes: string[],
  currency: CurrencyCode,
): { discountedMajor: number; applied: string[] } {
  const uniqueCodes = Array.from(new Set(codes.map((c) => c.trim().toUpperCase())));
  const applied = uniqueCodes.filter((c) => PROMOS[c] !== undefined);
  const discount = applied.reduce((sum, c) => sum + PROMOS[c], 0);
  const minFloorMajor = CURRENCY_SCALE_MAP[currency].minorScale === 1 ? 50 : 1;
  const discountedMajor = Math.max(minFloorMajor, subtotalMajor - discount);
  return { discountedMajor, applied };
}

// ---------------------------------------------------------------------------------------------
// Inventory reservation semaphore
// ---------------------------------------------------------------------------------------------
export class InventoryPool {
  private held = 0;
  constructor(public readonly maxSlots: number) {}

  public get activeLocks(): number {
    return this.held;
  }

  public acquire(cartId: string): string {
    if (this.held >= this.maxSlots) {
      throw new CheckoutError(
        'LockAcquisitionTimeoutError',
        `Inventory semaphore exhausted (${this.held}/${this.maxSlots} slots held) while reserving ${cartId}`,
        503,
      );
    }
    this.held += 1;
    return `rsv_${cartId}_${this.held}`;
  }

  public release(): void {
    this.held = Math.max(0, this.held - 1);
  }
}

// ---------------------------------------------------------------------------------------------
// Fraud screening
// ---------------------------------------------------------------------------------------------
export const fraudEngine = {
  isDeclined(req: CheckoutRequest): boolean {
    return Boolean(req.simulateFraudDecline);
  },
};

const TAX_RATE = 0.08;

/**
 * Authorizes a checkout: reserves inventory, screens for fraud, prices the cart.
 * The reservation is always released, including on a fraud decline, so the pool cannot leak.
 */
export function authorizeCheckout(req: CheckoutRequest, inventoryPool: InventoryPool): CheckoutResult {
  if (!req.items || req.items.length === 0) {
    throw new CheckoutError('EmptyCartError', `Cart ${req.cartId} has no items`, 400);
  }
  if (!CURRENCY_SCALE_MAP[req.currency]) {
    throw new CheckoutError('UnsupportedCurrencyError', `Unsupported currency '${req.currency}'`, 400);
  }

  const reservationId = inventoryPool.acquire(req.cartId);
  try {
    if (fraudEngine.isDeclined(req)) {
      throw new CheckoutError('FraudCheckDeclinedError', `Fraud screen declined cart ${req.cartId}`, 422);
    }

    const subtotalMajor = req.items.reduce((sum, it) => sum + it.unitPriceMajor * it.qty, 0);
    const { discountedMajor, applied } = applyPromotions(subtotalMajor, req.promoCodes ?? [], req.currency);
    const taxMajor = discountedMajor * TAX_RATE;

    const subtotalMinorUnits = toMinorUnits(subtotalMajor, req.currency);
    const discountMinorUnits = toMinorUnits(subtotalMajor - discountedMajor, req.currency);
    const taxMinorUnits = toMinorUnits(taxMajor, req.currency);
    const chargeMinorUnits = toMinorUnits(discountedMajor + taxMajor, req.currency);

    if (chargeMinorUnits < 0) {
      throw new CheckoutError(
        'NegativeCaptureError',
        `Computed negative capture ${chargeMinorUnits} for cart ${req.cartId}`,
        500,
      );
    }

    return {
      cartId: req.cartId,
      currency: req.currency,
      subtotalMinorUnits,
      discountMinorUnits,
      taxMinorUnits,
      chargeMinorUnits,
      promoCodesApplied: applied,
      inventoryReservationId: reservationId,
    };
  } finally {
    inventoryPool.release();
  }
}
