'use strict';

// Bangla wording for the messages that customers, vendors, resellers and shop staff meet in normal use.
// A message with no entry is shown unchanged, so nothing is ever hidden or replaced by a guess.
const EXACT = new Map(Object.entries({
  'Your cart is empty or contains too many items.': 'আপনার কার্ট খালি, অথবা কার্টে অনেক বেশি পণ্য আছে।',
  'Your server-side cart is empty.': 'আপনার কার্ট খালি।',
  'Your cart contains an invalid item.': 'কার্টের একটি পণ্য সঠিক নয়। কার্ট থেকে বাদ দিয়ে আবার যোগ করুন।',
  'Per-item quantity cannot exceed 99.': 'একটি পণ্য সর্বোচ্চ ৯৯টি অর্ডার করা যায়।',
  'This checkout currently supports one variant per product; consolidate the cart before ordering.': 'একটি অর্ডারে একই পণ্যের একটি সাইজ/কালার নেওয়া যায়।',
  'The selected product size/color is no longer available. Refresh the product and choose a valid option.': 'বেছে নেওয়া সাইজ/কালার এখন নেই। পেজ রিফ্রেশ করে আবার বেছে নিন।',
  'Select an active, configured delivery location.': 'ডেলিভারি এলাকা নির্বাচন করুন।',
  'Select a valid delivery area.': 'ডেলিভারি এলাকা নির্বাচন করুন।',
  'Select a valid payment method.': 'একটি পেমেন্ট মাধ্যম নির্বাচন করুন।',
  'Choose Cash on Delivery, bKash, Nagad, or Rocket.': 'ক্যাশ অন ডেলিভারি, বিকাশ, নগদ বা রকেট বেছে নিন।',
  'This payment method is not active or is not supported at checkout.': 'এই পেমেন্ট মাধ্যমটি এখন চালু নেই।',
  'This phone number or IP address is blocked from placing orders.': 'এই নম্বর থেকে অর্ডার নেওয়া বন্ধ আছে। আমাদের সাথে যোগাযোগ করুন।',
  'Coupon is invalid, expired, exhausted, or below its minimum order amount.': 'কুপনটি সঠিক নয়, মেয়াদ বা ব্যবহারসীমা শেষ, অথবা অর্ডারের পরিমাণ যথেষ্ট নয়।',
  'Enter a coupon code.': 'কুপন কোড লিখুন।',
  'A coupon with this code already exists.': 'এই কোডের কুপন আগে থেকেই আছে।',
  'Sign in with an account matching the delivery phone, or continue as a guest.': 'ডেলিভারি নম্বরের সাথে মিলে এমন অ্যাকাউন্টে লগইন করুন, অথবা লগইন ছাড়া অর্ডার করুন।',
  'Sign in to your account to pay part of the order from your wallet.': 'ওয়ালেট ব্যবহার করতে আগে লগইন করুন।',
  'Checkout session expired. Reload checkout and try again.': 'চেকআউট পেজের সময় শেষ হয়েছে। পেজটি রিলোড করে আবার চেষ্টা করুন।',
  'Confirm the order details before submitting.': 'অর্ডার জমা দেওয়ার আগে তথ্য ঠিক আছে কিনা টিক দিন।',
  'This checkout request key was already used with different order details.': 'পেজটি রিলোড করে আবার অর্ডার দিন।',
  'This request key was already used for different order details.': 'পেজটি রিলোড করে আবার অর্ডার দিন।',
  'Invalid or missing CSRF token.': 'পেজটির সময় শেষ হয়েছে। পেজ রিলোড করে আবার চেষ্টা করুন।',
  'Too many requests. Please try again later.': 'অল্প সময়ে অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।',
  'Enter a valid Bangladesh mobile number.': 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দিন।',
  'Password must contain 10–72 characters.': 'পাসওয়ার্ড ১০ থেকে ৭২ অক্ষরের হতে হবে।',
  'Password must contain at least 10 characters and no more than 72 UTF-8 bytes.': 'পাসওয়ার্ড কমপক্ষে ১০ অক্ষরের হতে হবে।',
  'Name must contain 2–191 characters.': 'নাম কমপক্ষে ২ অক্ষরের হতে হবে।',
  'Enter a valid email address of at most 191 characters.': 'সঠিক ইমেইল ঠিকানা দিন।',
  'Enter a valid email address.': 'সঠিক ইমেইল ঠিকানা দিন।',
  'An account already exists for this phone number.': 'এই নম্বরে আগে থেকেই অ্যাকাউন্ট আছে। লগইন করুন।',
  'A vendor account already exists for this phone or email.': 'এই নম্বর বা ইমেইলে আগে থেকেই ভেন্ডর অ্যাকাউন্ট আছে।',
  'A vendor account or NID application already exists.': 'এই তথ্যে আগে থেকেই আবেদন আছে।',
  'This NID is already associated with a vendor application.': 'এই NID দিয়ে আগে থেকেই আবেদন আছে।',
  'Accept the vendor onboarding terms to continue.': 'এগিয়ে যেতে ভেন্ডর শর্তে সম্মতি দিন।',
  'Current password is incorrect.': 'বর্তমান পাসওয়ার্ড সঠিক নয়।',
  'Recovery link is invalid or expired.': 'রিকভারি লিংকটি সঠিক নয় বা মেয়াদ শেষ।',
  'Order not found.': 'অর্ডারটি পাওয়া যায়নি।',
  'Product not found.': 'পণ্যটি পাওয়া যায়নি।',
  'Address not found.': 'ঠিকানাটি পাওয়া যায়নি।',
  'Customer account not found.': 'অ্যাকাউন্টটি পাওয়া যায়নি।',
  'Product is no longer available.': 'পণ্যটি এখন আর পাওয়া যাচ্ছে না।',
  'Selected product is unavailable.': 'বেছে নেওয়া পণ্যটি এখন পাওয়া যাচ্ছে না।',
  'Insufficient available stock.': 'পর্যাপ্ত স্টক নেই।',
  'Cart quantity must be a whole number from 1 to 99.': 'পরিমাণ ১ থেকে ৯৯ এর মধ্যে দিন।',
  'Enter a valid address.': 'সঠিক ঠিকানা লিখুন।',
  'Recipient, division, district and street address are required.': 'প্রাপক, বিভাগ, জেলা ও পূর্ণ ঠিকানা লিখুন।',
  'Please select an explicit product variant before placing this reseller order.': 'অর্ডারের আগে পণ্যের সাইজ/কালার বেছে নিন।',
  'Reseller verification is required before creating orders.': 'অর্ডার করার আগে রিসেলার অ্যাকাউন্ট যাচাই হতে হবে।',
  'Reseller pricing is not configured for this product.': 'এই পণ্যে রিসেলার মূল্য সেট করা হয়নি।',
  'Selected reseller pricing mode is not enabled for this product.': 'এই পণ্যে বেছে নেওয়া মূল্য-পদ্ধতি চালু নেই।',
  'Insufficient unreserved available wallet balance.': 'ওয়ালেটে তোলার মতো যথেষ্ট ব্যালেন্স নেই।',
  'Insufficient unreserved available commission balance.': 'তোলার মতো যথেষ্ট কমিশন ব্যালেন্স নেই।',
  'Withdrawals require an active vendor and a verified payout account.': 'টাকা তুলতে সক্রিয় দোকান ও যাচাই করা পেমেন্ট অ্যাকাউন্ট লাগবে।',
  'Choose a payout account verified by the marketplace administrator.': 'অ্যাডমিনের যাচাই করা পেমেন্ট অ্যাকাউন্ট বেছে নিন।',
  'Withdrawal amount exceeds the vendor available balance.': 'চাওয়া টাকা ভেন্ডরের ব্যালেন্সের চেয়ে বেশি।',
  'Withdrawal amount exceeds the reseller available balance.': 'চাওয়া টাকা রিসেলারের ব্যালেন্সের চেয়ে বেশি।',
  'Pending withdrawal request not found.': 'অপেক্ষমাণ উত্তোলন অনুরোধ পাওয়া যায়নি।',
  'Only active vendors can submit or edit products.': 'দোকান সক্রিয় হলে পণ্য যোগ বা পরিবর্তন করা যাবে।',
  'Only active vendors can adjust inventory.': 'দোকান সক্রিয় হলে স্টক বদলানো যাবে।',
  'Inventory cannot be lower than quantities already reserved.': 'অর্ডারে আটকে থাকা পরিমাণের চেয়ে স্টক কম রাখা যাবে না।',
  'Select an active category.': 'একটি ক্যাটাগরি নির্বাচন করুন।',
  'Select an active brand.': 'একটি ব্র্যান্ড নির্বাচন করুন।',
  'Cancellation is not available for this order.': 'এই অর্ডারটি এখন বাতিল করা যাবে না।',
  'Select at least one order item.': 'কমপক্ষে একটি পণ্য নির্বাচন করুন।',
  'Returns can only be requested for dispatched orders.': 'পাঠানো হয়েছে এমন অর্ডারেই কেবল রিটার্ন চাওয়া যায়।',
  'The category return window has expired.': 'রিটার্নের সময় শেষ হয়ে গেছে।',
  'Return quantity exceeds the purchased quantity.': 'কেনা পরিমাণের চেয়ে বেশি রিটার্ন করা যাবে না।',
}));

const PATTERNS = [
  [/^Insufficient available stock for product \d+\.$/, 'একটি পণ্যের পর্যাপ্ত স্টক নেই। কার্টে পরিমাণ কমিয়ে আবার চেষ্টা করুন।'],
  [/^(?:Product|Variant) \d+ is unavailable\.$/, 'কার্টের একটি পণ্য এখন পাওয়া যাচ্ছে না। কার্ট থেকে বাদ দিন।'],
  [/^Product \d+ has no valid sale price\.$/, 'কার্টের একটি পণ্যের দাম ঠিক করা নেই।'],
  [/^Order cannot move from ([a-z_]+) to ([a-z_]+)\.$/, (m) => `অর্ডার "${m[1]}" থেকে সরাসরি "${m[2]}" করা যায় না। ধাপে ধাপে পরিবর্তন করুন।`],
  [/^Cancellation is not available for an order in [a-z_]+ state\.$/, 'এই অবস্থার অর্ডার বাতিল করা যায় না।'],
  [/^Standard returns are limited to (\d+) days after delivery\.$/, (m) => `ডেলিভারির ${m[1]} দিনের মধ্যে রিটার্ন চাইতে হবে।`],
];

function toBangla(message) {
  const text = String(message || '');
  if (EXACT.has(text)) return EXACT.get(text);
  for (const [pattern, replacement] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return typeof replacement === 'function' ? replacement(match) : replacement;
  }
  return text;
}

const localizeError = (message, locale) => (locale === 'en' ? String(message || '') : toBangla(message));

module.exports = { toBangla, localizeError };
