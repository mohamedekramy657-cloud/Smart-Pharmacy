/** Bilingual notification templates. Data values are inserted as plain text (UI escapes them). */
type D = Record<string, unknown>;
type T = { en: (d: D) => [string, string]; ar: (d: D) => [string, string] };

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export const TEMPLATES: Record<string, T> = {
  LOW_STOCK: {
    en: (d) => ['Low stock', `${s(d.medicine)} is low: ${s(d.available)} available (threshold ${s(d.threshold)}).`],
    ar: (d) => ['مخزون منخفض', `${s(d.medicine)} منخفض: المتاح ${s(d.available)} (الحد ${s(d.threshold)}).`],
  },
  PO_SUBMITTED: {
    en: (d) => ['New purchase order', `Order ${s(d.orderNumber)} received from ${s(d.pharmacy)}.`],
    ar: (d) => ['طلب شراء جديد', `تم استلام الطلب ${s(d.orderNumber)} من ${s(d.pharmacy)}.`],
  },
  PO_DECIDED: {
    en: (d) => [`Order ${s(d.status).toLowerCase().replace('_', ' ')}`, `Order ${s(d.orderNumber)} was ${s(d.status).toLowerCase().replace('_', ' ')} by ${s(d.warehouse)}.`],
    ar: (d) => ['تحديث طلب الشراء', `تم تحديث حالة الطلب ${s(d.orderNumber)} إلى ${s(d.statusAr)} بواسطة ${s(d.warehouse)}.`],
  },
  PO_CANCELLED: {
    en: (d) => ['Order cancelled', `Order ${s(d.orderNumber)} was cancelled. Reason: ${s(d.reason)}`],
    ar: (d) => ['تم إلغاء الطلب', `تم إلغاء الطلب ${s(d.orderNumber)}. السبب: ${s(d.reason)}`],
  },
  SHIPMENT_DISPATCHED: {
    en: (d) => ['Shipment dispatched', `Shipment ${s(d.shipmentNumber)} for order ${s(d.orderNumber)} was dispatched. ETA: ${s(d.eta) || 'unknown'} (${s(d.confidence)}).`],
    ar: (d) => ['تم شحن الطلب', `تم إرسال الشحنة ${s(d.shipmentNumber)} للطلب ${s(d.orderNumber)}. الموعد المتوقع: ${s(d.eta) || 'غير معروف'}.`],
  },
  SHIPMENT_STATUS: {
    en: (d) => ['Shipment update', `Shipment ${s(d.shipmentNumber)} is now ${s(d.status)}.`],
    ar: (d) => ['تحديث الشحنة', `حالة الشحنة ${s(d.shipmentNumber)} الآن: ${s(d.status)}.`],
  },
  SHIPMENT_DELAYED: {
    en: (d) => ['Delivery delayed', `Shipment ${s(d.shipmentNumber)} is delayed. New ETA: ${s(d.eta) || 'unknown'}. ${s(d.reason)}`],
    ar: (d) => ['تأخير في التوصيل', `الشحنة ${s(d.shipmentNumber)} متأخرة. الموعد الجديد: ${s(d.eta) || 'غير معروف'}. ${s(d.reason)}`],
  },
  SHIPMENT_OVERDUE: {
    en: (d) => ['Shipment overdue', `Shipment ${s(d.shipmentNumber)} passed its estimated delivery time (${s(d.eta)}).`],
    ar: (d) => ['شحنة متأخرة', `تجاوزت الشحنة ${s(d.shipmentNumber)} موعد التسليم المتوقع (${s(d.eta)}).`],
  },
  SHIPMENT_RECEIVED: {
    en: (d) => ['Shipment received', `Shipment ${s(d.shipmentNumber)} was received by ${s(d.pharmacy)}. Discrepancies: ${s(d.discrepancies)}.`],
    ar: (d) => ['تم استلام الشحنة', `استلمت ${s(d.pharmacy)} الشحنة ${s(d.shipmentNumber)}. الفروقات: ${s(d.discrepancies)}.`],
  },
  DISCREPANCY_UPDATED: {
    en: (d) => ['Delivery discrepancy update', `Discrepancy on shipment ${s(d.shipmentNumber)} is now ${s(d.status)}.`],
    ar: (d) => ['تحديث فرق التسليم', `حالة فرق الشحنة ${s(d.shipmentNumber)} الآن: ${s(d.status)}.`],
  },
  CONFIRMATION_REQUEST_NEW: {
    en: (d) => ['Stock confirmation request', `Request ${s(d.code)}: please confirm ${s(d.qty)} × ${s(d.medicine)}.`],
    ar: (d) => ['طلب تأكيد توفر', `الطلب ${s(d.code)}: يرجى تأكيد توفر ${s(d.qty)} × ${s(d.medicine)}.`],
  },
  CONFIRMATION_RESPONSE: {
    en: (d) => ['Pharmacy replied', d.outcome === 'HELD'
      ? `${s(d.pharmacy)} is holding ${s(d.qty)} × ${s(d.medicine)} for you until ${s(d.until)}. Pickup code: ${s(d.pickupCode)}.`
      : d.outcome === 'CONFIRMED_AVAILABLE'
        ? `${s(d.pharmacy)} confirmed ${s(d.medicine)} is available now. Availability can change before you arrive.`
        : `${s(d.pharmacy)} reports ${s(d.medicine)} is not available.`],
    ar: (d) => ['ردت الصيدلية', d.outcome === 'HELD'
      ? `تحتفظ ${s(d.pharmacy)} بعدد ${s(d.qty)} من ${s(d.medicine)} لك حتى ${s(d.until)}. رمز الاستلام: ${s(d.pickupCode)}.`
      : d.outcome === 'CONFIRMED_AVAILABLE'
        ? `أكدت ${s(d.pharmacy)} توفر ${s(d.medicine)} الآن. قد يتغير التوفر قبل وصولك.`
        : `أفادت ${s(d.pharmacy)} بعدم توفر ${s(d.medicine)}.`],
  },
  REQUEST_EXPIRED: {
    en: (d) => ['Request expired', `Your request ${s(d.code)} for ${s(d.medicine)} expired without a reply.`],
    ar: (d) => ['انتهت صلاحية الطلب', `انتهت صلاحية طلبك ${s(d.code)} لـ ${s(d.medicine)} دون رد.`],
  },
  HOLD_EXPIRED: {
    en: (d) => ['Hold expired', `The hold for ${s(d.medicine)} at ${s(d.pharmacy)} has expired.`],
    ar: (d) => ['انتهى الحجز', `انتهى حجز ${s(d.medicine)} لدى ${s(d.pharmacy)}.`],
  },
  AVAILABILITY_ALERT: {
    en: (d) => ['Medicine available nearby', `${s(d.medicine)} was reported in stock at ${s(d.pharmacy)} (${s(d.distanceKm)} km). Call to confirm before going.`],
    ar: (d) => ['الدواء متاح بالقرب منك', `تم الإبلاغ عن توفر ${s(d.medicine)} في ${s(d.pharmacy)} (${s(d.distanceKm)} كم). اتصل للتأكد قبل الذهاب.`],
  },
  ORG_VERIFICATION_DECIDED: {
    en: (d) => ['Verification update', `Your organization ${s(d.org)} was ${s(d.decision).toLowerCase()}. ${s(d.notes)}`],
    ar: (d) => ['تحديث التحقق', `تم ${d.decision === 'VERIFIED' ? 'اعتماد' : 'رفض'} منشأتك ${s(d.org)}. ${s(d.notes)}`],
  },
  ORG_STATUS_CHANGED: {
    en: (d) => ['Organization status changed', `${s(d.org)} is now ${s(d.status)}. ${s(d.reason)}`],
    ar: (d) => ['تغيير حالة المنشأة', `حالة ${s(d.org)} الآن: ${s(d.status)}. ${s(d.reason)}`],
  },
  ORG_VERIFICATION_REQUESTED: {
    en: (d) => ['Verification requested', `${s(d.org)} (${s(d.type)}) is waiting for verification.`],
    ar: (d) => ['طلب تحقق', `${s(d.org)} (${s(d.type)}) بانتظار التحقق.`],
  },
  INTEGRATION_FAILING: {
    en: (d) => ['Integration problem', `Integration "${s(d.name)}" is ${s(d.health)}. Stock from it is no longer shown as confirmed.`],
    ar: (d) => ['مشكلة في الربط', `الربط "${s(d.name)}" حالته ${s(d.health)}. لن يظهر مخزونه كمؤكد.`],
  },
  BATCH_EXPIRING: {
    en: (d) => ['Batch expiring soon', `${s(d.medicine)} batch ${s(d.batch)} (${s(d.qty)} units) expires on ${s(d.expiry)}.`],
    ar: (d) => ['تشغيلة قاربت على الانتهاء', `تشغيلة ${s(d.batch)} من ${s(d.medicine)} (${s(d.qty)}) تنتهي في ${s(d.expiry)}.`],
  },
};

export function render(type: string, data: D, locale: 'ar' | 'en'): { title: string; body: string } {
  const t = TEMPLATES[type];
  if (!t) return { title: type, body: '' };
  const [title, body] = t[locale](data);
  return { title, body };
}
