-- Permanent URL repair for legacy slugs corrupted by Bengali-to-ASCII encoding.
UPDATE `products`
SET `slug` = CONCAT('product-', `id`, '-', LOWER(COALESCE(NULLIF(`sku`,''), SUBSTRING(MD5(`id`), 1, 6))))
WHERE `slug` LIKE '%?%' OR `slug` = '' OR `slug` IS NULL;

-- Repair any other malformed URL segment and prevent unsafe SKU punctuation from re-entering the slug.
UPDATE `products`
SET `slug` = CONCAT('product-', `id`, '-', LOWER(CASE
  WHEN `sku` REGEXP '^[A-Za-z0-9-]+$' THEN `sku`
  ELSE SUBSTRING(MD5(`id`), 1, 6)
END))
WHERE `slug` NOT REGEXP '^[A-Za-z0-9-]+$';
