import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './server.js';

describe('Cookie-based identity', () => {
  it('assigns different uid cookies to different requests', async () => {
    // Request A — no cookie → gets a new uid
    const resA = await request(app).get('/api/me');
    const cookieA = resA.headers['set-cookie']?.find(c => c.startsWith('uid='));
    expect(cookieA).toBeDefined();
    const uidA = cookieA.split('uid=')[1].split(';')[0];
    expect(uidA).toMatch(/^[0-9a-f-]{36}$/);

    // Request B — no cookie → gets a different uid
    const resB = await request(app).get('/api/me');
    const cookieB = resB.headers['set-cookie']?.find(c => c.startsWith('uid='));
    expect(cookieB).toBeDefined();
    const uidB = cookieB.split('uid=')[1].split(';')[0];

    // Different users created
    expect(uidA).not.toBe(uidB);
  });

  it('reuses uid when cookie is sent back', async () => {
    // First request gets a cookie
    const res1 = await request(app).get('/api/me');
    const cookie = res1.headers['set-cookie']?.find(c => c.startsWith('uid='));
    const uid = cookie.split('uid=')[1].split(';')[0];

    // Second request sends cookie back — should not get a new one
    const res2 = await request(app).get('/api/me').set('Cookie', `uid=${uid}`);
    const newCookie = res2.headers['set-cookie']?.find(c => c.startsWith('uid='));
    expect(newCookie).toBeUndefined(); // no new cookie set
  });
});
