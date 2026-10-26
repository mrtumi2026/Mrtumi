-- Persist a canonical request digest so a retried checkout key cannot be replayed
-- with altered contact, delivery, coupon, or cart details.
ALTER TABLE `orders`
  ADD COLUMN `checkout_request_hash` CHAR(64) DEFAULT NULL AFTER `idempotency_key`;
