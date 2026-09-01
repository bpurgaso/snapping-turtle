// Scenario (c) — legitimate-traffic baseline with a latency budget.
//
// 30 viewer IPs fetch the capture page and its (annotated → flat-rendered,
// then cached) image at a combined 10 iterations/s for 60 s — 40 req/min
// per IP, inside the anonymous general cap. Thresholds are the budget
// recorded in docs/loadtest.md; the guard must stay silent.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { asIp, BASE, guardStatus, setupCapture } from '../lib/common.js';

const PNG = open('../fixture.png', 'b');
const PAGE_P95_MS = Number(__ENV.PAGE_P95_MS || 150);
const IMAGE_P95_MS = Number(__ENV.IMAGE_P95_MS || 150);

export const options = {
  scenarios: {
    viewers: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 30,
      maxVUs: 30,
      exec: 'viewer',
    },
  },
  thresholds: {
    'http_req_duration{name:page}': [`p(95)<${PAGE_P95_MS}`],
    'http_req_duration{name:image}': [`p(95)<${IMAGE_P95_MS}`],
    'http_req_failed{scenario:viewers}': ['rate==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  return setupCapture(PNG, { annotate: true });
}

export function viewer(data) {
  const ip = `10.77.0.${__VU}`; // one IP per VU: 20 req/min each at 10 it/s over 30 VUs
  const page = http.get(`${BASE}${data.path}`, asIp(ip, {}, { name: 'page' }));
  check(page, { 'page 200': (r) => r.status === 200 });
  const image = http.get(`${BASE}${data.path}/image.png`, asIp(ip, {}, { name: 'image' }));
  check(image, {
    'image 200 png': (r) => r.status === 200 && r.headers['Content-Type'] === 'image/png',
  });
  sleep(0.05);
}

export function teardown(data) {
  const status = guardStatus(data.cookie);
  const fresh = status.bans.filter((b) => b.active && b.ipPrefix.startsWith('10.77.'));
  console.log(`baseline: breaker ${status.breaker.state}, viewer bans: ${fresh.length}`);
}
