#!/usr/bin/env node
// מייצא קובץ HTML שנבנה מהתבנית לסרטון MP4 אנכי (1080x1920).
// שימוש:
//   node render.mjs <video.html> <out.mp4> [--fps 30] [--audio music.mp3] [--from 0] [--to 5] [--still 7.5]
//   --still T  שומר PNG של רגע אחד בלבד (לבדיקה מהירה) במקום סרטון.
// דרישות: Node 18+, Playwright (npm i playwright), ffmpeg ב-PATH.
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const [input, output] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!input || !output) {
  console.error('usage: node render.mjs <video.html> <out.mp4|out.png> [--fps 30] [--audio file] [--from s] [--to s] [--still s]');
  process.exit(1);
}
const fps = Number(opt('fps', 30));
const audio = opt('audio');
const still = opt('still');

async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const root = execSync('npm root -g').toString().trim();
  return await import(pathToFileURL(path.join(root, 'playwright', 'index.mjs')).href);
}

const { chromium } = await loadPlaywright();
const launchOpts = { args: ['--allow-file-access-from-files', '--font-render-hinting=none'] };
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(pathToFileURL(path.resolve(input)).href + '?render');
await page.waitForFunction(() => window.READY === true, null, { timeout: 30000 });
await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
const stage = await page.$('#stage');

if (still !== undefined) {
  await page.evaluate(t => window.renderFrame(t), Number(still));
  await stage.screenshot({ path: output });
  await browser.close();
  console.log('saved', output);
  process.exit(0);
}

const duration = await page.evaluate(() => window.DURATION);
const from = Number(opt('from', 0));
const to = Math.min(Number(opt('to', duration)), duration);
const frames = Math.round((to - from) * fps);

const ff = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
if (audio) ff.push('-ss', String(from), '-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
ff.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
const enc = spawn('ffmpeg', ff, { stdio: ['pipe', 'inherit', 'inherit'] });

for (let i = 0; i < frames; i++) {
  await page.evaluate(t => window.renderFrame(t), from + i / fps);
  const buf = await stage.screenshot({ type: 'jpeg', quality: 95 });
  if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once('drain', r));
  if (i % fps === 0) process.stdout.write(`\r${(from + i / fps).toFixed(1)}s / ${to.toFixed(1)}s`);
}
enc.stdin.end();
await new Promise((res, rej) => enc.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))));
await browser.close();
console.log(`\nsaved ${output} (${frames} frames, ${fps}fps)`);
