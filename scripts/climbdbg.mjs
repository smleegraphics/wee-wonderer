import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('http://localhost:5173/?scan=room2.ply', { waitUntil: 'load', timeout: 20000 });
await p.waitForFunction(() => window.__wwReady === true, { timeout: 15000 }).catch(()=>{});
await p.mouse.click(640, 400);
const dbg = () => p.evaluate(() => window.__dbg);
// hold a direction until climbing, then log a few frames of dbg while climbing
for (const key of ['KeyW','KeyA','KeyS','KeyD','KeyW','KeyA','KeyS','KeyD']) {
  await p.keyboard.down(key);
  let started = false;
  for (let i=0;i<40;i++){ await p.waitForTimeout(80); const d=await dbg(); if(d&&d.state==='climb'){ started=true; break; } }
  if (started) {
    console.log('CLIMBING via', key);
    for (let i=0;i<5;i++){ await p.waitForTimeout(200); console.log('  ', JSON.stringify(await dbg())); }
    await p.keyboard.up(key);
    break;
  }
  await p.keyboard.up(key);
}
await b.close();
