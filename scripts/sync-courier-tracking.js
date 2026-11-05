'use strict';

/**
 * Scheduled Courier Tracking Synchronization Runner.
 * Polls courier providers for active shipments ('ready_for_pickup', 'in_transit'),
 * synchronizes tracking status, updates fulfillment and sub-order lifecycle states,
 * and records auditable tracking events.
 *
 * Usage: node scripts/sync-courier-tracking.js [--limit=50] [--dry-run]
 */

const { env } = require('../src/config/env');
const { getPool, closePool } = require('../src/db/mysqlPool');
const courierRepo = require('../src/repositories/courierIntegrationRepository');

async function run() {
  const isMysql = env.db.client === 'mysql' || process.env.DB_CLIENT === 'mysql' || Boolean(process.env.MYSQL_TEST_HOST);
  if (!isMysql) {
    console.log('[courier-sync] Skipped: MySQL database required for tracking synchronization.');
    return { skipped: true };
  }

  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10)) : 100;
  const isDryRun = process.argv.includes('--dry-run');

  const pool = getPool();
  console.log(`[courier-sync] Starting tracking sync runner (limit: ${limit}, dry-run: ${isDryRun})...`);

  const [activeShipments] = await pool.query(
    `SELECT fs.id, fs.vendor_sub_order_id, fs.courier_code, fs.tracking_id, fs.status, so.vendor_id
     FROM fulfillment_shipments fs
     JOIN vendor_sub_orders so ON so.id = fs.vendor_sub_order_id
     WHERE fs.status IN ('ready_for_pickup', 'in_transit')
       AND fs.booking_status = 'succeeded'
       AND fs.tracking_id IS NOT NULL
       AND fs.tracking_id != ''
     ORDER BY fs.updated_at ASC
     LIMIT ?`,
    [limit]
  );

  console.log(`[courier-sync] Found ${activeShipments.length} active shipment(s) to synchronize.`);

  const stats = {
    total: activeShipments.length,
    synchronized: 0,
    delivered: 0,
    failedDelivery: 0,
    returned: 0,
    cancelled: 0,
    inTransit: 0,
    errors: 0
  };

  const actor = { userId: 1, role: 'system_sync' };

  for (const shipment of activeShipments) {
    if (isDryRun) {
      console.log(`[dry-run] Would sync sub-order #${shipment.vendor_sub_order_id} (${shipment.courier_code}, Tracking: ${shipment.tracking_id})`);
      continue;
    }

    try {
      const tracking = await courierRepo.syncShipmentTracking({
        subOrderId: shipment.vendor_sub_order_id,
        actor
      });

      stats.synchronized++;
      const norm = tracking.normalizedStatus;
      if (norm === 'delivered') stats.delivered++;
      else if (norm === 'failed_delivery') stats.failedDelivery++;
      else if (norm === 'returned') stats.returned++;
      else if (norm === 'cancelled') stats.cancelled++;
      else if (norm === 'in_transit') stats.inTransit++;

      console.log(`[courier-sync] Sub-order #${shipment.vendor_sub_order_id} (${shipment.courier_code}) -> ${norm}`);
    } catch (err) {
      stats.errors++;
      console.error(`[courier-sync] Error syncing sub-order #${shipment.vendor_sub_order_id}: ${err.message}`);
    }
  }

  console.log('[courier-sync] Summary:', JSON.stringify(stats, null, 2));
  await closePool();
  return stats;
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[courier-sync] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { run };
