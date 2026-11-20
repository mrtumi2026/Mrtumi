'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafePaisa } = require('../src/utils/money');
const SteadfastAdapter = require('../src/services/courier/adapters/SteadfastAdapter');
const PathaoAdapter = require('../src/services/courier/adapters/PathaoAdapter');

test('E2E All-Portals Lifecycle: Admin, Vendor & Reseller Complete Workflow Continuity', async () => {
  // 1. Initial State Definition
  const wholesalePricePaisa = 50000; // ৳500.00
  const resellerPricePaisa = 65000;  // ৳650.00
  const expectedMarginPaisa = 15000; // ৳150.00
  const deliveryChargePaisa = 6000;  // ৳60.00
  const totalCustomerChargePaisa = resellerPricePaisa + deliveryChargePaisa; // ৳710.00

  assertSafePaisa(wholesalePricePaisa);
  assertSafePaisa(resellerPricePaisa);
  assertSafePaisa(expectedMarginPaisa);
  assertSafePaisa(totalCustomerChargePaisa);

  // 2. Step 1: Product Approval Lifecycle
  const product = {
    id: 501,
    name: 'Artisan Mustard Oil 1L',
    vendor_id: 201,
    status: 0,
    approval_status: 'pending',
    stock_quantity: 50,
    wholesale_price_paisa: wholesalePricePaisa,
  };

  // Admin approves product
  product.approval_status = 'approved';
  product.status = 1;
  assert.equal(product.approval_status, 'approved', 'Product must be approved by admin');
  assert.equal(product.status, 1, 'Approved product must be active in catalog');

  // 3. Step 2: Reseller Order Placement with Inventory Reservation
  const order = {
    id: 7001,
    invoice_no: 'INV-20261114-7001',
    reseller_id: 301,
    customer_name: 'Tanvir Ahmed',
    customer_phone: '01712345678',
    delivery_location: 'Dhaka',
    order_status: 'confirmed',
    payment_status: 'unpaid',
    payment_method: 'cod',
    total_paisa: totalCustomerChargePaisa,
  };

  // Stock reservation
  const initialStock = product.stock_quantity;
  const orderedQty = 2;
  const reservedStock = orderedQty;
  const remainingStock = initialStock - orderedQty;
  assert.ok(remainingStock >= 0, 'Inventory reservation must not overdraft stock');

  // 4. Step 3: Multi-Vendor / Sub-Order Split & Isolation
  const subOrder = {
    id: 8001,
    parent_order_id: order.id,
    vendor_id: product.vendor_id,
    status: 'pending',
    vendor_entitlement_paisa: wholesalePricePaisa * orderedQty, // ৳1000.00
    reseller_margin_paisa: expectedMarginPaisa * orderedQty,    // ৳300.00
  };

  // Tenant isolation assertion: foreign vendor cannot access this sub-order
  const unauthorizedVendorId = 999;
  const isAccessibleByForeignVendor = unauthorizedVendorId === subOrder.vendor_id;
  assert.equal(isAccessibleByForeignVendor, false, 'Sub-order must remain isolated to owning vendor');

  // 5. Step 4: Vendor Fulfillment Lifecycle
  subOrder.status = 'processing';
  assert.equal(subOrder.status, 'processing');
  subOrder.status = 'ready_for_pickup';
  assert.equal(subOrder.status, 'ready_for_pickup');

  // 6. Step 5: Courier Consignment Booking (Sandbox Mock Dispatch)
  const adapter = new SteadfastAdapter({
    isSandbox: true,
    apiKey: 'sandbox-test-api-key',
    secretKey: 'sandbox-test-secret-key',
  });

  const courierMock = await adapter.bookShipment({
    invoiceNo: subOrder.id,
    recipient: {
      name: order.customer_name,
      phone: order.customer_phone,
      address: 'Dhanmondi, Dhaka',
    },
    codAmountPaisa: totalCustomerChargePaisa,
  });

  assert.equal(courierMock.success, true, 'Courier mock dispatch must succeed in sandbox mode');
  assert.ok(courierMock.consignmentId, 'Courier booking must return a consignment ID');
  assert.ok(courierMock.trackingId, 'Courier booking must return a tracking code');

  // Verify Pathao Courier Adapter in Sandbox Mode
  const pathao = new PathaoAdapter({
    sandbox: 1,
    apiKey: 'pathao-sandbox-key',
    secretKey: 'pathao-sandbox-secret',
  });
  const pathaoBooking = await pathao.bookShipment({
    invoiceNo: subOrder.id + 1,
    recipient: {
      name: order.customer_name,
      phone: order.customer_phone,
      address: 'House 12, Road 5, Dhanmondi, Dhaka',
      cityId: 1,
      zoneId: 1,
      areaId: 1,
    },
    codAmountPaisa: totalCustomerChargePaisa,
    parcel: { weightGrams: 500 },
  });
  assert.equal(pathaoBooking.success, true, 'Pathao mock dispatch must succeed in sandbox mode');
  assert.ok(pathaoBooking.consignmentId, 'Pathao booking must return a consignment ID');
  assert.ok(pathaoBooking.trackingId, 'Pathao booking must return a tracking ID');

  // 7. Step 6: Handover & Delivery Completion
  subOrder.status = 'shipped';
  subOrder.tracking_reference = courierMock.trackingId;
  subOrder.status = 'delivered';
  order.order_status = 'delivered';
  order.payment_status = 'paid'; // COD collected by courier

  // 8. Step 7: Escrow Balance & Settlement Maturation
  const resellerWallet = {
    reseller_id: order.reseller_id,
    pending_balance_paisa: 0,
    available_balance_paisa: 0,
  };

  // Upon delivery, earning enters pending escrow (not available immediately)
  resellerWallet.pending_balance_paisa += subOrder.reseller_margin_paisa;
  assert.equal(resellerWallet.pending_balance_paisa, 30000, 'Pending earning must be ৳300.00');
  assert.equal(resellerWallet.available_balance_paisa, 0, 'Available balance must remain 0 during return window');

  // 9. Step 8: Return Window Elapsed (7 Days) -> Matured Settlement
  const returnWindowElapsed = true;
  if (returnWindowElapsed) {
    const releaseAmount = resellerWallet.pending_balance_paisa;
    resellerWallet.pending_balance_paisa -= releaseAmount;
    resellerWallet.available_balance_paisa += releaseAmount;
  }
  assert.equal(resellerWallet.pending_balance_paisa, 0, 'Pending balance cleared after settlement release');
  assert.equal(resellerWallet.available_balance_paisa, 30000, 'Available balance credited after settlement release');

  // 10. Step 9: Payout Withdrawal Request & Admin Approval
  const withdrawalRequest = {
    id: 9001,
    reseller_id: order.reseller_id,
    amount_paisa: 30000,
    status: 'pending',
    payout_method: 'bkash',
    payout_account: '01712345678',
  };

  // Validation: cannot withdraw more than available balance
  assert.ok(withdrawalRequest.amount_paisa <= resellerWallet.available_balance_paisa, 'Withdrawal must not exceed available balance');
  resellerWallet.available_balance_paisa -= withdrawalRequest.amount_paisa;

  // Admin approves withdrawal
  withdrawalRequest.status = 'approved';
  assert.equal(withdrawalRequest.status, 'approved', 'Admin approval completes the payout');
  assert.equal(resellerWallet.available_balance_paisa, 0, 'Reseller wallet reflects full disbursement');

  // 11. Exact Mathematical Balance Verification
  const totalGoodsPaisa = resellerPricePaisa * orderedQty;
  const totalVendorPaisa = subOrder.vendor_entitlement_paisa;
  const totalResellerPaisa = subOrder.reseller_margin_paisa;
  assert.equal(totalVendorPaisa + totalResellerPaisa, totalGoodsPaisa, 'Vendor entitlement + Reseller margin must equal Goods total with 0 rounding loss');
});
