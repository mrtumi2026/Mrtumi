'use strict';

// The cart doubles as a "saved items" list: customers tick which lines to order now.
// Only the un-ticked lines are remembered (in the session), so new items start ticked.
// Lines are identified by product + variant, which survives the saved-cart reload for signed-in customers.
const lineId = (item) => `${Number(item.product_id ?? item.productId ?? item.id)}:${Number(item.variant_id ?? item.variantId ?? 0)}`;

function unselectedIds(session) {
  return new Set(Array.isArray(session.cartUnselected) ? session.cartUnselected : []);
}

const isSelected = (session, item) => !unselectedIds(session).has(lineId(item));

function selectedLines(session, cart = session.cart) {
  const skipped = unselectedIds(session);
  return (Array.isArray(cart) ? cart : []).filter((item) => !skipped.has(lineId(item)));
}

function savedLines(session, cart = session.cart) {
  const skipped = unselectedIds(session);
  return (Array.isArray(cart) ? cart : []).filter((item) => skipped.has(lineId(item)));
}

function setSelected(session, items, selected) {
  const skipped = unselectedIds(session);
  for (const item of items) {
    if (selected) skipped.delete(lineId(item));
    else skipped.add(lineId(item));
  }
  session.cartUnselected = [...skipped].slice(-200);
}

module.exports = { lineId, isSelected, selectedLines, savedLines, setSelected };
