'use strict';

/**
 * Idempotently seed the bilingual storefront category taxonomy into MySQL.
 * This script does not run migrations; the schema must already be migrated.
 * Usage: npm run seed:categories (with DB_CLIENT=mysql and MySQL credentials set).
 */
const mysql = require('../src/db/mysqlPool');
const { env } = require('../src/config/env');

const CATEGORY_SEEDS = Object.freeze([
  { icon: '📱', slug: 'mobiles-and-tablets', nameEn: 'Mobiles & Tablets', nameBn: 'মোবাইল ও ট্যাবলেট', subcategories: [['Smartphones', 'স্মার্টফোন'], ['Tablets', 'ট্যাবলেট'], ['Mobile Covers & Cases', 'মোবাইল কভার ও কেস'], ['Chargers & Cables', 'চার্জার ও কেবল'], ['Power Banks', 'পাওয়ার ব্যাংক']] },
  { icon: '💻', slug: 'computers-and-electronics', nameEn: 'Computers & Electronics', nameBn: 'কম্পিউটার ও ইলেকট্রনিক্স', subcategories: [['Laptops & PCs', 'ল্যাপটপ ও পিসি'], ['Monitors', 'মনিটর'], ['TV & Audio', 'টিভি ও অডিও'], ['Cameras', 'ক্যামেরা'], ['Headphones & Earphones', 'হেডফোন ও ইয়ারফোন'], ['Speakers', 'স্পিকার'], ['Gaming Accessories', 'গেমিং অ্যাকসেসরিজ']] },
  { icon: '👗', slug: 'womens-fashion', nameEn: "Women's Fashion", nameBn: 'নারীদের ফ্যাশন', subcategories: [['Sarees & Salwar Kameez', 'শাড়ি ও সালোয়ার কামিজ'], ['Kurtis & Tops', 'কুর্তি ও টপস'], ['Western Wear', 'ওয়েস্টার্ন পোশাক'], ["Women's Shoes", 'নারীদের জুতা'], ["Women's Bags", 'নারীদের ব্যাগ']] },
  { icon: '👔', slug: 'mens-fashion', nameEn: "Men's Fashion", nameBn: 'পুরুষদের ফ্যাশন', subcategories: [['Shirts & T-Shirts', 'শার্ট ও টি-শার্ট'], ['Pants & Jeans', 'প্যান্ট ও জিন্স'], ['Panjabi & Pajamas', 'পাঞ্জাবি ও পায়জামা'], ["Men's Shoes", 'পুরুষদের জুতা'], ["Men's Watches & Accessories", 'পুরুষদের ঘড়ি ও অ্যাকসেসরিজ']] },
  { icon: '⌚', slug: 'watches-bags-and-jewellery', nameEn: 'Watches, Bags & Jewellery', nameBn: 'ঘড়ি, ব্যাগ ও জুয়েলারি', subcategories: [['Wrist Watches', 'হাতঘড়ি'], ['Sunglasses', 'সানগ্লাস'], ['Travel Bags & Backpacks', 'ট্রাভেল ব্যাগ ও ব্যাকপ্যাক'], ['Fashion Jewellery', 'ফ্যাশন জুয়েলারি'], ['Wallets & Purses', 'ওয়ালেট ও পার্স']] },
  { icon: '🥬', slug: 'fruits-and-vegetables', nameEn: 'Fruits & Vegetables', nameBn: 'ফলমূল ও শাকসবজি', subcategories: [['Fresh Fruits', 'তাজা ফল'], ['Fresh Vegetables', 'তাজা সবজি'], ['Leafy Greens', 'শাকপাতা'], ['Organic Produce', 'জৈব পণ্য']] },
  { icon: '🥩', slug: 'meat-fish-and-eggs', nameEn: 'Meat, Fish & Eggs', nameBn: 'মাছ, মাংস ও ডিম', subcategories: [['Fresh Fish', 'তাজা মাছ'], ['Meat (Beef, Mutton)', 'মাংস (গরু, খাসি)'], ['Chicken', 'মুরগি'], ['Eggs', 'ডিম'], ['Dried Fish', 'শুঁটকি মাছ'], ['Processed Meat', 'প্রক্রিয়াজাত মাংস']] },
  { icon: '🍚', slug: 'rice-dal-and-cooking', nameEn: 'Rice, Dal & Cooking', nameBn: 'চাল, ডাল ও রান্নার উপাদান', subcategories: [['Rice', 'চাল'], ['Flour & Atta', 'আটা ও ময়দা'], ['Lentils (Dal)', 'ডাল'], ['Oil & Ghee', 'তেল ও ঘি'], ['Spices', 'মসলা'], ['Salt & Sugar', 'লবণ ও চিনি']] },
  { icon: '🥛', slug: 'dairy-and-breakfast', nameEn: 'Dairy & Breakfast', nameBn: 'দুধ ও সকালের নাস্তা', subcategories: [['Milk & Yogurt', 'দুধ ও দই'], ['Butter & Cheese', 'মাখন ও পনির'], ['Bread & Bakery', 'রুটি ও বেকারি'], ['Cereals & Oats', 'সিরিয়াল ও ওটস'], ['Tea & Coffee', 'চা ও কফি'], ['Jam & Honey', 'জ্যাম ও মধু']] },
  { icon: '🍪', slug: 'snacks-and-beverages', nameEn: 'Snacks & Beverages', nameBn: 'স্ন্যাক্স ও পানীয়', subcategories: [['Chips & Chanachur', 'চিপস ও চানাচুর'], ['Biscuits & Cookies', 'বিস্কুট ও কুকিজ'], ['Chocolates & Candies', 'চকলেট ও ক্যান্ডি'], ['Noodles & Pasta', 'নুডলস ও পাস্তা'], ['Cold Drinks & Juices', 'ঠান্ডা পানীয় ও জুস']] },
  { icon: '🍜', slug: 'frozen-and-ready-to-eat', nameEn: 'Frozen & Ready to Eat', nameBn: 'ফ্রোজেন ও রেডি ফুড', subcategories: [['Frozen Paratha & Snacks', 'হিমায়িত পরোটা ও নাস্তা'], ['Ice Cream', 'আইসক্রিম'], ['Canned Food', 'ক্যানজাত খাবার'], ['Ready Mix', 'রেডি মিক্স']] },
  { icon: '💄', slug: 'health-and-beauty', nameEn: 'Health & Beauty', nameBn: 'স্বাস্থ্য ও রূপচর্চা', subcategories: [['Skin Care', 'ত্বকের যত্ন'], ['Hair Care', 'চুলের যত্ন'], ['Makeup & Cosmetics', 'মেকআপ ও প্রসাধনী'], ['Personal Care', 'ব্যক্তিগত পরিচর্যা'], ['Pharmacy & Supplements', 'ফার্মেসি ও সাপ্লিমেন্ট']] },
  { icon: '👶', slug: 'baby-and-kids', nameEn: 'Baby & Kids', nameBn: 'শিশু ও বাচ্চাদের সামগ্রী', subcategories: [['Diapers & Wipes', 'ডায়াপার ও ওয়াইপস'], ['Baby Food & Formula', 'শিশুখাদ্য ও ফর্মুলা'], ['Baby Skin Care', 'শিশুর ত্বকের যত্ন'], ['Toys & Games', 'খেলনা ও গেমস'], ["Kids' Clothing", 'শিশুদের পোশাক']] },
  { icon: '🏠', slug: 'home-and-kitchen', nameEn: 'Home & Kitchen', nameBn: 'হোম ও কিচেন', subcategories: [['Home Appliances', 'গৃহস্থালি যন্ত্রপাতি'], ['Kitchenware & Cookware', 'রান্নাঘরের বাসন ও সরঞ্জাম'], ['Furniture', 'আসবাবপত্র'], ['Bedding & Curtains', 'বিছানার সামগ্রী ও পর্দা'], ['Home Decor & Lighting', 'ঘর সাজানোর সামগ্রী ও আলো']] },
  { icon: '🧹', slug: 'household-and-others', nameEn: 'Household & Others', nameBn: 'হাউসহোল্ড ও অন্যান্য', subcategories: [['Cleaning Supplies', 'পরিষ্কারের সামগ্রী'], ['Laundry Care', 'কাপড় ধোয়ার সামগ্রী'], ['Pest Control', 'পোকামাকড় নিয়ন্ত্রণ'], ['Pet Supplies', 'পোষা প্রাণীর সামগ্রী'], ['Stationery & Office', 'স্টেশনারি ও অফিস সামগ্রী'], ['Sports & Fitness', 'খেলাধুলা ও ফিটনেস']] },
]);

function slugifyEnglish(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function seedCategories({ transaction = mysql.withTransaction, seeds = CATEGORY_SEEDS, dbClient = env.db.client } = {}) {
  if (dbClient !== 'mysql') {
    throw new Error('Category seeding requires DB_CLIENT=mysql. No local SQLite writes were attempted.');
  }

  return transaction(async (tx) => {
    let subcategoryCount = 0;
    for (const [index, category] of seeds.entries()) {
      await tx.execute(
        'INSERT INTO `categories` (`name_bn`,`name_en`,`slug`,`icon`,`front_view`,`sort_order`,`status`) VALUES (?,?,?,?,1,?,1) ON DUPLICATE KEY UPDATE `name_bn`=VALUES(`name_bn`),`name_en`=VALUES(`name_en`),`icon`=VALUES(`icon`),`front_view`=1,`sort_order`=VALUES(`sort_order`),`status`=1',
        [category.nameBn, category.nameEn, category.slug, category.icon, index + 1]
      );
      const savedCategory = await tx.queryOne('SELECT `id` FROM `categories` WHERE `slug`=? LIMIT 1', [category.slug]);
      if (!savedCategory) throw new Error(`Category upsert did not produce a row for slug ${category.slug}.`);

      for (const [nameEn, nameBn] of category.subcategories) {
        const slug = `${category.slug}-${slugifyEnglish(nameEn)}`;
        await tx.execute(
          'INSERT INTO `subcategories` (`category_id`,`name_bn`,`name_en`,`slug`,`status`) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE `category_id`=VALUES(`category_id`),`name_bn`=VALUES(`name_bn`),`name_en`=VALUES(`name_en`),`status`=1',
          [savedCategory.id, nameBn, nameEn, slug]
        );
        subcategoryCount += 1;
      }
    }
    return { categoryCount: seeds.length, subcategoryCount };
  });
}

async function main() {
  const result = await seedCategories();
  console.log(`Seeded ${result.categoryCount} categories and ${result.subcategoryCount} subcategories into MySQL.`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Category seed failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => mysql.closePool());
}

module.exports = { CATEGORY_SEEDS, seedCategories, slugifyEnglish };
