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
// UI (created only in a browser; the parsers above stay node-testable)
// ---------------------------------------------------------------------------

const CSS = `
:root{color-scheme:light dark;--fg:#1a1a2e;--bg:#fff;--muted:#667;--line:#e2e2ea;--accent:#5b4dff;--code:#f5f5f8}
@media (prefers-color-scheme:dark){:root{--fg:#e4e4ef;--bg:#121218;--muted:#99a;--line:#2a2a36;--accent:#8f85ff;--code:#1c1c26}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
header h1{font-size:18px;margin:0}header .muted{color:var(--muted);font-size:13px}
header .spacer{flex:1}
nav.tabs{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--line)}
nav.tabs button{border:0;background:none;color:var(--muted);padding:9px 12px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
nav.tabs button.active{color:var(--fg);border-bottom-color:var(--accent)}
main{display:flex;min-height:calc(100vh - 100px)}
#tree{width:290px;min-width:200px;border-right:1px solid var(--line);padding:12px 8px;overflow:auto}
#tree ul{list-style:none;margin:0;padding-left:16px}#tree>ul{padding-left:4px}
#tree li>span,#tree li>a{display:block;padding:2px 6px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}
#tree li>span:hover,#tree li>a:hover{background:var(--code);text-decoration:none}
#tree .dir::before{content:"▸ ";color:var(--muted)}#tree .dir.open::before{content:"▾ "}
#content{flex:1;padding:18px 26px;overflow:auto;min-width:0}
#content pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto}
#content code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:13px}
#content pre code{padding:0}
.commit{padding:10px 0;border-bottom:1px solid var(--line)}
.commit .sha{font-family:ui-monospace,monospace;color:var(--muted);font-size:12px}
.filehead{color:var(--muted);font-size:13px;margin-bottom:8px}
.status{padding:40px;text-align:center;color:var(--muted)}
select{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px}
img.blob{max-width:100%}
`;

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
  const status = el('div', { class: 'status' }, 'Loading repo from the relay…');
  document.body.append(status);

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
  const fullRigUrl = `${FULL_RIG_URL}/#/${hexToNpub(ownerHex)}/${encodeURIComponent(repo)}?relay=${encodeURIComponent(relay)}`;

  status.remove();
  document.title = `${name ?? repo} — Rig`;

  // ── Chrome ────────────────────────────────────────────────────────────────
  const refSelect = el('select');
  for (const refName of refs.keys()) {
    refSelect.append(
      el('option', refName === head ? { value: refName, selected: '' } : { value: refName },
        refName.replace(/^refs\/(heads|tags)\//, ''))
    );
  }
  const content = el('div', { id: 'content' });
  const treePane = el('div', { id: 'tree' });
  const tabFiles = el('button', { class: 'active' }, 'Files');
  const tabCommits = el('button', {}, 'Commits');
  document.body.append(
    el('header', {},
      el('h1', {}, name ?? repo),
      el('span', { class: 'muted' }, description ?? ''),
      el('span', { class: 'spacer' }),
      refSelect,
      el('a', { href: fullRigUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open in full Rig ↗')
    ),
    el('nav', { class: 'tabs' }, tabFiles, tabCommits),
    el('main', {}, treePane, content)
  );

  const setStatus = (msg) => {
    content.replaceChildren(el('div', { class: 'status' }, msg));
  };

  // ── File viewing ──────────────────────────────────────────────────────────
  async function showBlob(path, sha) {
    setStatus(`Loading ${path}…`);
    try {
      const { body } = await fetchObject(sha, arweave);
      const head_ = el('div', { class: 'filehead' }, `${path} · ${body.length} bytes · sha ${sha.slice(0, 12)} · SHA-1 verified ✓`);
      const ext = (path.match(IMAGE_EXT) ?? [])[1]?.toLowerCase();
      if (ext) {
        const url = URL.createObjectURL(new Blob([body], { type: IMAGE_MIME[ext] }));
        content.replaceChildren(head_, el('img', { class: 'blob', src: url, alt: path }));
      } else if (!isProbablyText(body)) {
        content.replaceChildren(head_, el('p', { class: 'status' }, 'Binary file.'));
      } else {
        const text = new TextDecoder().decode(body);
        if (/\.(md|markdown)$/i.test(path)) {
          const div = el('div');
          div.innerHTML = renderMarkdown(text);
          content.replaceChildren(head_, div);
        } else {
          content.replaceChildren(head_, el('pre', {}, el('code', {}, text)));
        }
      }
    } catch (err) {
      setStatus(String(err.message ?? err));
    }
  }

  // ── Tree rendering (lazy per directory) ───────────────────────────────────
  async function renderTreeInto(ul, treeSha, prefix) {
    const { body } = await fetchObject(treeSha, arweave);
    for (const entry of parseTree(body)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isTree) {
        const childUl = el('ul');
        childUl.hidden = true;
        let loaded = false;
        const label = el('span', {
          class: 'dir',
          onclick: async () => {
            childUl.hidden = !childUl.hidden;
            label.classList.toggle('open', !childUl.hidden);
            if (!loaded) {
              loaded = true;
              try {
                await renderTreeInto(childUl, entry.sha, path);
              } catch (err) {
                childUl.append(el('li', {}, String(err.message ?? err)));
              }
            }
          },
        }, entry.name);
        ul.append(el('li', {}, label, childUl));
      } else {
        ul.append(el('li', {}, el('a', { onclick: () => showBlob(path, entry.sha) }, entry.name)));
      }
    }
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  let rootCommit = null;
  async function showFiles() {
    tabFiles.classList.add('active');
    tabCommits.classList.remove('active');
    treePane.hidden = false;
    const refName = refSelect.value;
    const commitSha = refs.get(refName);
    setStatus('Loading tree…');
    treePane.replaceChildren();
    try {
      const commitObj = await fetchObject(commitSha, arweave);
      rootCommit = parseCommit(commitObj.body);
      const rootUl = el('ul');
      treePane.append(rootUl);
      await renderTreeInto(rootUl, rootCommit.tree, '');
      // README on home, when present at the root.
      const { body } = await fetchObject(rootCommit.tree, arweave);
      const readme = parseTree(body).find((e) => /^readme(\.(md|markdown|txt))?$/i.test(e.name));
      if (readme) await showBlob(readme.name, readme.sha);
      else setStatus('Select a file.');
    } catch (err) {
      setStatus(String(err.message ?? err));
    }
  }

  async function showCommits() {
    tabCommits.classList.add('active');
    tabFiles.classList.remove('active');
    treePane.hidden = true;
    setStatus('Loading commits…');
    try {
      const list = el('div');
      let sha = refs.get(refSelect.value);
      for (let i = 0; i < MAX_COMMITS && sha; i++) {
        const { body } = await fetchObject(sha, arweave);
        const commit = parseCommit(body);
        list.append(
          el('div', { class: 'commit' },
            el('div', {}, commit.message.split('\n')[0] || '(no message)'),
            el('div', { class: 'sha' },
              `${sha.slice(0, 12)} · ${commit.author ?? 'unknown'}${commit.date ? ` · ${commit.date.toISOString().slice(0, 10)}` : ''}`)
          )
        );
        sha = commit.parents[0];
        if (sha && !arweave.has(sha)) break; // history beyond the uploaded set
      }
      content.replaceChildren(list);
    } catch (err) {
      setStatus(String(err.message ?? err));
    }
  }

  tabFiles.addEventListener('click', showFiles);
  tabCommits.addEventListener('click', showCommits);
  refSelect.addEventListener('change', showFiles);
  await showFiles();
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
