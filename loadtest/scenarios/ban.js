// Scenario (a) — single-IP enumeration → ban, while a friend keeps working.
//
// An attacker IP fires invalid /s/* lookups at 4/s. With the production
// defaults (RATE_INVALID_LOOKUP_BUDGET=5 in 10 min) the 6th miss trips a
// 15-minute ban, so from ~1.5 s in every request from that IP — including
// the *valid* link — is the pre-lookup 429 with Retry-After 900. A second
// IP fetching the valid link the whole time never sees anything but 200.
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import http from 'k6/http';
import { asIp, BASE, isGuardBlocked, missPath, setupCapture } from '../lib/common.js';

const PNG = open('../fixture.png', 'b');
const ATTACKER = '198.51.100.7';
const FRIEND = '203.0.113.9';
const BUDGET = Number(__ENV.RATE_INVALID_LOOKUP_BUDGET || 5);
const BAN_SECONDS = Number(__ENV.EXPECTED_BAN_SECONDS || 15 * 60);

const attacker404 = new Counter('attacker_404');
const attacker429 = new Counter('attacker_429');
const attackerValidBlocked = new Counter('attacker_valid_link_blocked');
const timeToBan = new Trend('time_to_ban_ms', true);

let startedAt = 0;
let banSeen = false;

export const options = {
  scenarios: {
    attacker: {
      executor: 'constant-arrival-rate',
      rate: 4,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 1,
      maxVUs: 1, // one VU: the request order is strictly serial
      exec: 'attacker',
    },
    friend: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '3s', // 40/min — inside the anonymous general cap of 60/min
      duration: '20s',
      preAllocatedVUs: 1,
      exec: 'friend',
    },
  },
  thresholds: {
    // The friend never notices: every request 200.
    'checks{scenario:friend}': ['rate==1'],
    // Exactly budget+1 misses answered 404 (the trip itself is a 404), then bans.
    attacker_404: [`count<=${BUDGET + 1}`],
    attacker_429: ['count>0'],
    attacker_valid_link_blocked: ['count>0'],
    // Ban lands within the budget: well under 5 s at 4 req/s.
    time_to_ban_ms: ['max<5000'],
    'checks{scenario:attacker}': ['rate==1'],
  },
};

export function setup() {
  return setupCapture(PNG);
}

export function attacker(data) {
  if (!startedAt) startedAt = Date.now();
  const res = http.get(`${BASE}${missPath()}`, asIp(ATTACKER, {}, { name: 'attacker-miss' }));
  if (res.status === 404) {
    attacker404.add(1);
    check(res, { 'miss before ban is the uniform 404': (r) => r.body.includes('Not found') });
  } else {
    attacker429.add(1);
    if (!banSeen) {
      banSeen = true;
      timeToBan.add(Date.now() - startedAt);
      // Once banned, the valid link is refused identically — the oracle is closed.
      const valid = http.get(`${BASE}${data.path}`, asIp(ATTACKER, {}, { name: 'attacker-valid' }));
      if (isGuardBlocked(valid)) attackerValidBlocked.add(1);
      check(valid, {
        'banned IP: valid link is the same 429': (r) => isGuardBlocked(r) && r.body === res.body,
        'banned IP: Retry-After is the 15-minute rung': (r) =>
          Number(r.headers['Retry-After']) <= BAN_SECONDS &&
          Number(r.headers['Retry-After']) > BAN_SECONDS - 30,
      });
    }
    check(res, { 'banned IP gets the guard 429': (r) => isGuardBlocked(r) });
  }
}

export function friend(data) {
  const res = http.get(`${BASE}${data.path}`, asIp(FRIEND, {}, { name: 'friend-valid' }));
  check(res, { 'friend: valid link 200': (r) => r.status === 200 });
  sleep(0.1);
}
