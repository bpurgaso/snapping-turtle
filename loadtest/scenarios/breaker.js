// Scenario (b) — distributed enumeration → global breaker → recovery.
//
// 150 virtual IPs (one miss each, so no per-IP budget trips) push the
// aggregate invalid-lookup rate past RATE_BREAKER_INVALID_PER_MIN (100)
// inside 15 s. Expected: the breaker opens; anonymous fetches of a *valid*
// link get 429 + Retry-After ≤ cooldown; the owner's authenticated session
// keeps getting 200; after the cooldown (30 s in the loadtest profile) the
// first anonymous request half-opens the breaker and succeeds; a clean
// minute later the breaker is closed (asserted in teardown via the admin
// guard view) and anonymous traffic is back to 100% 200s.
import { check, fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import http from 'k6/http';
import { asIp, BASE, guardStatus, isGuardBlocked, missPath, setupCapture } from '../lib/common.js';

const PNG = open('../fixture.png', 'b');
const COOLDOWN = Number(__ENV.LOADTEST_BREAKER_COOLDOWN_SECONDS || 30);
const ANON = '203.0.113.20';
const OWNER = '203.0.113.21';

const anon429 = new Counter('anon_429_while_open');
const anonRecovered = new Counter('anon_200_after_open');

let sawOpen = false;
let startedAt = 0;

export const options = {
  scenarios: {
    crawl: {
      executor: 'shared-iterations',
      vus: 10,
      iterations: 150,
      maxDuration: '20s',
      exec: 'crawl',
    },
    anon: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '3s',
      duration: '130s',
      preAllocatedVUs: 1,
      maxVUs: 1,
      exec: 'anon',
    },
    owner: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '3s',
      duration: '130s',
      preAllocatedVUs: 1,
      exec: 'owner',
    },
  },
  thresholds: {
    anon_429_while_open: ['count>0'],
    anon_200_after_open: ['count>0'],
    // Sessions are never collateral damage.
    'checks{scenario:owner}': ['rate==1'],
    // The last 20 s of the run: breaker closed, anonymous traffic clean.
    'checks{phase:after}': ['rate==1'],
    // Every anonymous 429 carries a Retry-After within the cooldown.
    'checks{check:retry-after within cooldown}': ['rate==1'],
  },
};

export function setup() {
  return setupCapture(PNG);
}

export function crawl() {
  // One miss per virtual IP: 10.66.<vu>.<iter>
  const ip = `10.66.${__VU % 250}.${(__ITER % 250) + 1}`;
  const res = http.get(`${BASE}${missPath()}`, asIp(ip, {}, { name: 'crawl-miss' }));
  check(res, {
    'crawl miss is 404 or (once open) 429': (r) => r.status === 404 || r.status === 429,
  });
}

export function anon(data) {
  if (!startedAt) startedAt = Date.now();
  const elapsed = (Date.now() - startedAt) / 1000;
  const phase = elapsed >= 110 ? 'after' : sawOpen ? 'recovering' : 'before';
  const res = http.get(`${BASE}${data.path}`, asIp(ANON, {}, { name: 'anon-valid', phase }));
  if (isGuardBlocked(res)) {
    sawOpen = true;
    anon429.add(1);
    check(
      res,
      {
        'retry-after within cooldown': (r) => Number(r.headers['Retry-After']) <= COOLDOWN,
      },
      { phase },
    );
  } else if (sawOpen && res.status === 200) {
    anonRecovered.add(1);
  }
  check(res, { 'anon valid link served': (r) => r.status === 200 }, { phase });
  sleep(0.05);
}

export function owner(data) {
  const res = http.get(
    `${BASE}${data.path}`,
    asIp(OWNER, { cookie: data.cookie }, { name: 'owner-valid' }),
  );
  check(res, { 'owner session: 200 throughout': (r) => r.status === 200 });
  sleep(0.05);
}

export function teardown(data) {
  const status = guardStatus(data.cookie);
  console.log(
    `breaker state at teardown: ${status.breaker.state}; bans on record: ${status.bans.length}`,
  );
  if (status.breaker.state !== 'closed') fail(`breaker did not close: ${status.breaker.state}`);
}
