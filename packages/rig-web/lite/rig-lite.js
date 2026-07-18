/**
 * rig-lite — the permanent, free-tier Arweave build of the Rig.
 *
 * A single self-contained ES module (< 95 KiB — fits BOTH the TOON store's
 * single-packet upload cap and ArDrive Turbo's free tier) that renders a
 * pushed TOON repo read-only in the browser: repo header, branches, file
 * tree, file contents, commit log, README. No framework, no build step, no
 * external assets — everything the React Rig needs a 2.1 MB bundle for is
 * deliberately out of scope (issues/PRs/blame/syntax highlighting); a
 * "full Rig" link points at the rich deployment.
 *
 * BOOT CONTRACT (shared with rig-web's `rig-pointer-html.ts`): the per-repo
 * pointer page published by `rig push` (packages/rig/src/rig-pointer.ts)
 * sets `window.__RIG_CONFIG__ = { relay, owner, repo }` and loads this file
 * as `<script type="module" src="https://<gateway>/<rig-lite-txid>">`. The
 * pointer URL stays in the address bar; everything renders in place from
 * Arweave.
 *
 * DATA SOURCES (all free reads):
 *  - kind:30617 announce + kind:30618 refs/state over the relay WebSocket
 *    (`['r', ref, sha]`, `['HEAD', 'ref: …']`, `['arweave', sha, txId]` tags
 *    — the same events `rig push` publishes).
 *  - Git object BODIES from Arweave gateways (the store keeps content after
 *    the envelope NUL, uncompressed). Every body is SHA-1-verified by
 *    re-wrapping it as each object type until the envelope hash matches the
 *    expected sha — bytes that verify under no type are rejected
 *    (mirrors packages/rig/src/object-fetch.ts; integrity is non-negotiable).
 */

// ---------------------------------------------------------------------------
// Config + constants
// ---------------------------------------------------------------------------

const GATEWAYS = ['https://arweave.net', 'https://permagate.io', 'https://ar-io.dev'];
const FULL_RIG_URL = 'https://toon-protocol.github.io/toon-client';
const ANNOUNCE_KIND = 30617;
const REFS_KIND = 30618;
const MAX_COMMITS = 30;
const FETCH_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// bech32 (npub ↔ hex) — BIP-173 subset, decode + encode for npub only
// ---------------------------------------------------------------------------

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function b32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function b32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || (acc << (to - bits)) & maxv) {
    return null;
  }
  return out;
}

/** Decode an npub to 64-hex; passes 64-hex through; null on anything else. */
export function ownerToHex(owner) {
  if (/^[0-9a-f]{64}$/i.test(owner)) return owner.toLowerCase();
  const lower = owner.toLowerCase();
  if (!lower.startsWith('npub1')) return null;
  const data = [];
  for (const c of lower.slice(5)) {
    const v = B32.indexOf(c);
    if (v === -1) return null;
    data.push(v);
  }
  if (b32Polymod([...b32HrpExpand('npub'), ...data]) !== 1) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Encode 64-hex as npub (display). */
export function hexToNpub(hex) {
  const bytes = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const data = convertBits(bytes, 8, 5, true);
  const values = [...b32HrpExpand('npub'), ...data, 0, 0, 0, 0, 0, 0];
  const mod = b32Polymod(values) ^ 1;
  let checksum = '';
  for (let i = 0; i < 6; i++) checksum += B32[(mod >> (5 * (5 - i))) & 31];
  return `npub1${data.map((d) => B32[d]).join('')}${checksum}`;
}

// ---------------------------------------------------------------------------
// Relay read (one REQ, EOSE-bounded)
// ---------------------------------------------------------------------------

/** Latest event per kind for this (owner, repo); resolves at EOSE. */
export function fetchRepoEvents(relay, ownerHex, repoId, WS = WebSocket) {
  return new Promise((resolve, reject) => {
    const ws = new WS(relay);
    const latest = new Map();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`relay timeout: ${relay}`));
    }, FETCH_TIMEOUT_MS);
    ws.onopen = () =>
      ws.send(
        JSON.stringify([
          'REQ',
          'rig-lite',
          { kinds: [ANNOUNCE_KIND, REFS_KIND], authors: [ownerHex], '#d': [repoId] },
        ])
      );
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg[0] === 'EVENT' && msg[2]) {
        const ev = msg[2];
        const prev = latest.get(ev.kind);
        if (!prev || ev.created_at > prev.created_at) latest.set(ev.kind, ev);
      } else if (msg[0] === 'EOSE') {
        clearTimeout(timer);
        ws.close();
        resolve(latest);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`relay connection failed: ${relay}`));
    };
  });
}

/** Parse the kind:30618 refs event into { refs, head, arweave }. */
export function parseRefsEvent(ev) {
  const refs = new Map();
  const arweave = new Map();
  let head = null;
  for (const tag of ev?.tags ?? []) {
    if (tag[0] === 'r' && tag[1] && tag[2]) refs.set(tag[1], tag[2]);
    else if (tag[0] === 'arweave' && tag[1] && tag[2]) arweave.set(tag[1], tag[2]);
    else if (tag[0] === 'HEAD' && tag[1]?.startsWith('ref: ')) head = tag[1].slice(5);
  }
  return { refs, head: head ?? refs.keys().next().value ?? null, arweave };
}

/** Parse the kind:30617 announce into { name, description }. */
export function parseAnnounceEvent(ev) {
  let name = null;
  let description = null;
  for (const tag of ev?.tags ?? []) {
    if (tag[0] === 'name' && tag[1]) name = tag[1];
    else if (tag[0] === 'description' && tag[1]) description = tag[1];
  }
  return { name, description };
}

// ---------------------------------------------------------------------------
// Git objects: fetch (gateway fallback) + SHA-1 verify + parse
// ---------------------------------------------------------------------------

const OBJECT_TYPES = ['commit', 'tree', 'blob', 'tag'];
const objectCache = new Map(); // sha → {type, body}

async function sha1Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verify a body against a sha by re-wrapping under each type; null if none. */
export async function verifyBody(sha, body) {
  const enc = new TextEncoder();
  for (const type of OBJECT_TYPES) {
    const header = enc.encode(`${type} ${body.length}\0`);
    const enveloped = new Uint8Array(header.length + body.length);
    enveloped.set(header);
    enveloped.set(body, header.length);
    if ((await sha1Hex(enveloped)) === sha) return type;
  }
  return null;
}

async function fetchObject(sha, arweaveMap) {
  const cached = objectCache.get(sha);
  if (cached) return cached;
  const txId = arweaveMap.get(sha);
  if (!txId) throw new Error(`no Arweave tx recorded for ${sha.slice(0, 12)}`);
  let lastErr = null;
  for (const gateway of GATEWAYS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${gateway}/${txId}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      const type = await verifyBody(sha, body);
      if (!type) throw new Error('SHA-1 verification failed');
      const obj = { type, body };
      objectCache.set(sha, obj);
      return obj;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `object ${sha.slice(0, 12)} unavailable: ${lastErr?.message ?? 'all gateways failed'}`
  );
}

/** Parse a tree body: `<mode> <name>\0<sha20>` repeating. */
export function parseTree(body) {
  const entries = [];
  const dec = new TextDecoder();
  let i = 0;
  while (i < body.length) {
    let sp = i;
    while (sp < body.length && body[sp] !== 0x20) sp++;
    let nul = sp + 1;
    while (nul < body.length && body[nul] !== 0x00) nul++;
    if (nul + 20 > body.length) break;
    const mode = dec.decode(body.subarray(i, sp));
    const name = dec.decode(body.subarray(sp + 1, nul));
    let sha = '';
    for (let j = nul + 1; j <= nul + 20; j++) sha += body[j].toString(16).padStart(2, '0');
    entries.push({ mode, name, sha, isTree: mode === '40000' || mode === '040000' });
    i = nul + 21;
  }
  // Directories first, then files, each alphabetical (forge convention).
  return entries.sort(
    (a, b) => Number(b.isTree) - Number(a.isTree) || a.name.localeCompare(b.name)
  );
}

/** Parse a commit body: tree/parent headers + author line + message. */
export function parseCommit(body) {
  const text = new TextDecoder().decode(body);
  const nl2 = text.indexOf('\n\n');
  const headerText = nl2 === -1 ? text : text.slice(0, nl2);
  const message = nl2 === -1 ? '' : text.slice(nl2 + 2);
  const out = { tree: null, parents: [], author: null, date: null, message };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = line.match(/^author (.*?) <[^>]*> (\d+)/);
      if (m) {
        out.author = m[1];
        out.date = new Date(Number(m[2]) * 1000);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mini markdown (README): headings, fences, inline code, bold/italic, links,
// lists, paragraphs. Escapes first; emits only tags this file writes.
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

export function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inFence = false;
  let fence = [];
  let inList = false;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      flushPara();
      flushList();
      if (inFence) {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const h = line.match(/^(#{1,6}) +(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      continue;
    }
    const li = line.match(/^\s*[-*] +(.*)$/);
    if (li) {
      flushPara();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    para.push(line.trim());
  }
  if (inFence && fence.length)
    out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  flushPara();
  flushList();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// UI (created only in a browser; the parsers above stay node-testable).
// The markup mirrors rig-web's repo pages 1:1 — repo-glyph breadcrumb header
// with the Public pill, octicon tab nav, bordered file TABLE with path
// breadcrumbs, and the README card — using the full Rig's design tokens
// VERBATIM (rig-web/src/web/globals.css: shadcn "new-york" structure, GitHub
// palette). Inlined rather than a Tailwind/shadcn CDN: this page is a
// permanent Arweave tx and must never depend on a mutable external origin;
// shadcn is vendored React source, not a hosted library, so the tokens ARE
// its portable form.
// ---------------------------------------------------------------------------

const CSS = `
:root{color-scheme:light dark;--background:#ffffff;--foreground:#1f2328;--primary:#1f2328;--secondary:#f6f8fa;--muted:#f6f8fa;--muted-foreground:#656d76;--accent:#f6f8fa;--success:#1f883d;--border:#d1d9e0;--ring:#0969da;--radius:0.375rem;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--background:#0d1117;--foreground:#e6edf3;--primary:#e6edf3;--secondary:#161b22;--muted:#161b22;--muted-foreground:#8b949e;--accent:#161b22;--success:#238636;--border:#30363d;--ring:#58a6ff;--link:#58a6ff}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--foreground);background:var(--background)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
svg{vertical-align:text-bottom;fill:currentColor}
.container{max-width:1216px;margin:0 auto;padding:24px 32px}
.repo-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.repo-head svg{color:var(--muted-foreground)}
.repo-head .owner{color:var(--link)}
.repo-head .sep{color:var(--muted-foreground)}
.repo-head .name{font-weight:600;color:var(--link)}
.pill{margin-left:4px;border:1px solid var(--border);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:500;color:var(--muted-foreground)}
.desc{margin:6px 0 0;font-size:14px;color:var(--muted-foreground)}
nav.tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--border);margin-top:16px}
nav.tabs .tab{display:flex;align-items:center;gap:6px;border:0;background:none;color:var(--muted-foreground);padding:8px 12px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;text-decoration:none}
nav.tabs .tab:hover{color:var(--foreground);border-bottom-color:color-mix(in srgb,var(--muted-foreground) 30%,transparent);text-decoration:none}
nav.tabs .tab.active{color:var(--foreground);border-bottom-color:var(--primary)}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:16px 0;flex-wrap:wrap}
.crumbs{font-size:14px}
.crumbs .cur{font-weight:600;color:var(--foreground)}
.crumbs .sep{color:var(--muted-foreground);padding:0 4px}
.crumbs a{cursor:pointer}
select{font:inherit;font-size:13px;background:var(--secondary);color:var(--foreground);border:1px solid var(--border);border-radius:var(--radius);padding:4px 8px}
select:focus{outline:2px solid var(--ring);outline-offset:1px}
.card{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px;background:var(--background)}
table.files{width:100%;border-collapse:collapse}
table.files td{padding:7px 8px;border-top:1px solid var(--border);font-size:14px}
table.files tr:first-child td{border-top:0}
table.files tr:hover{background:var(--accent)}
table.files td.icon{width:32px;padding-left:14px;padding-right:0;color:var(--muted-foreground)}
table.files a{color:var(--foreground);cursor:pointer}
table.files a:hover{color:var(--link);text-decoration:underline}
.cardhead{display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);padding:0 16px}
.cardhead .htab{display:flex;align-items:center;gap:6px;padding:10px 8px;font-size:13px;font-weight:600;border-bottom:2px solid var(--primary);color:var(--foreground)}
.cardhead svg{color:var(--muted-foreground)}
.prose{padding:24px;max-width:none;font-size:15px;line-height:1.6}
.prose h1,.prose h2{border-bottom:1px solid var(--border);padding-bottom:6px}
.prose pre{background:var(--muted);border:1px solid var(--border);padding:14px;border-radius:calc(var(--radius) + 2px);overflow:auto;font-size:13px;line-height:1.45}
.prose code{background:var(--muted);padding:2px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:85%}
.prose pre code{padding:0;background:none;border:0}
.filehead{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);padding:10px 16px;font-size:12px;color:var(--muted-foreground)}
.filehead .fname{font-weight:600;color:var(--foreground);font-size:13px}
.blobbody pre{margin:0;padding:16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:12.5px;line-height:1.5}
.commit{display:flex;justify-content:space-between;gap:12px;padding:10px 16px;border-top:1px solid var(--border)}
.commit:first-child{border-top:0}
.commit .msg{font-weight:600;color:var(--foreground)}
.commit .meta{color:var(--muted-foreground);font-size:12px;margin-top:2px}
.commit .sha{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted-foreground);font-size:12px;white-space:nowrap}
.status{padding:48px;text-align:center;color:var(--muted-foreground)}
img.blob{max-width:100%;display:block;margin:16px}
`;

// GitHub octicons (path data copied from rig-web's repo-layout / file-tree).
const ICONS = {
  repo: 'M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z',
  code: 'M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06L11.28 3.22z',
  issues: 'M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z',
  pulls: 'M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zm5.677-.177L9.573.677A.25.25 0 0110 .854V2.5h1A2.5 2.5 0 0113.5 5v5.628a2.251 2.251 0 11-1.5 0V5a1 1 0 00-1-1h-1v1.646a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm0 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm8.25.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z',
  commits: 'M11.93 8.5a4.002 4.002 0 01-7.86 0H.75a.75.75 0 010-1.5h3.32a4.002 4.002 0 017.86 0h3.32a.75.75 0 010 1.5h-3.32zm-1.43-.75a2.5 2.5 0 10-5 0 2.5 2.5 0 005 0z',
  folder: 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z',
  file: 'M3.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v9.086A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25V1.75z',
  book: 'M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h4.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-4.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.06 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75zm7.251 10.324l.004-5.073-.002-2.253A2.25 2.25 0 005.003 2.5H1.5v9h3.757a3.75 3.75 0 011.994.574zM8.755 4.75l-.004 7.322a3.752 3.752 0 011.992-.572H14.5v-9h-3.495a2.25 2.25 0 00-2.25 2.25z',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function isProbablyText(bytes) {
  const n = Math.min(bytes.length, 2048);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
};

async function boot() {
  const config = window.__RIG_CONFIG__ ?? {};
  const params = new URLSearchParams((location.hash.split('?')[1] ?? ''));
  const relay = config.relay ?? params.get('relay');
  const owner = config.owner ?? params.get('owner');
  const repo = config.repo ?? params.get('repo');

  document.head.append(el('style', {}, CSS));
  const container = el('div', { class: 'container' });
  document.body.append(container);
  const status = el('div', { class: 'status' }, 'Loading repo from the relay…');
  container.append(status);

  const fail = (msg) => {
    status.textContent = msg;
  };
  if (!relay || !owner || !repo) {
    return fail('rig-lite: missing relay/owner/repo boot config (window.__RIG_CONFIG__).');
  }
  const ownerHex = ownerToHex(owner);
  if (!ownerHex) return fail(`rig-lite: unrecognized owner ${owner}`);

  let events;
  try {
    events = await fetchRepoEvents(relay, ownerHex, repo, WebSocket);
  } catch (err) {
    return fail(String(err.message ?? err));
  }
  const refsEvent = events.get(REFS_KIND);
  if (!refsEvent) return fail(`No repo state found for ${repo} on ${relay}.`);
  const { refs, head, arweave } = parseRefsEvent(refsEvent);
  const { name, description } = parseAnnounceEvent(events.get(ANNOUNCE_KIND));
  const ownerNpub = hexToNpub(ownerHex);
  const fullRigBase = `${FULL_RIG_URL}/#/${ownerNpub}`;
  const fullRigRepo = `${fullRigBase}/${encodeURIComponent(repo)}`;
  const relayQ = `?relay=${encodeURIComponent(relay)}`;

  status.remove();
  document.title = `${name ?? repo} — Rig`;

  // ── Repo header: glyph + owner / name + Public pill (repo-layout.tsx) ─────
  const refSelect = el('select');
  for (const refName of refs.keys()) {
    refSelect.append(
      el('option', refName === head ? { value: refName, selected: '' } : { value: refName },
        refName.replace(/^refs\/(heads|tags)\//, ''))
    );
  }
  const shortOwner = `${ownerNpub.slice(0, 12)}…${ownerNpub.slice(-4)}`;
  container.append(
    el('div', { class: 'repo-head' },
      icon('repo'),
      el('a', { class: 'owner', href: fullRigBase + relayQ, target: '_blank', rel: 'noopener noreferrer', title: ownerNpub }, shortOwner),
      el('span', { class: 'sep' }, '/'),
      el('span', { class: 'name' }, name ?? repo),
      el('span', { class: 'pill' }, 'Public')
    )
  );
  if (description) container.append(el('p', { class: 'desc' }, description));

  // ── Tab nav (Code/Commits native; Issues/PRs open the full Rig) ──────────
  const tabCode = el('button', { class: 'tab active' }, icon('code'), 'Code');
  const tabCommits = el('button', { class: 'tab' }, icon('commits'), 'Commits');
  container.append(
    el('nav', { class: 'tabs' },
      tabCode,
      el('a', { class: 'tab', href: `${fullRigRepo}/issues${relayQ}`, target: '_blank', rel: 'noopener noreferrer' }, icon('issues'), 'Issues'),
      el('a', { class: 'tab', href: `${fullRigRepo}/pulls${relayQ}`, target: '_blank', rel: 'noopener noreferrer' }, icon('pulls'), 'Pull Requests'),
      tabCommits
    )
  );

  const view = el('div');
  container.append(view);
  const setStatus = (msg) => {
    view.replaceChildren(el('div', { class: 'status' }, msg));
  };
  const setActive = (tab) => {
    for (const t of [tabCode, tabCommits]) t.classList.toggle('active', t === tab);
  };

  // ── Blob view: filename card + rendered contents (blob-page.tsx) ─────────
  async function showBlob(pathSegs, sha) {
    const path = pathSegs.join('/');
    setStatus(`Loading ${path}…`);
    try {
      const { body } = await fetchObject(sha, arweave);
      const card = el('div', { class: 'card' },
        el('div', { class: 'filehead' },
          icon('file', 14),
          el('span', { class: 'fname' }, pathSegs.at(-1)),
          el('span', {}, `${body.length} bytes · sha ${sha.slice(0, 12)} · SHA-1 verified ✓`)
        )
      );
      const ext = (path.match(IMAGE_EXT) ?? [])[1]?.toLowerCase();
      if (ext) {
        const url = URL.createObjectURL(new Blob([body], { type: IMAGE_MIME[ext] }));
        card.append(el('img', { class: 'blob', src: url, alt: path }));
      } else if (!isProbablyText(body)) {
        card.append(el('p', { class: 'status' }, 'Binary file.'));
      } else {
        const text = new TextDecoder().decode(body);
        if (/\.(md|markdown)$/i.test(path)) {
          const div = el('div', { class: 'prose' });
          div.innerHTML = renderMarkdown(text);
          card.append(div);
        } else {
          card.append(el('div', { class: 'blobbody' }, el('pre', {}, text)));
        }
      }
      view.replaceChildren(crumbBar(pathSegs, true), card);
    } catch (err) {
      setStatus(String(err.message ?? err));
    }
  }

  // ── Path breadcrumb (tree-page.tsx) ──────────────────────────────────────
  function crumbBar(pathSegs, isBlob) {
    const crumbs = el('span', { class: 'crumbs' });
    crumbs.append(el('a', { onclick: () => showDir([]) }, name ?? repo));
    pathSegs.forEach((seg, i) => {
      crumbs.append(el('span', { class: 'sep' }, '/'));
      const isLast = i === pathSegs.length - 1;
      if (isLast) crumbs.append(el('span', { class: 'cur' }, seg));
      else crumbs.append(el('a', { onclick: () => showDir(pathSegs.slice(0, i + 1)) }, seg));
    });
    const bar = el('div', { class: 'toolbar' }, crumbs);
    if (!isBlob && pathSegs.length === 0) bar.append(refSelect);
    return bar;
  }

  // ── Directory view: bordered file table (file-tree.tsx) + README card ────
  async function resolveTreeAt(pathSegs) {
    const commitSha = refs.get(refSelect.value);
    const commitObj = await fetchObject(commitSha, arweave);
    let treeSha = parseCommit(commitObj.body).tree;
    for (const seg of pathSegs) {
      const { body } = await fetchObject(treeSha, arweave);
      const entry = parseTree(body).find((e) => e.name === seg && e.isTree);
      if (!entry) throw new Error(`no such directory: ${pathSegs.join('/')}`);
      treeSha = entry.sha;
    }
    return treeSha;
  }

  async function showDir(pathSegs) {
    setActive(tabCode);
    setStatus('Loading tree…');
    try {
      const treeSha = await resolveTreeAt(pathSegs);
      const { body } = await fetchObject(treeSha, arweave);
      const entries = parseTree(body);

      const table = el('table', { class: 'files' });
      for (const entry of entries) {
        const segs = [...pathSegs, entry.name];
        const link = entry.isTree
          ? el('a', { onclick: () => showDir(segs) }, entry.name)
          : el('a', { onclick: () => showBlob(segs, entry.sha) }, entry.name);
        table.append(
          el('tr', {},
            el('td', { class: 'icon' }, icon(entry.isTree ? 'folder' : 'file')),
            el('td', {}, link)
          )
        );
      }
      const parts = [crumbBar(pathSegs, false), el('div', { class: 'card' }, table)];

      // README card on the repo home (repo-home-page.tsx).
      if (pathSegs.length === 0) {
        const readme = entries.find((e) => !e.isTree && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
        if (readme) {
          try {
            const { body: readmeBody } = await fetchObject(readme.sha, arweave);
            const prose = el('div', { class: 'prose' });
            if (/\.(md|markdown)$/i.test(readme.name) || !readme.name.includes('.')) {
              prose.innerHTML = renderMarkdown(new TextDecoder().decode(readmeBody));
            } else {
              prose.append(el('pre', {}, new TextDecoder().decode(readmeBody)));
            }
            parts.push(
              el('div', { class: 'card' },
                el('div', { class: 'cardhead' }, el('span', { class: 'htab' }, icon('book', 14), 'README')),
                prose
              )
            );
          } catch {
            // README fetch failure never blocks the file listing.
          }
        }
      }
      view.replaceChildren(...parts);
    } catch (err) {
      setStatus(String(err.message ?? err));
    }
  }

  // ── Commit log (commit-log-page.tsx) ─────────────────────────────────────
  async function showCommits() {
    setActive(tabCommits);
    setStatus('Loading commits…');
    try {
      const card = el('div', { class: 'card' });
      let sha = refs.get(refSelect.value);
      for (let i = 0; i < MAX_COMMITS && sha; i++) {
        const { body } = await fetchObject(sha, arweave);
        const commit = parseCommit(body);
        card.append(
          el('div', { class: 'commit' },
            el('div', {},
              el('div', { class: 'msg' }, commit.message.split('\n')[0] || '(no message)'),
              el('div', { class: 'meta' },
                `${commit.author ?? 'unknown'}${commit.date ? ` committed on ${commit.date.toISOString().slice(0, 10)}` : ''}`)
            ),
            el('span', { class: 'sha' }, sha.slice(0, 7))
          )
        );
        sha = commit.parents[0];
        if (sha && !arweave.has(sha)) break; // history beyond the uploaded set
      }
      view.replaceChildren(el('div', { class: 'toolbar' }, el('span', { class: 'crumbs' }, ''), refSelect), card);
    } catch (err) {
      setStatus(String(err.message ?? err));
    }
  }

  tabCode.addEventListener('click', () => showDir([]));
  tabCommits.addEventListener('click', showCommits);
  refSelect.addEventListener('change', () => {
    if (tabCommits.classList.contains('active')) void showCommits();
    else void showDir([]);
  });
  await showDir([]);
}

// Auto-boot only in a browser with the pointer's config (or hash params);
// importing this module in tests never touches the DOM.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const hasConfig =
    window.__RIG_CONFIG__ || location.hash.includes('relay=');
  if (hasConfig) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void boot());
    } else {
      void boot();
    }
  }
}
