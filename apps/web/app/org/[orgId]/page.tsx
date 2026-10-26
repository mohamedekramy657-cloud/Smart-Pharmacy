'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { InventoryTab } from '@/components/org/inventory';
import { IntegrationsTab, OverviewTab, RelationshipsTab, RequestsTab, TeamTab } from '@/components/org/misc';
import { OrdersTab } from '@/components/org/orders';
import { DiscrepanciesTab, IncomingTab, ShipmentsTab } from '@/components/org/shipments';
import { Alert, Badge, statusTone, Tabs } from '@/components/ui';
import { useI18n, useSession } from '@/lib/providers';

export type OrgTab = 'overview' | 'inventory' | 'incoming' | 'orders' | 'shipments' | 'discrepancies' | 'requests' | 'partners' | 'integrations' | 'team';

export default function OrgDashboard() {
  const { orgId } = useParams<{ orgId: string }>();
  const { t, locale } = useI18n();
  const { memberships, loading, user } = useSession();
  const [tab, setTab] = useState<OrgTab>('overview');
  const L = (en: string, ar: string) => (locale === 'ar' ? ar : en);
  const m = memberships.find((x) => x.organizationId === orgId);

  if (loading) return <p className="text-sm text-slate-500">{t('loading')}</p>;
  if (!user) return <Alert tone="amber"><Link className="underline" href={`/login?next=/org/${orgId}`}>{t('navLogin')}</Link></Alert>;
  if (!m) return <Alert>{L('Organization not found or you are not a member.', 'المنشأة غير موجودة أو لست عضوًا بها.')}</Alert>;
  const can = (p: string) => m.permissions.includes(p);
  const isPharmacy = m.type === 'PHARMACY';
  const tabs: Array<[OrgTab, string]> = [
    ['overview', L('Overview', 'نظرة عامة')],
    ['inventory', L('Inventory', 'المخزون')],
    ...(isPharmacy ? [['incoming', L('Incoming stock', 'الوارد المتوقع')] as [OrgTab, string]] : []),
    ['orders', L('Purchase orders', 'أوامر الشراء')],
    ['shipments', L('Shipments', 'الشحنات')],
    ['discrepancies', L('Discrepancies', 'الفروقات')],
    ...(isPharmacy ? [['requests', L('Patient requests', 'طلبات المرضى')] as [OrgTab, string]] : []),
    ['partners', isPharmacy ? L('Suppliers', 'الموردون') : L('Pharmacy customers', 'العملاء')],
    ...(can('integrations:manage') ? [['integrations', L('Integrations', 'التكاملات')] as [OrgTab, string]] : []),
    ['team', L('Team', 'الفريق')],
  ];
  const props = { orgId, org: m, can, L };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-xl font-bold">{locale === 'ar' && m.nameAr ? m.nameAr : m.nameEn}</h1>
        <Badge tone="blue">{isPharmacy ? L('Pharmacy', 'صيدلية') : L('Warehouse', 'مخزن')}</Badge>
        <Badge tone={statusTone(m.verificationStatus)}>{m.verificationStatus}</Badge>
        <Badge>{m.role.replace('ORG_', '')}</Badge>
      </div>
      {m.verificationStatus !== 'VERIFIED' && <Alert tone="amber">{t('orgPending')}</Alert>}
      {m.status !== 'ACTIVE' && <Alert>{t('orgSuspended')}</Alert>}
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <OverviewTab {...props} />}
      {tab === 'inventory' && <InventoryTab {...props} />}
      {tab === 'incoming' && <IncomingTab {...props} />}
      {tab === 'orders' && <OrdersTab {...props} />}
      {tab === 'shipments' && <ShipmentsTab {...props} />}
      {tab === 'discrepancies' && <DiscrepanciesTab {...props} />}
      {tab === 'requests' && <RequestsTab {...props} />}
      {tab === 'partners' && <RelationshipsTab {...props} />}
      {tab === 'integrations' && <IntegrationsTab {...props} />}
      {tab === 'team' && <TeamTab {...props} />}
    </div>
  );
}
