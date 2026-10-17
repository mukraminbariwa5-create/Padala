// Live updates: new messages, versions, status changes and who is online.
// Two ways to receive them:
//  - long polling (what the app uses): the app keeps one request waiting; the server answers the moment
//    something happens, and the app asks again. Works through any proxy, tunnel or mobile network.
//  - Server-Sent Events (a streaming connection), kept for tools and older app versions.
import { randomUUID } from 'node:crypto';

const POLL_WAIT = 25000;     // how long a poll waits for news before answering "nothing yet"
const POLL_EXPIRE = 45000;   // a poll session with no request for this long has gone away
const QUEUE_MAX = 500;

export class EventHub {
  constructor() {
    this.clients = new Set();   // streaming: { res, userId, teams:Set<number> }
    this.sessions = new Map();  // polling: id -> { id, userId, teams, queue, waiter, lastSeen }
    this.timer = setInterval(() => { this.#ping(); this.#sweep(); }, 10000);
    this.timer.unref();
    this.tick = 0;
  }

  /**
   * One long-poll request. Returns { session, events }. A new session starts with a 'hello' event;
   * after that the request resolves as soon as there are events, or after POLL_WAIT with none.
   */
  poll(req, userId, teamIds, sessionId) {
    let s = sessionId ? this.sessions.get(sessionId) : null;
    if (!s || s.userId !== userId) {
      const wasOnline = this.#countFor(userId) > 0;
      s = { id: randomUUID(), userId, teams: new Set(teamIds), queue: [], waiter: null, lastSeen: Date.now() };
      if (!wasOnline) this.#presence(userId, s.teams, true); // tell the others before this session starts listening
      this.sessions.set(s.id, s);
      return Promise.resolve({ session: s.id, events: [{ type: 'hello', data: { online: this.onlineIn(teamIds) } }] });
    }
    s.lastSeen = Date.now();
    s.teams = new Set(teamIds); // membership may have changed (joined or left a team)
    s.waiter?.done();           // only one waiting request per session
    if (s.queue.length) return Promise.resolve({ session: s.id, events: s.queue.splice(0) });
    return new Promise((resolve) => {
      let timer = null;
      const w = {
        done: () => {
          if (w.finished) return;
          w.finished = true;
          clearTimeout(timer);
          if (s.waiter === w) s.waiter = null;
          s.lastSeen = Date.now();
          resolve({ session: s.id, events: s.queue.splice(0) });
        },
      };
      s.waiter = w;
      timer = setTimeout(w.done, POLL_WAIT);
      req.on('close', w.done);
    });
  }

  connect(req, res, userId, teamIds) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform stops proxies and tunnels (like Cloudflare) from compressing, which would hold events back
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Some proxies wait for a couple of KB before passing anything on; send that much up front.
    res.write(`:${' '.repeat(2048)}\n`);
    res.write('retry: 3000\n\n');
    const client = { res, userId, teams: new Set(teamIds) };
    this.clients.add(client);
    const wasOnline = this.#countFor(userId) > 1;
    this.#send(client, 'hello', { online: this.onlineIn(teamIds) });
    if (!wasOnline) this.#presence(userId, client.teams, true);
    req.on('close', () => {
      this.clients.delete(client);
      if (this.#countFor(userId) === 0) this.#presence(userId, client.teams, false);
    });
  }

  /** A user joined a new team: their open connections start receiving its events. */
  addTeam(userId, teamId) {
    for (const c of this.clients) if (c.userId === userId) c.teams.add(teamId);
    for (const x of this.sessions.values()) if (x.userId === userId) x.teams.add(teamId);
    this.toTeam(teamId, 'presence', { userId, online: this.#countFor(userId) > 0 });
  }

  /** Stop sending a team's events to a user (they left), or to everyone (userId null: the team is gone). */
  dropTeam(teamId, userId = null) {
    for (const c of this.clients) if (userId === null || c.userId === userId) c.teams.delete(teamId);
    for (const x of this.sessions.values()) if (userId === null || x.userId === userId) x.teams.delete(teamId);
  }

  toTeam(teamId, type, data) {
    for (const c of this.clients) if (c.teams.has(teamId)) this.#send(c, type, { teamId, ...data });
    for (const x of this.sessions.values()) {
      if (!x.teams.has(teamId)) continue;
      x.queue.push({ type, data: { teamId, ...data } });
      if (x.queue.length > QUEUE_MAX) x.queue.splice(0, x.queue.length - QUEUE_MAX);
      // answer a moment later, so events that happen together (a delivery + its messages) arrive together
      if (x.waiter && !x.flushing) { x.flushing = true; setTimeout(() => { x.flushing = false; x.waiter?.done(); }, 40); }
    }
  }

  onlineIn(teamIds) {
    const set = new Set(teamIds);
    const ids = new Set();
    for (const c of [...this.clients, ...this.sessions.values()]) for (const t of c.teams) if (set.has(t)) { ids.add(c.userId); break; }
    return [...ids];
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    for (const x of this.sessions.values()) x.waiter?.done();
    this.sessions.clear();
  }

  #countFor(userId) {
    let n = 0;
    for (const c of this.clients) if (c.userId === userId) n++;
    for (const x of this.sessions.values()) if (x.userId === userId) n++;
    return n;
  }

  #presence(userId, teams, online) {
    for (const t of teams) this.toTeam(t, 'presence', { userId, online });
  }

  #send(c, type, data) {
    c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Poll sessions that stopped asking have gone away (closed the app, lost signal): mark them offline. */
  #sweep() {
    const cutoff = Date.now() - POLL_EXPIRE;
    for (const x of [...this.sessions.values()]) {
      if (x.waiter || x.lastSeen > cutoff) continue;
      this.sessions.delete(x.id);
      if (this.#countFor(x.userId) === 0) this.#presence(x.userId, x.teams, false);
    }
  }

  #ping() {
    if (++this.tick % 2) return; // every 20 seconds
    // A named event (not a comment) so the app can tell the connection is alive and reconnect if it goes quiet.
    for (const c of this.clients) c.res.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }
}
