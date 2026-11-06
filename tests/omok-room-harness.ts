// Local-only workerd/SQLite harness for Omok room/bot integration tests.
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export { Response };

export async function createOmokRoomHarness(test: {
  outbound?: (request: Request) => Promise<Response>;
  gateRatingRead?: boolean;
  gateRatingAck?: boolean;
} = {}) {
  const root = path.resolve(import.meta.dirname, '..');
  const state = await mkdtemp(path.join(tmpdir(), 'omok-room-'));
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      sourcefile: 'omok-room-worker.ts',
      contents: `
        import { OmokRoom } from './src/omok/room';
        export class TestRoom extends OmokRoom {
          constructor(ctx, env) {
            const db = {
              prepare(sql) {
                const statement = env.DB.prepare(sql);
                if (!env.TEST_RATING_READ || !sql.startsWith('SELECT telegram_id, rating, games_played')) return statement;
                return { bind(...values) {
                  const bound = statement.bind(...values);
                  return { async all() {
                    const rows = await bound.all();
                    await fetch('https://omok.test/rating-read');
                    return rows;
                  } };
                } };
              },
              async batch(statements) {
                const result = await env.DB.batch(statements);
                if (env.TEST_RATING_ACK) {
                  const ack = await fetch('https://omok.test/rating-ack');
                  if (!ack.ok) throw new Error('injected lost rating acknowledgement');
                }
                return result;
              },
            };
            super(ctx, { ...env, DB: db });
          }
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/__state') {
              if (request.method === 'POST') await this.ctx.storage.put('state', await request.json());
              return Response.json({ state: await this.ctx.storage.get('state'), alarm: await this.ctx.storage.getAlarm() });
            }
            if (url.pathname === '/__alarm') {
              await this.alarm();
              return Response.json({ ok: true });
            }
            return super.fetch(request);
          }
        }
        export default { fetch() { return new Response('not used'); } };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:*'],
  });

  const options = {
    modules: true,
    script: outputFiles[0].text,
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'TestRoom', useSQLite: true } },
    resourcePersistencePath: state,
    d1Databases: ['DB'],
    bindings: {
      TELEGRAM_BOT_TOKEN: 'local-test-token', ALLOW_DEV_LOGIN: '1',
      TEST_RATING_READ: test.gateRatingRead ?? false, TEST_RATING_ACK: test.gateRatingAck ?? false,
    },
    outboundService: test.outbound ?? (async () => Response.json({ ok: true, result: { status: 'member' } })),
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  await mf.ready;
  let db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE groups (group_id TEXT PRIMARY KEY)').run();
  await db.prepare("INSERT INTO groups (group_id) VALUES ('-100')").run();
  const migration = await readFile(path.join(root, 'migrations/0016_omok.sql'), 'utf8');
  for (const sql of migration.replace(/--[^\n]*/g, '').split(';').map((sql) => sql.trim()).filter(Boolean)) await db.prepare(sql).run();

  const room = async (name: string) => {
    const ns = await mf.getDurableObjectNamespace('ROOM');
    return ns.get(ns.idFromName(name));
  };

  return {
    room,
    get db() { return db; },
    async restart() {
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      await mf.ready;
      db = await mf.getD1Database('DB');
    },
    async stop() {
      await mf.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}

export async function readRoom(room: Awaited<ReturnType<Awaited<ReturnType<typeof createOmokRoomHarness>>['room']>>) {
  return (await room.fetch('https://room.test/__state')).json() as Promise<{ state: any; alarm: number | null }>;
}

export async function fireAlarm(room: Awaited<ReturnType<Awaited<ReturnType<typeof createOmokRoomHarness>>['room']>>) {
  return (await room.fetch('https://room.test/__alarm')).json() as Promise<{ ok: boolean }>;
}

export async function connectSocket(
  room: Awaited<ReturnType<Awaited<ReturnType<typeof createOmokRoomHarness>>['room']>>,
  playerId: string,
  name: string,
) {
  const response = await room.fetch(`https://room.test/?playerId=${playerId}&name=${encodeURIComponent(name)}`, { headers: { Upgrade: 'websocket' } });
  const socket = response.webSocket!;
  socket.accept();
  const frames: any[] = [];
  socket.addEventListener('message', (event) => { frames.push(JSON.parse(event.data as string)); });
  return { socket, frames, send: (msg: unknown) => socket.send(JSON.stringify(msg)) };
}

/** Fixture-only completion for lifecycle tests, not a played-game/E2E result. */
export async function finishFixtureRound(room: Awaited<ReturnType<HarnessRoom>>) {
  const response = await room.fetch('https://room.test/debug/patch', {
    method: 'POST', body: JSON.stringify({ phase: 'done', isDraw: true }),
  });
  if (!response.ok) throw new Error('Could not finish fixture round');
}

type HarnessRoom = Awaited<ReturnType<typeof createOmokRoomHarness>>['room'];
