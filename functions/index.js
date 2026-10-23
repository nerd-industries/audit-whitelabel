// Cloudflare Pages Function for a shop's own Remote Access Audit
// ---------------------------------------------------------------------------
// On every `irm audit.yourshop.com | iex` it fetches the LATEST
// RemoteAccessAudit.ps1 from github.com/nerd-industries/Remote-Access-Audit and
// puts a $RAA_Brand block (your name, logo, address, phone, website) in front of
// it, so the audit window, its report and the printed customer report carry your
// branding. A browser opening the address gets a branded instructions page.
//
// Your details live in ../brand.json and public/<logo>. Change them with
// `node deploy.mjs` (or edit them and run `npx wrangler pages deploy`).
// ---------------------------------------------------------------------------
import brand from '../brand.json';

const UPSTREAM_RAW =
  'https://raw.githubusercontent.com/nerd-industries/Remote-Access-Audit/main/RemoteAccessAudit.ps1';
const UPSTREAM_API =
  'https://api.github.com/repos/nerd-industries/Remote-Access-Audit/contents/RemoteAccessAudit.ps1';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const wantDownload =
    url.searchParams.has('download') || url.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/download');
  const accept = context.request.headers.get('Accept') || '';
  const host = url.host;

  // A browser (and not a download) gets the instructions page. `irm` does not send Accept: text/html.
  if (accept.includes('text/html') && !wantDownload) {
    return new Response(landingHtml(host), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  let script;
  try {
    script = await fetchUpstream(context.env);
  } catch (e) {
    return errorScript(502, String(e.message || e));
  }

  const logo = await logoDataUri(context, url);
  const body = brandBlock(url.origin, logo) + script.replace(/^﻿/, '');
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (wantDownload) {
    headers['content-type'] = 'application/octet-stream';
    headers['content-disposition'] = 'attachment; filename="RemoteAccessAudit.ps1"';
  }
  return new Response(body, { headers });
}

// With a GITHUB_TOKEN secret: the Contents API (always the newest commit, 5,000 requests/hour).
// Without one: raw.githubusercontent.com (no rate limit, at most ~5 minutes behind).
// UPSTREAM_URL (optional variable) serves the script from somewhere else, e.g. your own fork.
async function fetchUpstream(env) {
  if (env && env.UPSTREAM_URL) {
    const r = await fetch(env.UPSTREAM_URL, { headers: { 'User-Agent': 'audit-whitelabel' } });
    if (!r.ok) throw new Error(`${env.UPSTREAM_URL} returned ${r.status} ${r.statusText}`);
    return r.text();
  }
  const token = env && env.GITHUB_TOKEN;
  if (token) {
    const r = await fetch(UPSTREAM_API, {
      headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'audit-whitelabel', Authorization: `Bearer ${token}` },
    });
    if (r.ok) return r.text();
  }
  const r = await fetch(UPSTREAM_RAW, { headers: { 'User-Agent': 'audit-whitelabel' } });
  if (!r.ok) throw new Error(`GitHub returned ${r.status} ${r.statusText}`);
  return r.text();
}

const ps = (v) => "'" + String(v ?? '').replace(/'/g, "''").replace(/[\r\n]+/g, ' ') + "'";

function brandBlock(origin, logo) {
  const fields = {
    Name: brand.name,
    Tagline: brand.tagline,
    Address: brand.address,
    Phone: brand.phone,
    Website: brand.website,
    Logo: logo,
    Url: origin,
    Folder: brand.folder || '',
    Trust: (brand.trust || []).join(','),
  };
  const body = Object.entries(fields).map(([k, v]) => `${k} = ${ps(v)}`).join('; ');
  return `$RAA_Brand = @{ ${body} }\n`;
}

async function logoDataUri(context, url) {
  if (!brand.logo) return '';
  try {
    const r = await context.env.ASSETS.fetch(new Request(new URL('/' + brand.logo, url)));
    if (!r.ok) return '';
    const type = (r.headers.get('content-type') || 'image/png').split(';')[0];
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  } catch {
    return '';
  }
}

const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function landingHtml(host) {
  const cmd = `irm ${host} | iex`;
  const contact = [brand.phone, brand.website].filter(Boolean).map(esc).join(' &middot; ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(brand.name)} Remote Access Audit</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#ffffff; --panel:#f8fafc; --code:#0f172a; --codeink:#86efac; --btn:#0f172a; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e2e8f0; --muted:#94a3b8; --line:#334155; --bg:#0b1220; --panel:#111a2e; --code:#020617; --btn:#334155; } }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; background: var(--bg); color: var(--ink); margin: 0; line-height: 1.5; }
  main { max-width: 680px; margin: 48px auto; padding: 0 16px; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid var(--ink); padding-bottom: 14px; }
  header img { width: 56px; height: 56px; object-fit: contain; background: #fff; border-radius: 6px; }
  .name { font-size: 22px; font-weight: 700; } .tag { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; }
  h1 { font-size: 26px; margin: 28px 0 4px; } h2 { font-size: 17px; margin: 26px 0 6px; } p { margin: 0 0 10px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  pre { flex: 1; min-width: 240px; background: var(--code); color: var(--codeink); padding: 14px 16px; border-radius: 8px; margin: 0; overflow-x: auto; font-size: 16px; }
  button, .dl { border: 0; border-radius: 8px; background: var(--btn); color: #fff; font-weight: 600; padding: 12px 18px; cursor: pointer; font-size: 15px; text-decoration: none; display: inline-block; }
  small, .muted { color: var(--muted); } code { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
  footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
</style></head><body><main>
<header>${brand.logo ? `<img src="/${esc(brand.logo)}" alt="">` : ''}<div><div class="name">${esc(brand.name)}</div>${brand.tagline ? `<div class="tag">${esc(brand.tagline)}</div>` : ''}</div></header>
<h1>Remote Access Audit</h1>
<p class="muted">Finds remote-control software, hidden programs and backdoors that scammers leave on a Windows PC, and removes them.</p>
<h2>Run it</h2>
<p>On the PC, open <b>Windows PowerShell</b>, paste this line, press Enter and click <b>Yes</b> on the Windows prompt:</p>
<div class="row"><pre id="cmd">${esc(cmd)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('cmd').textContent).then(()=>{this.textContent='Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button></div>
<p class="muted" style="margin-top:10px">Windows 7 (needs WMF 5.1): <code>[Net.ServicePointManager]::SecurityProtocol='Tls12'; ${esc(cmd)}</code></p>
<h2>Or download it</h2>
<p>Save the file, right-click it and choose <i>Run with PowerShell</i>.</p>
<p><a class="dl" href="?download=1" download="RemoteAccessAudit.ps1">Download RemoteAccessAudit.ps1</a></p>
<h2>When it finishes</h2>
<p>Use the <b>Fix</b> buttons in the window, click <b>Rescan</b> to confirm, then close the window. The report opens in the browser; click <b>Print (1 page)</b> for the customer's copy.</p>
<footer><span>${esc(brand.address)}</span><span>${contact}</span></footer>
</main></body></html>`;
}

// Even on failure `| iex` prints a clear message instead of running garbage.
function errorScript(status, reason) {
  const body =
    `Write-Host 'Remote Access Audit could not be downloaded.' -ForegroundColor Red\n` +
    `Write-Host ${ps(reason)} -ForegroundColor Yellow\n`;
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
