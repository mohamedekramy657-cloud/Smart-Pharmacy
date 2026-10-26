-- SYNTHETIC PERFORMANCE DATASET (never use in production). Creates N verified demo pharmacies
-- spread over a ~150 x 150 km box around Ismailia/Cairo, M medicines and ~30 stock lines each.
-- Quantities are applied through sp_apply_inventory_movement so ledger invariants hold.
\set pharmacies 3000
\set medicines 200
INSERT INTO medicines (brand_name_en, generic_name_en, strength, dosage_form, route, package_size, package_unit, manufacturer, identity_key, data_source)
SELECT 'PerfMed ' || g, 'Generic ' || g, (g % 9 + 1) * 50 || ' mg', 'TABLET', 'ORAL', 20, 'TABLET', 'Synthetic', 'perf-' || g, 'DEV_SEED'
FROM generate_series(1, :medicines) g;
INSERT INTO organizations (type, name_en, address_line, location, verification_status, status, is_demo, license_number)
SELECT 'PHARMACY', '[PERF] Pharmacy ' || g, 'synthetic', ST_SetSRID(ST_MakePoint(31.35 + random() * 1.4, 29.95 + random() * 1.0), 4326)::geography,
       CASE WHEN g % 20 = 0 THEN 'PENDING' ELSE 'VERIFIED' END, 'ACTIVE', true, 'PERF-' || g
FROM generate_series(1, :pharmacies) g;
INSERT INTO pharmacies (organization_id, is_24h) SELECT id, random() < 0.1 FROM organizations WHERE type = 'PHARMACY';
INSERT INTO inventory_items (organization_id, medicine_id, low_stock_threshold)
SELECT o.id, m.id, 5 FROM organizations o
CROSS JOIN LATERAL (SELECT id FROM medicines ORDER BY md5(id::text || o.id::text) LIMIT 30) m WHERE o.type = 'PHARMACY' -- correlated: different set per pharmacy
ON CONFLICT DO NOTHING;
SELECT count(*) AS movements FROM (SELECT sp_apply_inventory_movement(id, 'OPENING_BALANCE', (random() * 60)::int, 0, 0, 'MANUAL', NULL, NULL, NULL, NULL, 'synthetic', NULL, true) FROM inventory_items) x;
UPDATE inventory_items SET last_updated_at = now() - (random() * interval '5 days');
ANALYZE;
