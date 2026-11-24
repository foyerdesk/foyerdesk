import { DurableObject } from "cloudflare:workers";

// A session ends after `sessionLifetime` seconds without use, and in any case `sessionMaxAge` seconds after sign-in.
// The browser cookie lives for the maximum; the idle limit is enforced here, so no cookie has to be re-sent on every answer.
export const sessionLifetime = 1800;
export const sessionMaxAge = 8 * 3600;

export class TestSupportSession extends DurableObject {
  async save(identity) {
    const created = Date.now();
    const expires = created + sessionLifetime * 1000;
    await this.ctx.storage.put("session", { identity, created, expires });
    await this.ctx.storage.setAlarm(expires);
  }

  // `touch` false (the live channel reconnecting) reads without extending, so an idle open tab cannot keep a session alive.
  // The expiry is moved only once half of the idle time has passed, which keeps storage writes rare.
  async read(touch = true, now = Date.now()) {
    const session = await this.ctx.storage.get("session");
    if (!session || session.expires <= now) return null;
    const created = session.created ?? now;
    if (created + sessionMaxAge * 1000 <= now) { await this.revoke(); return null; }
    if (touch && session.expires - now < sessionLifetime * 500) {
      const expires = Math.min(now + sessionLifetime * 1000, created + sessionMaxAge * 1000);
      await this.ctx.storage.put("session", { ...session, created, expires });
      await this.ctx.storage.setAlarm(expires);
    }
    return session.identity ?? null;
  }

  async revoke() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    await this.revoke();
  }
}
