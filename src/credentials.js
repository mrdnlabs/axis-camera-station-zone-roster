// Changing the ACS sign-in from the Setup view. Protections, enforced here and in src/server.js:
//   * only from a browser on this computer, so the password never crosses the network unencrypted
//   * the new sign-in must work against the configured ACS, which the web UI can't change, so nobody can
//     store a sign-in they can't already use or send a saved one to another server
//   * while the stored sign-in still works, replacing it requires its password
//   * five wrong passwords lock the form for five minutes, so it can't be used to guess ACS passwords
//   * the password is never returned, logged or passed on a command line
// Storage is the Windows service's DPAPI-encrypted secrets.dat. Without the service there is nowhere safe to
// keep it, so the sign-in then comes only from environment variables.

import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AcsClient } from './acsClient.js';

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;
const SAVE_TIMEOUT_MS = 15_000;

/** The service host's encrypted store, or null when not running under the service. */
export function secretStore(env = process.env) {
  const tool = env.ZONE_ROSTER_SECRET_TOOL, dataDir = env.ZONE_ROSTER_DATA_DIR;
  if (!tool || !dataDir) return null;
  return {
    save: (username, password) => new Promise((resolve, reject) => {
      const child = execFile(tool, ['--store-acs-credentials', dataDir], { timeout: SAVE_TIMEOUT_MS, windowsHide: true },
        (e) => (e ? reject(new Error(`the credential store exited with ${e.code ?? e.signal ?? 'an error'}`)) : resolve()));
      child.stdin.on('error', () => {}); // reported through the exit code
      child.stdin.end(`${username}\n${password}\n`);
    }),
  };
}

const hasControlCharacter = (s) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export function validateSignIn(input) {
  const { username, password } = input ?? {};
  if (typeof username !== 'string' || !username.trim() || username.length > 256) return ['Enter a username'];
  if (typeof password !== 'string' || !password || password.length > 1024) return ['Enter a password'];
  if (username.includes(':')) return ['ACS usernames cannot contain a colon'];
  if (hasControlCharacter(username) || hasControlCharacter(password)) return ['The username or password contains an invalid character'];
  return [];
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => timingSafeEqual(sha256(a), sha256(b)); // equal-length digests, compared in constant time

export class SignIn {
  constructor({ cfg, client, poller, secrets, log = console, now = () => Date.now() }) {
    Object.assign(this, { cfg, client, poller, secrets, log, now });
    this.failures = 0;
    this.lockedUntil = 0;
    this.busy = false;
  }

  describe() {
    return { configured: Boolean(this.cfg.acs.username), username: this.cfg.acs.username || null, canChange: this.secrets !== null, currentRequired: this.currentRequired() };
  }

  // Not needed once ACS rejects the stored sign-in (its password was changed), or before there is one.
  currentRequired() {
    return Boolean(this.cfg.acs.username) && this.poller.status.lastError?.status !== 401;
  }

  recordFailure() {
    if (++this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.lockedUntil = this.now() + LOCK_MS;
      this.log.warn?.('[setup] too many wrong ACS passwords: changes are locked for 5 minutes');
    }
  }

  /** @returns {Promise<{code: number, body: object}>} */
  async change(input) {
    if (!this.secrets) return { code: 409, body: { error: 'This copy takes its sign-in from environment variables' } };
    if (this.busy) return { code: 429, body: { error: 'A change is already in progress' } };
    const wait = this.lockedUntil - this.now();
    if (wait > 0) return { code: 429, body: { error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60_000)} min.` } };
    const errors = validateSignIn(input);
    if (errors.length) return { code: 400, body: { errors } };

    if (this.currentRequired() && !sameSecret(input.currentPassword, this.cfg.acs.password)) {
      this.recordFailure();
      this.log.warn?.('[setup] ACS sign-in change refused: wrong current password');
      return { code: 400, body: { error: 'The current password is wrong' } };
    }

    const username = input.username.trim(), password = input.password;
    this.busy = true;
    try {
      const refused = await this.test(username, password);
      if (refused) return refused;
      try { await this.secrets.save(username, password); }
      catch (e) {
        this.log.warn?.(`[setup] could not store the ACS sign-in: ${e.message}`);
        return { code: 500, body: { error: 'ACS accepted the sign-in, but it could not be stored. The previous one is unchanged.' } };
      }
      this.failures = 0;
      this.cfg.acs.username = username;
      this.cfg.acs.password = password;
      this.client.setCredentials(username, password);
      this.log.info?.(`[setup] ACS sign-in changed to user "${username}"`);
      await this.poller.signInChanged();
      return { code: 200, body: { ok: true, username } };
    } finally {
      this.busy = false;
    }
  }

  // Returns the reply to send if ACS didn't accept this sign-in, or null if it did.
  async test(username, password) {
    const probe = new AcsClient({ ...this.cfg.acs, username, password });
    try {
      await probe.verifyAccess();
      return null;
    } catch (e) {
      if (e.status === 401) {
        this.recordFailure();
        this.log.warn?.('[setup] ACS sign-in change refused: ACS rejected the new sign-in');
        return { code: 400, body: { error: 'ACS rejected that username or password' } };
      }
      return { code: 502, body: { error: `Could not test the sign-in. ${e.message}` } };
    } finally {
      probe.close();
    }
  }
}
