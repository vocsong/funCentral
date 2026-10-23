// Screenshot / animation capture for Regicide UI review (not part of the Playwright suite).
// Real local Worker + Durable Objects with seeded rooms; scenarios are set with the dev-only patch hook.
//   PLAYWRIGHT_CHANNEL=chrome node tests/ui/regicide-capture.cjs docs/regicide-ui/after [--clips]
// --clips also records short animation clips with Chrome's DevTools screencast and writes them as
// animated PNGs (APNG; each frame stores only the rectangle that changed). No video tooling needed.
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { chromium } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');

const out = path.resolve(process.argv[2] || 'regicide-shots');
const wantClips = process.argv.includes('--clips');
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 };
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// A 3-player fight against the Queen of Spades, 4 Jacks down.
const FIGHT = {
  enemy: 'QS', enemyDamage: 17, jesterActive: false, phase: 'play', pendingDamage: 0, currentSeat: 0,
  played: [{ seat: 2, cards: ['7H'], value: 7, damage: 7 }, { seat: 1, cards: ['5C'], value: 5, damage: 10 }],
  defeated: ['JC', 'JH', 'JD', 'JS'], castle: ['QH', 'QD', 'QC', 'KS', 'KH', 'KD', 'KC'],
  tavern: ['2S', '3D', '4C', '5H', '6C', '7C', '8D', '9D', '10C', 'JH', '2D', '3H', '4D', '5S', '6H'],
  discard: ['JC', '2S', '3S', '9C', '10S', '4H', 'JD', 'JS'],
  hands: [['AC', '7D', '4S', '9H', '3C', 'X1'], ['10D', '6S', '2H', '8C', '5D'], ['8S', '2C', '10H', '6D']],
  lastTurnYielded: [false, true, false], log: [], seq: 0,
};
const LAST_KING = {
  enemy: 'KH', castle: [], enemyDamage: 30, played: [{ seat: 0, cards: ['10C'], value: 10, damage: 20 }, { seat: 0, cards: ['5D', 'AD'], value: 6, damage: 6 }],
  hands: [['10S', '3D', '7C']], defeated: ['JC', 'JD', 'JH', 'JS', 'QC', 'QD', 'QH', 'QS', 'KC', 'KD', 'KS'], soloJestersLeft: 1, log: [], seq: 0,
};

// --- Minimal PNG decode / APNG encode (8-bit RGB or RGBA, non-interlaced, as Chrome produces) ---
function pngChunks(buf) {
  const chunks = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    chunks.push({ type: buf.toString('ascii', off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}
function decodePng(buf) {
  const chunks = pngChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[12] !== 0 || ![2, 6].includes(ihdr[9])) return null;
  const bpp = ihdr[9] === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  return { width, height, bpp, colorType: ihdr[9], px };
}
/** 5 bits per channel: slight banding, far smaller frames. */
function quantize(img) {
  if (!img) return null;
  for (let i = 0; i < img.px.length; i++) if (img.bpp === 3 || i % 4 !== 3) img.px[i] &= 0xf8;
  return img;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}
/** Deflated scanlines (Sub filter) for one rectangle of an image. */
function encodeRect(img, x0, y0, w, h) {
  const rows = Buffer.alloc(h * (w * img.bpp + 1));
  for (let y = 0; y < h; y++) {
    const dst = y * (w * img.bpp + 1);
    rows[dst] = 1;
    const src = ((y0 + y) * img.width + x0) * img.bpp;
    for (let i = 0; i < w * img.bpp; i++) rows[dst + 1 + i] = (img.px[src + i] - (i >= img.bpp ? img.px[src + i - img.bpp] : 0)) & 255;
  }
  return zlib.deflateSync(rows, { level: 9 });
}
function changedRect(a, b) {
  let x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  for (let y = 0; y < a.height; y++) {
    const row = y * a.width * a.bpp;
    for (let x = 0; x < a.width; x++) {
      const i = row + x * a.bpp;
      if (a.px[i] === b.px[i] && a.px[i + 1] === b.px[i + 1] && a.px[i + 2] === b.px[i + 2]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/** frames: [{ img, ms }] → APNG buffer; later frames are drawn over earlier ones (dispose none, blend source). */
function encodeApng(frames) {
  const first = frames[0].img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(first.width, 0);
  ihdr.writeUInt32BE(first.height, 4);
  ihdr[8] = 8;
  ihdr[9] = first.colorType;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  parts.push(chunk('acTL', actl));
  let seq = 0;
  frames.forEach((f, i) => {
    const r = f.rect ?? { x: 0, y: 0, w: first.width, h: first.height };
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(r.w, 4);
    fctl.writeUInt32BE(r.h, 8);
    fctl.writeUInt32BE(r.x, 12);
    fctl.writeUInt32BE(r.y, 16);
    fctl.writeUInt16BE(Math.min(65535, Math.max(20, Math.round(f.ms))), 20);
    fctl.writeUInt16BE(1000, 22);
    parts.push(chunk('fcTL', fctl));
    const data = encodeRect(f.img, r.x, r.y, r.w, r.h);
    if (i === 0) parts.push(chunk('IDAT', data));
    else {
      const n = Buffer.alloc(4);
      n.writeUInt32BE(seq++);
      parts.push(chunk('fdAT', Buffer.concat([n, data])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Records `run()` with the DevTools screencast and writes an APNG (≈ `fps`, last frame held). */
// Looping ambient glows (breathing enemy, turn plate, ready button) are paused while recording:
// they repaint most of the screen every frame, which would make each clip several MB.
const AMBIENT_OFF = '.rc-enemy-card-slot, .rc-plate.is-turn, .rc-plate.danger, #btn-act.ready, .rc-pip-royal.now, .rc-modal-icon { animation: none !important; }';
async function recordClip(page, file, run, { maxWidth = 300, fps = 9, hold = 1600 } = {}) {
  const style = await page.addStyleTag({ content: AMBIENT_OFF });
  const cdp = await page.context().newCDPSession(page);
  const shots = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    shots.push({ buf: Buffer.from(data, 'base64'), t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth, maxHeight: 4000, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  await run();
  const ended = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  await style.evaluate((n) => n.remove());
  // Sample at a steady rate; each frame shows the latest screencast image at that moment.
  const decoded = [];
  let last = null;
  let lastImg = null;
  for (let t = started; t <= ended; t += 1 / fps) {
    const s = shots.filter((x) => x.t <= t).pop() ?? shots[0];
    if (!s) continue;
    if (s !== last) { lastImg = quantize(decodePng(s.buf)) ?? lastImg; last = s; }
    if (!lastImg || (decoded[0] && (lastImg.width !== decoded[0].img.width || lastImg.height !== decoded[0].img.height))) continue;
    const prev = decoded.at(-1);
    if (prev && prev.img === lastImg) { prev.ms += 1000 / fps; continue; }
    decoded.push({ img: lastImg, ms: 1000 / fps });
  }
  for (let i = 1; i < decoded.length; i++) decoded[i].rect = changedRect(decoded[i - 1].img, decoded[i].img);
  const dur = decoded.map((f) => f.ms);
  const frames = decoded.filter((f, i) => i === 0 || f.rect);
  // Fold dropped (unchanged) frames' time into the frame before them.
  frames.forEach((f) => { f.ms = 0; });
  let k = 0;
  decoded.forEach((f, i) => { if (f === frames[k + 1]) k++; frames[k].ms += dur[i]; });
  frames.at(-1).ms += hold;
  fs.writeFileSync(path.join(out, file), encodeApng(frames));
  console.log('clip', file, `${frames.length} frames`, `${Math.round(fs.statSync(path.join(out, file)).size / 1024)} KB`);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const worker = await startWorker(4231);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const api = (p, init) => fetch(`${worker.origin}${p}`, init);
  const token = async (name) => (await (await api('/api/auth/dev', { method: 'POST', body: JSON.stringify({ displayName: name }) })).json()).token;
  const createRoom = async (seed) => (await (await api('/api/regicide/create', { method: 'POST', body: JSON.stringify({ seed }) })).json()).roomCode;
  const patch = async (room, game) => { const r = await api(`/api/regicide/debug/patch?room=${room}`, { method: 'POST', body: JSON.stringify(game) }); if (!r.ok) throw new Error(await r.text()); };
  const contexts = [];

  async function client(name, device, room) {
    const context = await browser.newContext(device);
    contexts.push(context);
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === worker.origin || FONT_HOSTS.includes(url.hostname) ? route.continue() : route.abort();
    });
    const auth = name ? await token(name) : null;
    await page.addInitScript((t) => { if (t) localStorage.setItem('authToken', t); window.confirm = () => true; }, auth);
    await page.goto(`${worker.origin}/regicide/${room ? `#${room}` : ''}`);
    return page;
  }
  const settle = (page, ms = 1400) => page.waitForTimeout(ms);
  // JPEG keeps the evidence folder small; clips stay lossless-ish APNG.
  const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 82 }); console.log('captured', name); };
  async function tapCard(page, code) {
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'
      || !a.effect?.target?.closest?.('#hand') || a.effect.getComputedTiming().endTime === Infinity));
    const point = await page.evaluate((c) => {
      const card = document.querySelector(`#hand .hand-card[data-card="${c}"]`);
      const corner = card.querySelector('.card-corner').getBoundingClientRect();
      return { x: corner.left + corner.width / 2, y: corner.top + Math.min(10, corner.height / 2) };
    }, code);
    await page.mouse.click(point.x, point.y);
  }
  async function trio(seed) {
    const room = await createRoom(seed);
    const ada = await client('Ada', MOBILE, room);
    await ada.locator('#lobby-players .rc-player').first().waitFor();
    const bea = await client('Bea', DESKTOP, room);
    const cy = await client('Cy', MOBILE, room);
    await ada.waitForFunction(() => view?.players?.length === 3);
    return { room, ada, bea, cy };
  }

  try {
    // Home (signed in) and rules.
    const home = await client('Visitor', MOBILE);
    await settle(home);
    await shot(home, 'home-390');
    await home.locator('#btn-rules-home').click();
    await settle(home, 700);
    await shot(home, 'rules-390');

    // Three-player table: Ada on a phone, Bea on desktop, Cy on a phone.
    const { room, ada, bea } = await trio(7);
    await settle(ada);
    await shot(ada, 'lobby-390');
    await ada.locator('#btn-start').click();
    await ada.locator('#screen-game.active').waitFor();
    await settle(ada);

    await patch(room, FIGHT);
    await settle(ada);
    await shot(ada, 'turn-390');
    await tapCard(ada, 'AC');
    await tapCard(ada, '7D');
    await settle(ada, 600);
    await shot(ada, 'combo-390');

    // Desktop: Bea's turn with a single card selected.
    await patch(room, { currentSeat: 1, enemyDamage: 17 });
    await settle(bea);
    await tapCard(bea, '6S');
    await settle(bea, 600);
    await shot(bea, 'combo-1366');

    // Ada plays a card that doesn't kill and must take the hit.
    await patch(room, { currentSeat: 0, enemyDamage: 17 });
    await settle(ada);
    await tapCard(ada, '9H');
    await ada.locator('#btn-act').click();
    await settle(ada, 500);
    await shot(ada, 'strike-390');
    await settle(ada, 1200);
    if (await ada.locator('#btn-bestfit').isVisible()) await ada.locator('#btn-bestfit').click();
    await settle(ada, 600);
    await shot(ada, 'discard-390');
    await shot(bea, 'watching-discard-1366');

    // Jester: Ada plays it and chooses who goes next.
    await patch(room, { ...FIGHT, hands: [['X1', '4S', '3C'], ['10D', '6S', '2H', '8C', '5D'], ['8S', '2C', '10H', '6D']] });
    await settle(ada);
    await tapCard(ada, 'X1');
    await ada.locator('#btn-act').click();
    await settle(ada, 1600);
    await shot(ada, 'jester-390');

    // Kill: Bea finishes the Queen (desktop) for the defeat + reveal sequence.
    await patch(room, { ...FIGHT, currentSeat: 1, enemyDamage: 24, hands: [['4S', '3C'], ['10D', '6S', '2H', '8C', '5D'], ['8S', '2C', '10H', '6D']] });
    await settle(bea);
    await tapCard(bea, '6S');
    await bea.locator('#btn-act').click();
    await settle(bea, 450);
    await shot(bea, 'defeat-mid-1366');
    await settle(bea, 1800);
    await shot(bea, 'reveal-1366');

    // Victory (solo, phone + desktop) and defeat (solo, phone).
    for (const [device, suffix] of [[MOBILE, '390'], [DESKTOP, '1366']]) {
      const soloRoom = await createRoom(11);
      const solo = await client(`Solo ${suffix}`, device, soloRoom);
      await solo.locator('#btn-start').click();
      await solo.locator('#screen-game.active').waitFor();
      await patch(soloRoom, LAST_KING);
      await settle(solo);
      await tapCard(solo, '10S');
      await solo.locator('#btn-act').click();
      await settle(solo, 2800);
      await shot(solo, `victory-${suffix}`);
    }
    const lossRoom = await createRoom(12);
    const loser = await client('Solo Loss', MOBILE, lossRoom);
    await loser.locator('#btn-start').click();
    await loser.locator('#screen-game.active').waitFor();
    await patch(lossRoom, { enemy: 'QC', enemyDamage: 0, played: [], hands: [['2S', '3H']], soloJestersLeft: 0, defeated: ['JC', 'JD', 'JH', 'JS', 'QH'], castle: ['QD', 'QS', 'KC', 'KD', 'KH', 'KS'] });
    await settle(loser);
    await tapCard(loser, '2S');
    await loser.locator('#btn-act').click();
    await settle(loser, 2800);
    await shot(loser, 'defeat-390');

    if (wantClips) {
      // Fresh rooms so each clip starts from a known board.
      const t = await trio(31);
      await recordClip(t.ada, 'clip-intro-390.png', async () => {
        await t.ada.locator('#btn-start').click();
        await settle(t.ada, 2300);
      });

      await patch(t.room, FIGHT);
      await settle(t.ada, 1200);
      await recordClip(t.ada, 'clip-combo-kill-390.png', async () => {
        await settle(t.ada, 300);
        await tapCard(t.ada, 'AC');
        await settle(t.ada, 450);
        await tapCard(t.ada, '7D');
        await settle(t.ada, 1000);
        await t.ada.locator('#btn-act').click();
        await settle(t.ada, 3600);
      });

      await patch(t.room, FIGHT);
      await settle(t.ada, 1200);
      await recordClip(t.ada, 'clip-strike-discard-390.png', async () => {
        await settle(t.ada, 300);
        await tapCard(t.ada, '9H');
        await settle(t.ada, 800);
        await t.ada.locator('#btn-act').click();
        await settle(t.ada, 2000);
        await t.ada.locator('#btn-bestfit').click();
        await settle(t.ada, 900);
        await t.ada.locator('#btn-act').click();
        await settle(t.ada, 1500);
      });

      await patch(t.room, { ...FIGHT, hands: [['X1', '4S', '3C'], ['10D', '6S', '2H', '8C', '5D'], ['8S', '2C', '10H', '6D']] });
      await settle(t.ada, 1200);
      await recordClip(t.ada, 'clip-jester-390.png', async () => {
        await settle(t.ada, 300);
        await tapCard(t.ada, 'X1');
        await settle(t.ada, 800);
        await t.ada.locator('#btn-act').click();
        await settle(t.ada, 2600);
      });

      const soloRoom = await createRoom(41);
      const solo = await client('Solo Clip', DESKTOP, soloRoom);
      await solo.locator('#btn-start').click();
      await solo.locator('#screen-game.active').waitFor();
      await patch(soloRoom, LAST_KING);
      await settle(solo, 1600);
      await recordClip(solo, 'clip-victory-1366.png', async () => {
        await tapCard(solo, '10S');
        await settle(solo, 700);
        await solo.locator('#btn-act').click();
        await settle(solo, 3800);
      }, { maxWidth: 683, fps: 10 });
    }
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await worker.stop();
  }
})().catch((err) => { console.error(err); process.exit(1); });
