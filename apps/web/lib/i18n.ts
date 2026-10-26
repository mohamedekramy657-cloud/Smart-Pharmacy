export type Locale = 'ar' | 'en';

const en = {
  appName: 'Smart Pharmacy', tagline: 'Find the nearest pharmacy that has your medicine',
  navFind: 'Find medicine', navAccount: 'My requests & alerts', navNotifications: 'Notifications', navAdmin: 'Admin', navLogin: 'Sign in', navLogout: 'Sign out', navRegister: 'Create account', navBusiness: 'Register a pharmacy or warehouse',
  language: 'العربية', skip: 'Skip to content', demoBanner: 'Development environment — records marked [DEMO] are test data, not real pharmacies or stock.',
  medicine: 'Medicine', medicinePlaceholder: 'Brand, generic name, ingredient or barcode (Arabic or English)', chooseExact: 'Choose the exact product — similar names can have different strengths or forms.',
  change: 'Change', quantity: 'Quantity needed', location: 'Your location', useMyLocation: 'Use my location', chooseArea: 'Choose area', pickOnMap: 'Pick on map',
  geoConsent: 'Your location is used only for this search and is not stored.', geoDenied: 'Location permission was denied. Choose your area or pick a point on the map instead.', geoUnavailable: 'Location is unavailable on this device. Choose your area instead.',
  locating: 'Locating…', locationSet: 'Location set', city: 'City', district: 'District (optional)', selectCity: 'Select a city', anyDistrict: 'Whole city',
  openNowOnly: 'Open now only', search: 'Search', searching: 'Searching…', expand: 'Search farther (up to {km} km)',
  foundWithin: 'Pharmacies with stock within {km} km', noneWithin: 'Searched up to {km} km',
  out_FOUND: 'Available nearby', out_PARTIAL_QUANTITY_ONLY: 'Only partial quantities found', out_NO_MATCHING_STOCK: 'No pharmacy reports this medicine in stock nearby', out_NO_VERIFIED_STOCK: 'No verified pharmacy has this medicine in stock nearby', out_INVENTORY_DATA_UNAVAILABLE: 'Stock information near you is outdated', out_PRODUCT_UNAVAILABLE: 'This product is currently unavailable', out_NOT_PUBLICLY_LISTED: 'Availability for this medicine is not shown online',
  outd_PARTIAL_QUANTITY_ONLY: 'These pharmacies report fewer units than you need. Call to ask about partial supply.', outd_NO_MATCHING_STOCK: 'Try a wider area, check again later, or create an alert.', outd_NO_VERIFIED_STOCK: 'Some unverified pharmacies may list it, but they are not shown until verified.', outd_INVENTORY_DATA_UNAVAILABLE: 'Pharmacies have not updated this stock recently. Call before travelling.', outd_PRODUCT_UNAVAILABLE: 'It may be recalled, suspended or discontinued. Ask your pharmacist about alternatives — never substitute without professional advice.', outd_NOT_PUBLICLY_LISTED: 'Please contact pharmacies directly.',
  serviceUnavailable: 'The search service is temporarily unavailable. Please try again shortly.',
  verified: 'Verified', demo: 'DEMO', km: 'km', openNow: 'Open now', closed: 'Closed now', hoursUnknown: 'Hours not provided', open24: 'Open 24h', delivery: 'Delivery',
  st_AVAILABLE: 'Available', st_LOW_STOCK: 'Low stock', st_RECENT_UNCONFIRMED: 'Recently reported (unconfirmed)', st_INSUFFICIENT_QUANTITY: 'Fewer units than requested', st_STALE: 'Outdated information', st_OUT_OF_STOCK: 'Out of stock', st_TEMPORARILY_UNAVAILABLE: 'Temporarily unavailable',
  updatedAgo: 'Updated {ago}', src_MANUAL: 'by pharmacy staff', src_BARCODE: 'by barcode scan', src_CSV_IMPORT: 'by file import', src_INTEGRATION: 'by pharmacy system', src_RECEIPT: 'on delivery receipt', src_SYSTEM: 'automatically',
  qb_PLENTY: 'In stock', qb_LIMITED: 'Limited stock', qb_NONE: 'None',
  directions: 'Directions', osm: 'OpenStreetMap', call: 'Call', requestConfirm: 'Ask pharmacy to confirm', askHold: 'Ask them to hold it for me', send: 'Send request', requestSent: 'Request sent. Reference {code}. You will be notified when the pharmacy replies.', loginToRequest: 'Sign in to send requests or alerts',
  staleSection: 'Outdated listings (call before going)', incomingSection: 'Expected deliveries (not in stock yet)', incomingNote: 'These pharmacies expect a delivery. It is not available until received.', eta: 'Expected', dd_CONFIRMED: 'Confirmed date', dd_ESTIMATED: 'Estimated', dd_PENDING_CONFIRMATION: 'Pending confirmation', dd_DELAYED: 'Delayed', dd_UNKNOWN: 'Date unknown',
  createAlert: 'Notify me when available nearby', alertCreated: 'Alert created. We will notify you when a verified pharmacy reports stock.', disclaimer: 'Availability is reported by pharmacies and can change. Stock is not reserved unless the pharmacy confirms a hold.',
  loading: 'Loading…', retry: 'Retry', empty: 'Nothing here yet.', errorGeneric: 'Something went wrong.', save: 'Save', cancel: 'Cancel', confirm: 'Confirm', close: 'Close', actions: 'Actions', status: 'Status', reason: 'Reason', note: 'Note', submit: 'Submit',
  email: 'Email', password: 'Password', fullName: 'Full name', totp: 'Authenticator code', signIn: 'Sign in', signingIn: 'Signing in…', noAccount: 'No account?', register: 'Create account', haveAccount: 'Already registered?',
  myRequests: 'My confirmation requests', myAlerts: 'My availability alerts', pickupCode: 'Pickup code', holdUntil: 'Held until', expires: 'Expires', pause: 'Pause', resume: 'Resume', remove: 'Remove', markAllRead: 'Mark all as read',
  orgPending: 'Awaiting administrator verification. You can prepare your profile and inventory; ordering and patient visibility unlock after verification.', orgSuspended: 'This organization is suspended. Data is read-only.',
};

export type MessageKey = keyof typeof en;

const ar: Partial<Record<MessageKey, string>> = {
  appName: 'الصيدلية الذكية', tagline: 'اعثر على أقرب صيدلية يتوفر بها دواؤك',
  navFind: 'ابحث عن دواء', navAccount: 'طلباتي وتنبيهاتي', navNotifications: 'الإشعارات', navAdmin: 'الإدارة', navLogin: 'تسجيل الدخول', navLogout: 'تسجيل الخروج', navRegister: 'إنشاء حساب', navBusiness: 'سجّل صيدلية أو مخزن أدوية',
  language: 'English', skip: 'تخطَّ إلى المحتوى', demoBanner: 'بيئة تطوير — السجلات المعلّمة [DEMO] بيانات تجريبية وليست صيدليات أو مخزونًا حقيقيًا.',
  medicine: 'الدواء', medicinePlaceholder: 'الاسم التجاري أو العلمي أو المادة الفعالة أو الباركود (عربي أو إنجليزي)', chooseExact: 'اختر المنتج بدقة — الأسماء المتشابهة قد تختلف في التركيز أو الشكل الدوائي.',
  change: 'تغيير', quantity: 'الكمية المطلوبة', location: 'موقعك', useMyLocation: 'استخدم موقعي', chooseArea: 'اختر المنطقة', pickOnMap: 'حدد على الخريطة',
  geoConsent: 'يُستخدم موقعك لهذا البحث فقط ولا يتم حفظه.', geoDenied: 'تم رفض إذن الموقع. اختر منطقتك أو حدد نقطة على الخريطة.', geoUnavailable: 'الموقع غير متاح على هذا الجهاز. اختر منطقتك.',
  locating: 'جارٍ تحديد الموقع…', locationSet: 'تم تحديد الموقع', city: 'المدينة', district: 'الحي (اختياري)', selectCity: 'اختر مدينة', anyDistrict: 'كل المدينة',
  openNowOnly: 'المفتوحة الآن فقط', search: 'بحث', searching: 'جارٍ البحث…', expand: 'وسّع البحث (حتى {km} كم)',
  foundWithin: 'صيدليات بها مخزون في نطاق {km} كم', noneWithin: 'تم البحث حتى {km} كم',
  out_FOUND: 'متوفر بالقرب منك', out_PARTIAL_QUANTITY_ONLY: 'توجد كميات جزئية فقط', out_NO_MATCHING_STOCK: 'لا توجد صيدلية قريبة تُبلغ عن توفر هذا الدواء', out_NO_VERIFIED_STOCK: 'لا توجد صيدلية موثقة قريبة بها هذا الدواء', out_INVENTORY_DATA_UNAVAILABLE: 'بيانات المخزون القريبة منك قديمة', out_PRODUCT_UNAVAILABLE: 'هذا المنتج غير متاح حاليًا', out_NOT_PUBLICLY_LISTED: 'لا يتم عرض توفر هذا الدواء عبر الإنترنت',
  outd_PARTIAL_QUANTITY_ONLY: 'هذه الصيدليات لديها كمية أقل من المطلوب. اتصل للسؤال عن توفير جزئي.', outd_NO_MATCHING_STOCK: 'جرّب نطاقًا أوسع أو أعد المحاولة لاحقًا أو أنشئ تنبيهًا.', outd_NO_VERIFIED_STOCK: 'قد تُدرجه صيدليات غير موثقة، لكنها لا تظهر حتى يتم توثيقها.', outd_INVENTORY_DATA_UNAVAILABLE: 'لم تُحدّث الصيدليات هذا المخزون مؤخرًا. اتصل قبل الذهاب.', outd_PRODUCT_UNAVAILABLE: 'قد يكون مسحوبًا أو موقوفًا. اسأل الصيدلي عن البدائل — لا تستبدل الدواء دون استشارة مختص.', outd_NOT_PUBLICLY_LISTED: 'يرجى التواصل مع الصيدليات مباشرة.',
  serviceUnavailable: 'خدمة البحث غير متاحة مؤقتًا. حاول مرة أخرى بعد قليل.',
  verified: 'موثقة', demo: 'تجريبي', km: 'كم', openNow: 'مفتوحة الآن', closed: 'مغلقة الآن', hoursUnknown: 'المواعيد غير محددة', open24: '24 ساعة', delivery: 'توصيل',
  st_AVAILABLE: 'متوفر', st_LOW_STOCK: 'مخزون منخفض', st_RECENT_UNCONFIRMED: 'أُبلغ عنه مؤخرًا (غير مؤكد)', st_INSUFFICIENT_QUANTITY: 'كمية أقل من المطلوب', st_STALE: 'معلومات قديمة', st_OUT_OF_STOCK: 'غير متوفر', st_TEMPORARILY_UNAVAILABLE: 'غير متاح مؤقتًا',
  updatedAgo: 'آخر تحديث {ago}', src_MANUAL: 'بواسطة الصيدلية', src_BARCODE: 'بمسح الباركود', src_CSV_IMPORT: 'باستيراد ملف', src_INTEGRATION: 'من نظام الصيدلية', src_RECEIPT: 'عند استلام شحنة', src_SYSTEM: 'تلقائيًا',
  qb_PLENTY: 'متوفر', qb_LIMITED: 'كمية محدودة', qb_NONE: 'لا يوجد',
  directions: 'الاتجاهات', osm: 'خريطة OSM', call: 'اتصال', requestConfirm: 'اطلب تأكيد التوفر', askHold: 'اطلب حجز الدواء لي', send: 'إرسال الطلب', requestSent: 'تم إرسال الطلب. المرجع {code}. سيتم إشعارك عند رد الصيدلية.', loginToRequest: 'سجّل الدخول لإرسال الطلبات أو التنبيهات',
  staleSection: 'قوائم قديمة (اتصل قبل الذهاب)', incomingSection: 'شحنات متوقعة (غير متوفرة بعد)', incomingNote: 'تنتظر هذه الصيدليات شحنة. لن يتوفر الدواء قبل استلامها.', eta: 'الموعد المتوقع', dd_CONFIRMED: 'موعد مؤكد', dd_ESTIMATED: 'تقديري', dd_PENDING_CONFIRMATION: 'بانتظار التأكيد', dd_DELAYED: 'متأخر', dd_UNKNOWN: 'موعد غير معروف',
  createAlert: 'نبّهني عند توفره بالقرب مني', alertCreated: 'تم إنشاء التنبيه. سنخطرك عندما تُبلغ صيدلية موثقة عن توفره.', disclaimer: 'التوفر تُبلغ عنه الصيدليات وقد يتغير. لا يتم حجز الدواء إلا إذا أكدت الصيدلية الحجز.',
  loading: 'جارٍ التحميل…', retry: 'إعادة المحاولة', empty: 'لا يوجد شيء بعد.', errorGeneric: 'حدث خطأ ما.', save: 'حفظ', cancel: 'إلغاء', confirm: 'تأكيد', close: 'إغلاق', actions: 'إجراءات', status: 'الحالة', reason: 'السبب', note: 'ملاحظة', submit: 'إرسال',
  email: 'البريد الإلكتروني', password: 'كلمة المرور', fullName: 'الاسم الكامل', totp: 'رمز المصادقة', signIn: 'دخول', signingIn: 'جارٍ الدخول…', noAccount: 'ليس لديك حساب؟', register: 'إنشاء حساب', haveAccount: 'لديك حساب بالفعل؟',
  myRequests: 'طلبات تأكيد التوفر', myAlerts: 'تنبيهات التوفر', pickupCode: 'رمز الاستلام', holdUntil: 'محجوز حتى', expires: 'ينتهي', pause: 'إيقاف مؤقت', resume: 'استئناف', remove: 'حذف', markAllRead: 'تحديد الكل كمقروء',
  orgPending: 'بانتظار توثيق الإدارة. يمكنك تجهيز الملف والمخزون؛ تُتاح الطلبات والظهور للمرضى بعد التوثيق.', orgSuspended: 'هذه المنشأة موقوفة. البيانات للقراءة فقط.',
};

export const dictionaries: Record<Locale, Partial<Record<MessageKey, string>>> = { en, ar };

export function translate(locale: Locale, key: MessageKey | string, vars?: Record<string, string | number>): string {
  const raw = dictionaries[locale][key as MessageKey] ?? en[key as MessageKey] ?? String(key);
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : raw;
}
