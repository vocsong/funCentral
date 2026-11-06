// Local-only Miniflare/SQLite harness for Connect 4 D1 completion tests.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function createConnect4Db() {
  const root = path.resolve(import.meta.dirname, '..');
  const state = await mkdtemp(path.join(tmpdir(), 'connect4-persistence-'));
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("not used"); } }',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    resourcePersistencePath: state,
  }));
  await mf.ready;
  const db = await mf.getD1Database('DB');
  // The migration's foreign key references groups; create it first.
  await db.prepare('CREATE TABLE groups (group_id TEXT PRIMARY KEY)').run();
  await db.prepare("INSERT INTO groups (group_id) VALUES ('-100')").run();
  const migration = await readFile(path.join(root, 'migrations/0015_connect4.sql'), 'utf8');
  for (const sql of migration.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(sql).run();
  }
  return {
    db,
    async stop() {
      await mf.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}
