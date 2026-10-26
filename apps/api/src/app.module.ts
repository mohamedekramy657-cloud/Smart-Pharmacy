import { Global, Module, OnApplicationShutdown, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditService } from './common/audit.service';
import { AuthGuard } from './common/auth/auth.guard';
import { SessionService } from './common/auth/session.service';
import { IdempotencyService } from './common/idempotency.service';
import { SecurityEventsService } from './common/security-events.service';
import { SettingsService } from './common/settings.service';
import { config } from './config/config';
import { Database } from './database/db';
import { AdminController } from './modules/admin/admin.controller';
import { AdminService } from './modules/admin/admin.service';
import { AnalyticsController } from './modules/analytics/analytics.controller';
import { AnalyticsService } from './modules/analytics/analytics.service';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { AdminCatalogController, CatalogController } from './modules/catalog/catalog.controller';
import { CatalogService } from './modules/catalog/catalog.service';
import { FinderController } from './modules/finder/finder.controller';
import { FinderService } from './modules/finder/finder.service';
import { HealthController } from './modules/health/health.controller';
import { IntegrationsController } from './modules/integrations/integrations.controller';
import { IntegrationsService } from './modules/integrations/integrations.service';
import { ImportService } from './modules/inventory/import.service';
import { InventoryController } from './modules/inventory/inventory.controller';
import { InventoryService } from './modules/inventory/inventory.service';
import { LedgerService } from './modules/inventory/ledger.service';
import { JobsService } from './modules/jobs/jobs.service';
import { MaintenanceService } from './modules/jobs/maintenance.service';
import { NotificationsService } from './modules/notifications/notifications.service';
import { OrganizationsController } from './modules/organizations/organizations.controller';
import { OrganizationsService } from './modules/organizations/organizations.service';
import { AlertsService } from './modules/patient/alerts.service';
import { MeController } from './modules/patient/me.controller';
import { PharmacyRequestsController } from './modules/patient/pharmacy-requests.controller';
import { RequestsService } from './modules/patient/requests.service';
import { PurchaseOrdersService } from './modules/supply/purchase-orders.service';
import { RelationshipsService } from './modules/supply/relationships.service';
import { ShipmentsService } from './modules/supply/shipments.service';
import { SupplyController } from './modules/supply/supply.controller';

/** Cross-cutting infrastructure shared by every module. */
@Global()
@Module({
  providers: [
    { provide: Database, useFactory: () => new Database() },
    SessionService, SecurityEventsService, AuditService, SettingsService, IdempotencyService, JobsService, NotificationsService, LedgerService,
  ],
  exports: [Database, SessionService, SecurityEventsService, AuditService, SettingsService, IdempotencyService, JobsService, NotificationsService, LedgerService],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(private readonly db: Database) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.close().catch(() => undefined);
  }
}

@Module({ controllers: [OrganizationsController], providers: [OrganizationsService], exports: [OrganizationsService] })
export class OrganizationsModule {}

@Module({ imports: [OrganizationsModule], controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}

@Module({ controllers: [CatalogController, AdminCatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}

@Module({ controllers: [InventoryController], providers: [InventoryService, ImportService], exports: [InventoryService] })
export class InventoryModule {}

@Module({ controllers: [SupplyController], providers: [PurchaseOrdersService, ShipmentsService, RelationshipsService] })
export class SupplyModule {}

@Module({ imports: [OrganizationsModule], controllers: [FinderController], providers: [FinderService] })
export class FinderModule {}

@Module({ controllers: [MeController, PharmacyRequestsController], providers: [RequestsService, AlertsService], exports: [RequestsService, AlertsService] })
export class PatientModule {}

@Module({ controllers: [IntegrationsController], providers: [IntegrationsService], exports: [IntegrationsService] })
export class IntegrationsModule {}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}

@Module({ imports: [OrganizationsModule, AnalyticsModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}

@Module({ imports: [PatientModule, IntegrationsModule], providers: [MaintenanceService] })
export class MaintenanceModule {}

@Module({ controllers: [HealthController] })
export class HealthModule {}

@Module({
  imports: [
    LoggerModule.forRoot({
      forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
      pinoHttp: {
        level: config().LOG_LEVEL,
        genReqId: (_req, res) => String(res.getHeader('X-Request-Id') ?? ''),
        redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'req.headers["x-sp-signature"]', 'res.headers["set-cookie"]'], remove: true },
        autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/health') },
        serializers: {
          req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: req.url?.split('?')[0], id: req.id }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
      },
    }),
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: () => config().RATE_LIMIT_PER_MINUTE }] }),
    CoreModule, OrganizationsModule, AuthModule, CatalogModule, InventoryModule, SupplyModule, FinderModule, PatientModule,
    IntegrationsModule, AnalyticsModule, AdminModule, MaintenanceModule, HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // first: cheap rejection of floods before any DB work
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
