import { DurableObject } from "cloudflare:workers";

export const sessionLifetime = 900;

export class TestSupportSession extends DurableObject {
  async save(identity) {
    const expires = Date.now() + sessionLifetime * 1000;
    await this.ctx.storage.put("session", { identity, expires });
    await this.ctx.storage.setAlarm(expires);
  }

  async read() {
    const session = await this.ctx.storage.get("session");
    return session && session.expires > Date.now() ? session.identity ?? null : null;
  }

  async revoke() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    await this.revoke();
  }
}
