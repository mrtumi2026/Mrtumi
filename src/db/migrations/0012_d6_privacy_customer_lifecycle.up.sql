-- D6: privacy policy versions, consent evidence, customer privacy requests and manual retention review.
ALTER TABLE `customers`
  ADD COLUMN `email_verified_at` DATETIME DEFAULT NULL AFTER `email`,
  ADD COLUMN `phone_verified_at` DATETIME DEFAULT NULL AFTER `email_verified_at`;

CREATE TABLE IF NOT EXISTS `privacy_policy_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `version` VARCHAR(32) NOT NULL,
  `title_bn` VARCHAR(255) NOT NULL,
  `title_en` VARCHAR(255) NOT NULL,
  `content_bn` LONGTEXT NOT NULL,
  `content_en` LONGTEXT NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'draft',
  `legal_review_status` VARCHAR(32) NOT NULL DEFAULT 'not_reviewed',
  `legal_review_note` VARCHAR(500) NOT NULL DEFAULT '',
  `published_at` DATETIME DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_privacy_policy_version` (`version`),
  KEY `idx_privacy_policy_status_published` (`status`,`published_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `privacy_policy_publication_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `policy_version_id` BIGINT UNSIGNED NOT NULL,
  `action` VARCHAR(24) NOT NULL,
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `note` VARCHAR(500) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_privacy_policy_publication` (`policy_version_id`,`created_at`),
  CONSTRAINT `fk_privacy_policy_publication_version` FOREIGN KEY (`policy_version_id`) REFERENCES `privacy_policy_versions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `privacy_consent_options` (
  `consent_key` VARCHAR(48) NOT NULL,
  `label_bn` VARCHAR(120) NOT NULL,
  `label_en` VARCHAR(120) NOT NULL,
  `description_bn` VARCHAR(500) NOT NULL,
  `description_en` VARCHAR(500) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`consent_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `privacy_consent_options` (`consent_key`,`label_bn`,`label_en`,`description_bn`,`description_en`,`enabled`) VALUES
 ('marketing','ঐচ্ছিক বিপণন বার্তা','Optional marketing messages','পণ্য/অফার সংক্রান্ত ঐচ্ছিক বার্তা। সম্মতি না দিলেও অর্ডার প্রক্রিয়া চলবে।','Optional product/offer messages. Orders continue if you decline. ',1),
 ('analytics','ঐচ্ছিক বিশ্লেষণ','Optional analytics','ঐচ্ছিক সাইট বিশ্লেষণ; সম্মতি না দিলেও অর্ডার প্রক্রিয়া চলবে।','Optional site analytics; orders continue if you decline.',1)
ON DUPLICATE KEY UPDATE `consent_key`=`consent_key`;

CREATE TABLE IF NOT EXISTS `customer_policy_acceptances` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `policy_version` VARCHAR(32) NOT NULL,
  `accepted_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `source` VARCHAR(32) NOT NULL DEFAULT 'registration',
  `evidence_json` LONGTEXT DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_policy_acceptance_customer_time` (`customer_id`,`accepted_at`),
  CONSTRAINT `fk_policy_acceptance_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_consent_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `consent_key` VARCHAR(48) NOT NULL,
  `policy_version` VARCHAR(32) NOT NULL,
  `action` VARCHAR(16) NOT NULL,
  `evidence_json` LONGTEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customer_consent_history` (`customer_id`,`consent_key`,`created_at`),
  CONSTRAINT `fk_customer_consent_event_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_consent_current` (
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `consent_key` VARCHAR(48) NOT NULL,
  `policy_version` VARCHAR(32) NOT NULL,
  `granted` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`customer_id`,`consent_key`),
  CONSTRAINT `fk_customer_consent_current_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_recovery_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `channel` VARCHAR(16) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `consumed_at` DATETIME DEFAULT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer_recovery_token_hash` (`token_hash`),
  KEY `idx_customer_recovery_expiry` (`customer_id`,`expires_at`,`consumed_at`),
  CONSTRAINT `fk_customer_recovery_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `privacy_retention_settings` (
  `category_key` VARCHAR(64) NOT NULL,
  `retention_days` INT UNSIGNED DEFAULT NULL,
  `manual_review_required` TINYINT(1) NOT NULL DEFAULT 1,
  `notes` VARCHAR(500) NOT NULL DEFAULT '',
  `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`category_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_privacy_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `request_type` VARCHAR(32) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `requested_data_json` LONGTEXT DEFAULT NULL,
  `customer_message` VARCHAR(1000) NOT NULL DEFAULT '',
  `decision_reason` VARCHAR(1000) NOT NULL DEFAULT '',
  `reviewer_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `reviewed_at` DATETIME DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_privacy_requests_customer` (`customer_id`,`created_at`),
  KEY `idx_privacy_requests_review` (`status`,`request_type`,`created_at`),
  CONSTRAINT `fk_privacy_request_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_privacy_request_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` BIGINT UNSIGNED NOT NULL,
  `actor_type` VARCHAR(24) NOT NULL,
  `actor_id` BIGINT UNSIGNED DEFAULT NULL,
  `from_status` VARCHAR(24) NOT NULL DEFAULT '',
  `to_status` VARCHAR(24) NOT NULL,
  `reason` VARCHAR(1000) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_privacy_request_event_history` (`request_id`,`created_at`),
  CONSTRAINT `fk_privacy_request_event_request` FOREIGN KEY (`request_id`) REFERENCES `customer_privacy_requests` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `privacy_policy_versions` (`version`,`title_bn`,`title_en`,`content_bn`,`content_en`,`status`,`legal_review_status`,`legal_review_note`,`published_at`)
VALUES (
 '1.0',
 'গোপনীয়তা নীতি',
 'Privacy Policy',
 'এই নথি Mr. Tumi Grocery & Gift-এর তথ্য ব্যবহারের বর্তমান সারাংশ। এটি আইনি পরামর্শ বা আইনগত সম্মতির দাবি নয় এবং যোগ্য আইনজীবীর পর্যালোচনা বাকি।\n\n১. কী তথ্য: অ্যাকাউন্টে নাম, মোবাইল নম্বর, ঐচ্ছিক ইমেইল, সংরক্ষিত ঠিকানা; অর্ডারে পণ্য, পরিমাণ, ডেলিভারি যোগাযোগ, অর্ডার/পেমেন্ট অবস্থা; সহায়তার বার্তা; নিরাপত্তা ও সম্মতি/নীতি-সংস্করণের রেকর্ড। পেমেন্টের পূর্ণ কার্ড/মোবাইল আর্থিক গোপন তথ্য এখানে চাওয়া উচিত নয়।\n\n২. উদ্দেশ্য: অ্যাকাউন্ট পরিচালনা, অর্ডার ও ডেলিভারি সম্পন্ন, গ্রাহক সহায়তা, নিরাপত্তা/প্রতারণা প্রতিরোধ, হিসাব ও বিরোধ নিষ্পত্তি, এবং গ্রাহকের ঐচ্ছিক সম্মতি থাকলে সীমিত বিপণন/বিশ্লেষণ। ঐচ্ছিক বিপণন সম্মতি প্রত্যাহার করলেও অর্ডার প্রক্রিয়াকরণ বন্ধ হবে না।\n\n৩. অর্ডার ও ডেলিভারি: অর্ডার গ্রহণ, প্যাকিং, ডেলিভারি, অবস্থা জানানো, রিটার্ন/অভিযোগ সমাধান এবং সংশ্লিষ্ট প্রমাণের জন্য প্রয়োজনীয় তথ্য ব্যবহার হতে পারে।\n\n৪. সহায়তা: আপনার প্রশ্ন, অভিযোগ, সংশোধন, গোপনীয়তা অনুরোধ ও অ্যাকাউন্ট নিরাপত্তা যাচাইয়ের জন্য যোগাযোগের তথ্য ব্যবহার হতে পারে।\n\n৫. পেমেন্ট/আর্থিক রেকর্ড: পেমেন্ট অবস্থা, লেনদেন রেফারেন্স, ইনভয়েস ও হিসাব-সংক্রান্ত প্রমাণ সংরক্ষণ হতে পারে। প্রযোজ্য রেকর্ড আইন/বিরোধ/হিসাবের কারণে সংরক্ষিত থাকতে পারে; মুছে ফেলার অনুরোধে এগুলো স্বয়ংক্রিয়ভাবে মুছে যাবে না।\n\n৬. শেয়ারিং: কাজ সম্পন্নের জন্য প্রয়োজনীয় ন্যূনতম তথ্য অনুমোদিত ডেলিভারি/কুরিয়ার, পেমেন্ট সেবা, হোস্টিং/সিস্টেম অপারেটর বা আইনসম্মত কর্তৃপক্ষের সঙ্গে শেয়ার হতে পারে। প্রতিটি প্রদানকারীর চুক্তি/সুরক্ষা যাচাই চলমান এবং এই নথি কোনো নিশ্চয়তা নয়।\n\n৭. আপনার অধিকার: নিজের অ্যাকাউন্ট/অনুরোধের অবস্থা দেখা, তথ্য সংশোধনের অনুরোধ, অ্যাকাউন্ট মুছে ফেলার অনুরোধ, ঐচ্ছিক সম্মতি প্রত্যাহার এবং অভিযোগ জানানো। অনুরোধ যাচাই ও মানবিক পর্যালোচনার পরে কার্যকর হতে পারে।\n\n৮. সংরক্ষণ/মুছে ফেলা: কোনো স্বয়ংক্রিয় ঐতিহাসিক purge নেই। সংরক্ষণকাল ডেটা-শ্রেণি অনুযায়ী প্রশাসনিকভাবে কনফিগারযোগ্য; আইন/হিসাব/অর্ডার প্রমাণে প্রয়োজনীয় তথ্য অক্ষত থাকতে পারে। অনুমোদিত পর্যালোচনা ছাড়া অ্যাকাউন্ট মুছে বা পরিচয়-তথ্য বেনামী করা হবে না।\n\n৯. সম্মতি: অর্ডারের জন্য প্রয়োজনীয় প্রক্রিয়াকরণ ঐচ্ছিক বিপণন/বিশ্লেষণ সম্মতি থেকে আলাদা। সম্মতি প্রত্যাহার ভবিষ্যৎ ঐচ্ছিক ব্যবহার বন্ধ করে; পূর্বের সম্মতি-প্রমাণ অডিটের জন্য রাখা হতে পারে।\n\n১০. যোগাযোগ/অভিযোগ: Privacy request হিসেবে /customer/account/privacy-requests এ অনুরোধ জমা দিন অথবা সাইটের Contact পৃষ্ঠার মাধ্যমে জানান। নীতি সংস্করণ/কার্যকর তারিখ দেখুন।',
 'This document summarizes current information practices of Mr. Tumi Grocery & Gift. It is not legal advice and does not claim legal compliance; qualified legal review is outstanding.\n\n1. Data collected: account name, mobile number and optional email; saved delivery addresses; order items, quantities, delivery contact/details and order/payment status; support messages; and security, consent and policy-version evidence. Full card or mobile-financial credentials should not be requested here.\n\n2. Purposes: account administration, order and delivery processing, customer support, security/fraud prevention, accounting and dispute evidence, and limited optional marketing/analytics only where the customer has opted in. Withdrawing optional marketing consent does not block essential order processing.\n\n3. Orders and delivery: necessary data may be used to accept and fulfill orders, arrange delivery, communicate status, resolve returns/complaints and preserve relevant evidence.\n\n4. Support: contact data may be used to answer questions, complaints, correction/deletion requests and account-security concerns.\n\n5. Payment and financial records: payment status, transaction references, invoices and accounting evidence may be retained. Records required for applicable legal, accounting or dispute purposes may remain after an account-deletion request; they are not automatically erased.\n\n6. Sharing: minimum necessary information may be shared with authorized delivery/courier and payment providers, hosting/system operators, or lawful authorities to perform the requested service or meet obligations. Provider contracts and safeguards require review; this statement is not a guarantee.\n\n7. Customer rights: view own account/request status, request correction, request account deletion, withdraw optional consent, and submit a complaint. Requests are verified and may require human review before action.\n\n8. Retention/deletion: no automatic historical purge is performed. Retention periods are configurable by data category; order, invoice, accounting or legally required evidence may be preserved. Identity data is not anonymized and accounts are not deleted without authorized review.\n\n9. Consent: processing essential to an order is distinct from optional marketing/analytics consent. Withdrawal stops future optional use; prior consent evidence may be retained for audit.\n\n10. Contact/complaints: submit a privacy request at /customer/account/privacy-requests or use the site Contact page. The published version and effective date are shown with this policy.',
 'published','not_reviewed','Initial operational copy; qualified legal review is outstanding. Not a compliance certification.',CURRENT_TIMESTAMP
) ON DUPLICATE KEY UPDATE `version`=`version`;

INSERT INTO `privacy_policy_publication_history` (`policy_version_id`,`action`,`note`)
SELECT p.`id`,'published','Initial operational policy; legal review outstanding.' FROM `privacy_policy_versions` p
WHERE p.`version`='1.0' AND NOT EXISTS (SELECT 1 FROM `privacy_policy_publication_history` h WHERE h.`policy_version_id`=p.`id` AND h.`action`='published');

INSERT INTO `privacy_retention_settings` (`category_key`,`retention_days`,`manual_review_required`,`notes`) VALUES
 ('customer_account',NULL,1,'No automatic deletion; account removal requires manual review and explicit anonymization approval.'),
 ('order_and_invoice_evidence',NULL,1,'Preserve order/invoice history until an authorized retention policy is approved.'),
 ('payment_and_financial_evidence',NULL,1,'Preserve financial records; no automatic purge.'),
 ('consent_evidence',NULL,1,'Append-only consent evidence; no automatic purge.'),
 ('privacy_request_evidence',NULL,1,'Append-only request/reviewer evidence; no automatic purge.'),
 ('security_and_recovery_logs',NULL,1,'No automatic purge until approved category schedule exists.')
ON DUPLICATE KEY UPDATE `category_key`=`category_key`;

INSERT INTO `permissions` (`name`,`module`,`description`) VALUES
 ('privacy.manage','privacy','Manage privacy policy versions, consent configuration and retention periods'),
 ('privacy.review','privacy','Review customer privacy requests and approve personal-data actions')
ON DUPLICATE KEY UPDATE `module`=VALUES(`module`),`description`=VALUES(`description`);
