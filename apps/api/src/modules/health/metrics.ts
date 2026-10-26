import { Counter, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/** Prometheus metrics (exposed at /api/metrics, optionally protected by METRICS_TOKEN). */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  httpDuration: new Histogram({
    name: 'sp_http_request_duration_seconds',
    help: 'HTTP request duration by route and status',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  searchDuration: new Histogram({
    name: 'sp_finder_search_duration_seconds',
    help: 'Medicine finder search latency by outcome',
    labelNames: ['outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  }),
  jobsProcessed: new Counter({
    name: 'sp_jobs_processed_total',
    help: 'Background jobs processed by type and outcome',
    labelNames: ['type', 'outcome'],
    registers: [registry],
  }),
  jobDuration: new Histogram({
    name: 'sp_job_duration_seconds',
    help: 'Background job duration',
    labelNames: ['type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
    registers: [registry],
  }),
  authFailures: new Counter({
    name: 'sp_auth_failures_total',
    help: 'Failed authentication attempts',
    labelNames: ['reason'],
    registers: [registry],
  }),
};
