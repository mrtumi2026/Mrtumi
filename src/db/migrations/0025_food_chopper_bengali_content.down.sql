UPDATE `products`
SET `description_bn` = NULL, `short_desc_bn` = NULL
WHERE `id` = 1 OR `slug` = 'food-chopper';
