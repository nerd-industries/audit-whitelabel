#!/usr/bin/env node
// Sets up (or updates) your shop's Remote Access Audit on Cloudflare Pages, so techs can run
//   irm audit.yourshop.com | iex
// Works on Windows, macOS and Linux. Needs Node.js 18+ and a free Cloudflare account.
//
//   node deploy.mjs            ask for your shop details, then deploy
//   node deploy.mjs --update   deploy again with the details already saved in brand.json
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND = join(HERE, 'brand.json');
const PUBLIC = join(HERE, 'public');
const WRANGLER = ['--yes', 'wrangler@4'];
const isWin = process.platform === 'win32';
const update = process.argv.includes('--update');

const say = (s = '') => console.log(s);
const fail = (s) => { console.error(`\nERROR: ${s}`); process.exit(1); };

function npx(args, { capture = false } = {}) {
  const r = spawnSync(isWin ? 'npx.cmd' : 'npx', [...WRANGLER, ...args], {
    cwd: HERE, stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', shell: isWin,
  });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Line reader that also works when answers are piped in (readline's question() drops early lines).
function lineReader() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const queue = [], waiting = [];
  let closed = false;
  rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : queue.push(l)));
  rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null); });
  return {
    question(q) {
      process.stdout.write(q);
      if (queue.length) { const l = queue.shift(); if (!process.stdin.isTTY) say(l); return Promise.resolve(l); }
      if (closed) return Promise.resolve(null);
      return new Promise((r) => waiting.push(r));
    },
    close: () => rl.close(),
  };
}

async function ask(rl, label, current, { required = false, example = '' } = {}) {
  for (;;) {
    const hint = current ? ` [${current}]` : example ? ` (e.g. ${example})` : '';
    const line = await rl.question(`${label}${hint}: `);
    if (line === null && required && !current) fail(`${label} is required.`);
    const v = (line || '').trim() || current || '';
    if (v || !required) return v;
    say('  This one is required.');
  }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

async function collectBrand() {
  mkdirSync(PUBLIC, { recursive: true });
  const old = existsSync(BRAND) ? JSON.parse(readFileSync(BRAND, 'utf8')) : {};
  if (update) {
    if (!old.name || !old.domain) fail('brand.json is missing. Run "node deploy.mjs" without --update first.');
    return old;
  }
  const rl = lineReader();
  say('Your shop details appear in the audit window, its report, the printed customer report and the web page.');
  say('Press Enter to keep the value in [brackets].\n');
  const b = { ...old };
  b.name = await ask(rl, 'Shop name', old.name, { required: true, example: 'Main Street Computers' });
  b.tagline = await ask(rl, 'Short tagline', old.tagline, { example: 'Computer & Phone Repair' });
  b.address = await ask(rl, 'Address line', old.address, { example: '123 Main St, Yourtown, ST 12345' });
  b.phone = await ask(rl, 'Phone', old.phone, { example: '(555) 555-0123' });
  b.website = await ask(rl, 'Website', old.website, { example: 'yourshop.com' });
  const site = (b.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  b.domain = await ask(rl, 'Address for the audit', old.domain || (site ? `audit.${site}` : ''), { required: true, example: 'audit.yourshop.com' });
  b.domain = b.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const logoNow = old.logo && existsSync(join(PUBLIC, old.logo)) ? join(PUBLIC, old.logo) : '';
  for (;;) {
    let p = await ask(rl, 'Logo file (PNG, JPG or SVG; square works best)', logoNow);
    p = p.replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, homedir());
    if (!p) { b.logo = ''; break; }
    const full = resolve(p);
    if (!existsSync(full) || !statSync(full).isFile()) { say(`  Can't find ${full}`); continue; }
    const ext = extname(full).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.svg'].includes(ext)) { say('  Use a .png, .jpg or .svg file.'); continue; }
    if (statSync(full).size > 300 * 1024) say('  Note: this logo is over 300 KB. It is sent with every audit run; a smaller copy (about 240x240) is better.');
    for (const f of readdirSync(PUBLIC)) if (/^logo\.(png|jpe?g|svg)$/i.test(f)) unlinkSync(join(PUBLIC, f));
    b.logo = `logo${ext === '.jpeg' ? '.jpg' : ext}`;
    if (full !== join(PUBLIC, b.logo)) copyFileSync(full, join(PUBLIC, b.logo));
    break;
  }
  b.project = old.project || `${slug(b.name)}-audit`;
  b.trust = Array.isArray(old.trust) ? old.trust : [];
  rl.close();
  writeFileSync(BRAND, JSON.stringify(b, null, 2) + '\n');
  say(`\nSaved ${basename(BRAND)}.`);
  return b;
}

async function cfApi(token, method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success !== false, status: r.status, json: j };
}

// wrangler stores its login token here; we reuse it to attach the custom domain.
function wranglerToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const home = homedir();
  const places = [
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, '.wrangler/config/default.toml'),
    join(home, '.config/.wrangler/config/default.toml'),
    join(home, '.wrangler/config/default.toml'),
    join(home, 'Library/Preferences/.wrangler/config/default.toml'),
    process.env.APPDATA && join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'),
  ].filter(Boolean);
  for (const p of places) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  return '';
}

async function attachDomain(b, accountId) {
  const token = wranglerToken();
  const manual = () => {
    say('\nFinish the custom domain in the Cloudflare dashboard:');
    say(`  Workers & Pages > ${b.project} > Custom domains > Set up a custom domain > ${b.domain}`);
    say(`  If your DNS is not on Cloudflare, add a CNAME record: ${b.domain} -> ${b.project}.pages.dev`);
  };
  if (!token || !accountId) return manual();
  const list = await cfApi(token, 'GET', `/accounts/${accountId}/pages/projects/${b.project}/domains`);
  const have = list.ok && (list.json.result || []).some((d) => d.name === b.domain);
  if (!have) {
    const add = await cfApi(token, 'POST', `/accounts/${accountId}/pages/projects/${b.project}/domains`, { name: b.domain });
    if (!add.ok) { say(`\nCould not add ${b.domain} automatically (${add.json.errors?.[0]?.message || add.status}).`); return manual(); }
    say(`\nAdded ${b.domain} to the Pages project.`);
  } else say(`\n${b.domain} is already attached.`);
  // Point DNS at the project when the zone is on this Cloudflare account and the token may edit DNS.
  const labels = b.domain.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const zoneName = labels.slice(i).join('.');
    const z = await cfApi(token, 'GET', `/zones?name=${zoneName}`);
    const zone = z.ok && z.json.result?.[0];
    if (!zone) continue;
    const ex = await cfApi(token, 'GET', `/zones/${zone.id}/dns_records?name=${b.domain}`);
    if (ex.ok && ex.json.result?.length) { say(`DNS record for ${b.domain} already exists.`); return; }
    const rec = await cfApi(token, 'POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: b.domain, content: `${b.project}.pages.dev`, proxied: true });
    if (rec.ok) { say(`Created DNS record ${b.domain} -> ${b.project}.pages.dev`); return; }
    say(`\nAdd this DNS record in Cloudflare (DNS > Records > Add record):`);
    say(`  Type CNAME, Name ${labels.slice(0, i).join('.')}, Target ${b.project}.pages.dev, Proxied`);
    return;
  }
  say(`\nAt your DNS provider, add a CNAME record: ${b.domain} -> ${b.project}.pages.dev`);
}

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) fail(`Node.js 18 or newer is needed (you have ${process.versions.node}). Get it at https://nodejs.org`);
  const b = await collectBrand();

  // Pages needs at least one static file, even without a logo.
  writeFileSync(join(PUBLIC, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(join(HERE, 'wrangler.toml'),
    `# Written by deploy.mjs\nname = "${b.project}"\ncompatibility_date = "2024-11-01"\npages_build_output_dir = "public"\n`);

  say('\nChecking your Cloudflare login...');
  let who = npx(['whoami'], { capture: true });
  if (/not (logged in|authenticated)/i.test(who.out) || who.code) {
    say('A browser window will open. Log in to Cloudflare (a free account is fine) and click Allow.');
    if (npx(['login']).code) fail('Cloudflare login did not finish. Run "npx wrangler login" yourself, then run this again.');
    who = npx(['whoami'], { capture: true });
  }
  const accounts = [...new Set(who.out.match(/\b[0-9a-f]{32}\b/g) || [])];
  if (accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    say(who.out);
    fail('Your login has several Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID to the one to use, then run this again.');
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || accounts[0] || '';

  say(`\nCreating the Pages project "${b.project}" (skipped if it already exists)...`);
  const create = npx(['pages', 'project', 'create', b.project, '--production-branch', 'main'], { capture: true });
  if (create.code && !/already exists|8000002/i.test(create.out)) { say(create.out); fail('Could not create the Pages project.'); }

  say('\nUploading...');
  if (npx(['pages', 'deploy', 'public', '--project-name', b.project, '--branch', 'main', '--commit-dirty=true']).code) fail('Upload failed (see above).');

  await attachDomain(b, accountId);

  say('\nChecking the new site...');
  try {
    const r = await fetch(`https://${b.project}.pages.dev/`, { headers: { Accept: 'text/plain' } });
    const t = await r.text();
    if (t.includes('$RAA_Brand') && t.includes(b.name.replace(/'/g, "''"))) say(`OK: https://${b.project}.pages.dev serves your branded audit.`);
    else say(`The site answered, but not with the branded script yet. Wait a minute and open https://${b.project}.pages.dev`);
  } catch (e) { say(`Could not reach https://${b.project}.pages.dev yet (${e.message}). Give it a minute.`); }

  say('\nDone. On a customer PC, open Windows PowerShell and run:');
  say(`  irm ${b.domain} | iex`);
  say(`(Until the custom domain is active, use: irm ${b.project}.pages.dev | iex)`);
}

main().catch((e) => fail(e.stack || String(e)));
