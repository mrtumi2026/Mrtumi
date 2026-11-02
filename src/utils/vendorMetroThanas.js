'use strict';

// Supplemental municipal / police-station areas for city addresses. They are
// intentionally separate from the source's 494 official upazila records.
const METRO_THANA_NAMES = Object.freeze({
  Dhaka: Object.freeze([
    'Dhanmondi','Mirpur','Uttara','Gulshan','Banani','Mohammadpur','Badda','Tejgaon','Motijheel','Khilgaon','Jatrabari','Rampura','Malibagh','Mogbazar','New Market','Lalbagh','Shahbagh','Paltan','Bashundhara','Khilkhet','Cantonment','Hazaribagh','Kamrangirchar','Demra','Sutrapur','Wari','Kafrul','Pallabi','Adabor','Sher-e-Bangla Nagar','Bhatara','Turag','Dakshinkhan','Uttarkhan',
  ]),
  Chattogram: Object.freeze([
    'Kotwali','Double Mooring','Panchlaish','Chandgaon','Halishahar','Pahartali','Khulshi','Bayazid Bostami','Patenga','Bakalia','Chawkbazar','Sadarghat','EPZ','Akbar Shah','Bandar','Karnaphuli',
  ]),
  Sylhet: Object.freeze([
    'Kotwali','Jalalabad','Airport','Shahporan','South Surma','Moglabazar','Khadimnagar',
  ]),
  Rajshahi: Object.freeze(['Boalia','Rajpara','Shah Makhdum','Motihar','Kashiadanga']),
  Khulna: Object.freeze(['Khulna Sadar','Sonadanga','Khalishpur','Daulatpur','Khan Jahan Ali','Harintana','Labanchara','Aranghata']),
  Barisal: Object.freeze(['Kotwali','Kaunia','Bandar','Airport']),
  Rangpur: Object.freeze(['Kotwali','Haragach','Tajhat','Mahiganj','Hajirhat']),
  Gazipur: Object.freeze(['Joydebpur','Tongi East','Tongi West','Konabari','Kashimpur','Basan','Gacha']),
  Narayanganj: Object.freeze(['Narayanganj Sadar','Fatullah','Siddhirganj','Bandar']),
  Comilla: Object.freeze(['Kotwali','Sadar South']),
});

const BANGLA_LABELS = Object.freeze({
  Dhanmondi:'ধানমন্ডি',Mirpur:'মিরপুর',Uttara:'উত্তরা',Gulshan:'গুলশান',Banani:'বনানী',Mohammadpur:'মোহাম্মদপুর',Badda:'বাড্ডা',Tejgaon:'তেজগাঁও',Motijheel:'মতিঝিল',Khilgaon:'খিলগাঁও',Jatrabari:'যাত্রাবাড়ী',Rampura:'রামপুরা',Malibagh:'মালিবাগ',Mogbazar:'মগবাজার','New Market':'নিউ মার্কেট',Lalbagh:'লালবাগ',Shahbagh:'শাহবাগ',Paltan:'পল্টন',Bashundhara:'বসুন্ধরা',Khilkhet:'খিলক্ষেত',Cantonment:'ক্যান্টনমেন্ট',Hazaribagh:'হাজারীবাগ',Kamrangirchar:'কামরাঙ্গীরচর',Demra:'ডেমরা',Sutrapur:'সূত্রাপুর',Wari:'ওয়ারী',Kafrul:'কাফরুল',Pallabi:'পল্লবী',Adabor:'আদাবর','Sher-e-Bangla Nagar':'শেরেবাংলা নগর',Bhatara:'ভাটারা',Turag:'তুরাগ',Dakshinkhan:'দক্ষিণখান',Uttarkhan:'উত্তরখান',Kotwali:'কোতোয়ালি','Double Mooring':'ডাবলমুরিং',Panchlaish:'পাঁচলাইশ',Chandgaon:'চান্দগাঁও',Halishahar:'হালিশহর',Pahartali:'পাহাড়তলী',Khulshi:'খুলশী','Bayazid Bostami':'বায়েজিদ বোস্তামী',Patenga:'পতেঙ্গা',Bakalia:'বাকলিয়া',Chawkbazar:'চকবাজার',Sadarghat:'সদরঘাট',EPZ:'ইপিজেড','Akbar Shah':'আকবরশাহ',Bandar:'বন্দর',Karnaphuli:'কর্ণফুলী',Jalalabad:'জালালাবাদ',Airport:'এয়ারপোর্ট',Shahporan:'শাহপরাণ','South Surma':'দক্ষিণ সুরমা',Moglabazar:'মোগলাবাজার',Khadimnagar:'খাদিমনগর',Boalia:'বোয়ালিয়া',Rajpara:'রাজপাড়া','Shah Makhdum':'শাহ মখদুম',Motihar:'মতিহার',Kashiadanga:'কাশিয়াডাঙ্গা',Sonadanga:'সোনাডাঙ্গা',Khalishpur:'খালিশপুর',Daulatpur:'দৌলতপুর','Khan Jahan Ali':'খান জাহান আলী',Harintana:'হরিণটানা',Labanchara:'লবণচরা',Aranghata:'আড়ংঘাটা',Kaunia:'কাউনিয়া',Haragach:'হারাগাছ',Tajhat:'তাজহাট',Mahiganj:'মাহিগঞ্জ',Hajirhat:'হাজীরহাট',Joydebpur:'জয়দেবপুর','Tongi East':'টঙ্গী পূর্ব','Tongi West':'টঙ্গী পশ্চিম',Konabari:'কোনাবাড়ী',Kashimpur:'কাশিমপুর',Basan:'বাসন',Gacha:'গাছা',Fatullah:'ফতুল্লা',Siddhirganj:'সিদ্ধিরগঞ্জ','Sadar South':'সদর দক্ষিণ',
});

function getMetropolitanThanas(district) {
  return (METRO_THANA_NAMES[String(district || '').trim()] || []).map((name) => ({
    name,
    nameBn: BANGLA_LABELS[name] || name,
  }));
}

module.exports = { getMetropolitanThanas, METRO_THANA_NAMES };
