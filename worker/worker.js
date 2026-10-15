// groupsimple backend: one Cloudflare Worker, no database.
//
//  Website form  ->  /submit  ->  posts a request to your private Discord channel
//  Mods click Approve  ->  /interactions  ->  commits the group + picture to your GitHub repo
//  Slash commands (/groups /remove /boost /unboost) edit groups.json the same way.
//
// Required settings (Cloudflare: Worker > Settings > Variables and Secrets):
//   DISCORD_PUBLIC_KEY   Discord developer portal > your app > General Information
//   DISCORD_APP_ID       same page (Application ID)
//   DISCORD_BOT_TOKEN    Bot page > Reset Token            (secret)
//   DISCORD_CHANNEL_ID   id of your private mod channel that receives requests
//   DISCORD_GUILD_ID     id of your Discord server (only used to register commands)
//   GITHUB_TOKEN         fine-grained token, Contents: read and write on the site repo (secret)
//   GITHUB_REPO          e.g. yourname/groupsimple
//   GITHUB_BRANCH        optional, defaults to main
//   ALLOWED_ORIGIN       your site origin, e.g. https://yourname.github.io  (comma separate for more)
//   SETUP_KEY            any long random text, used once to register the slash commands (secret)
//   ADMIN_USER_IDS       optional, comma separated Discord user ids that may always use the bot

const API = 'https://discord.com/api/v10';
const GH = 'https://api.github.com';
const MANAGE_GUILD = 0x20n;

const NETWORKS = ['Solana', 'Base', 'Ethereum', 'BNB Chain', 'Multichain'];
const TYPES = [
  'Alpha calls', 'New launches', 'Chart analysis', 'Wallet tracking', 'Research and DD',
  'Airdrops and farming', 'Bots and tools', 'Beginners and learning', 'Meme culture',
  'Project community', 'Raids and shilling', 'Dev and builders', 'News and updates', 'NFT'
];
const REQUESTS = { list: 'Free listing', 'boost-24h': 'Free listing + 24 hour boost (0.15 SOL)', 'boost-3d': 'Free listing + 3 day boost (0.35 SOL)', 'boost-7d': 'Free listing + 7 day boost (0.75 SOL)' };
const HOSTS = { 'discord.gg': 'Discord', 'discord.com': 'Discord', 'discordapp.com': 'Discord', 't.me': 'Telegram', 'telegram.me': 'Telegram' };

const COMMANDS = [
  { name: 'groups', description: 'List every group on the site', default_member_permissions: '32', dm_permission: false },
  {
    name: 'remove', description: 'Take a group off the site', default_member_permissions: '32', dm_permission: false,
    options: [{ type: 3, name: 'group', description: 'Group to remove', required: true, autocomplete: true }]
  },
  {
    name: 'boost', description: 'Pin a group at the top of the site', default_member_permissions: '32', dm_permission: false,
    options: [
      { type: 3, name: 'group', description: 'Group to boost', required: true, autocomplete: true },
      { type: 4, name: 'days', description: 'How many days to add', required: true, min_value: 1, max_value: 30 }
    ]
  },
  {
    name: 'unboost', description: 'Stop a boost early', default_member_permissions: '32', dm_permission: false,
    options: [{ type: 3, name: 'group', description: 'Group to unboost', required: true, autocomplete: true }]
  }
];

/* ---------- small helpers ---------- */

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function hexToBytes(hex) {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16);
  return u;
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
}
function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}
function slug(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  const r = Array.from(crypto.getRandomValues(new Uint8Array(2))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return (s || 'group') + '-' + r;
}
function parseLink(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const platform = HOSTS[host];
  if (!platform) return null;
  if (host === 'discord.com' || host === 'discordapp.com') { if (!/^\/invite\/[\w-]+/.test(u.pathname)) return null; }
  else if (u.pathname.length < 2) return null;
  u.protocol = 'https:';
  u.hash = '';
  return { url: u.href, platform: platform };
}

/* ---------- CORS and rate limit for the website form ---------- */

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map(function (s) { return s.trim().replace(/\/$/, ''); }).filter(Boolean);
}
function corsFor(req, env) {
  const list = allowedOrigins(env);
  const origin = req.headers.get('Origin') || '';
  const ok = !list.length || list.indexOf(origin) > -1;
  return {
    ok: ok,
    headers: {
      'Access-Control-Allow-Origin': list.length ? origin : '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Vary': 'Origin'
    }
  };
}
const hits = new Map(); // best effort, per Worker instance
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(function (t) { return now - t < win; });
  if (arr.length >= 4) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  return false;
}

/* ---------- website form: /submit ---------- */

async function handleSubmit(req, env) {
  const cors = corsFor(req, env);
  if (!cors.ok) return json({ error: 'This site is not allowed to send requests.' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors.headers);
  if (limited(req.headers.get('CF-Connecting-IP') || 'unknown')) return json({ error: 'Too many requests. Try again in a few minutes.' }, 429, cors.headers);

  let b;
  try { b = await req.json(); } catch (e) { return json({ error: 'That request could not be read.' }, 400, cors.headers); }
  if (b.website) return json({ ok: true }, 200, cors.headers); // honeypot

  const name = clean(b.name, 60);
  const contact = clean(b.contact, 60);
  const about = clean(b.about, 200);
  const network = clean(b.network, 30);
  const type = clean(b.type, 40);
  const request = clean(b.request, 20);
  const link = parseLink(clean(b.link, 200));

  if (!name) return json({ error: 'Add the group name.' }, 400, cors.headers);
  if (!link) return json({ error: 'Use a Discord or Telegram invite link, like https://discord.gg/yourcode.' }, 400, cors.headers);
  if (!contact) return json({ error: 'Add a contact handle so we can reach you.' }, 400, cors.headers);
  if (NETWORKS.indexOf(network) < 0 || TYPES.indexOf(type) < 0 || !REQUESTS[request]) return json({ error: 'Pick a network, a type and a request.' }, 400, cors.headers);

  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.pfp || ''));
  if (!m) return json({ error: 'Add your server picture (PNG or JPG).' }, 400, cors.headers);
  const bytes = b64ToBytes(m[2]);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (bytes.length > 450000 || (!isPng && !isJpg)) return json({ error: 'That picture is too large or not a PNG or JPG.' }, 400, cors.headers);
  const ext = isPng ? 'png' : 'jpg';

  const fields = [
    { name: 'Name', value: name, inline: true },
    { name: 'Platform', value: link.platform, inline: true },
    { name: 'Network', value: network, inline: true },
    { name: 'Type', value: type, inline: true },
    { name: 'Request', value: REQUESTS[request], inline: false },
    { name: 'Link', value: link.url, inline: false },
    { name: 'Contact', value: contact, inline: true }
  ];
  if (about) fields.push({ name: 'About', value: about, inline: false });

  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({
    embeds: [{ title: 'New listing request', color: 0x4b7f43, thumbnail: { url: 'attachment://pfp.' + ext }, fields: fields }],
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: 'Approve', custom_id: 'approve' },
      { type: 2, style: 4, label: 'Reject', custom_id: 'reject' }
    ] }],
    attachments: [{ id: 0, filename: 'pfp.' + ext }]
  }));
  fd.append('files[0]', new Blob([bytes], { type: isPng ? 'image/png' : 'image/jpeg' }), 'pfp.' + ext);

  const r = await fetch(API + '/channels/' + env.DISCORD_CHANNEL_ID + '/messages', {
    method: 'POST', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }, body: fd
  });
  if (!r.ok) return json({ error: 'The request could not be delivered. Try again soon.' }, 502, cors.headers);
  return json({ ok: true }, 200, cors.headers);
}

/* ---------- Discord signature check ---------- */

async function verifySignature(publicKeyHex, sigHex, message) {
  const data = new TextEncoder().encode(message);
  const sig = hexToBytes(sigHex);
  const pub = hexToBytes(publicKeyHex);
  try {
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, data);
  } catch (e) {
    const key = await crypto.subtle.importKey('raw', pub, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
    return await crypto.subtle.verify('NODE-ED25519', key, sig, data);
  }
}

function isAdmin(i, env) {
  const user = (i.member && i.member.user) || i.user || {};
  const ids = String(env.ADMIN_USER_IDS || '').split(',').map(function (s) { return s.trim(); });
  if (user.id && ids.indexOf(user.id) > -1) return true;
  try { return (BigInt((i.member && i.member.permissions) || '0') & MANAGE_GUILD) !== 0n; } catch (e) { return false; }
}

/* ---------- GitHub: groups.json and pictures ---------- */

function ghHeaders(env) {
  return { Authorization: 'Bearer ' + env.GITHUB_TOKEN, 'User-Agent': 'groupsimple-worker', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function ghUrl(env, path) {
  return GH + '/repos/' + env.GITHUB_REPO + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
}
function branch(env) { return env.GITHUB_BRANCH || 'main'; }

async function ghGetFile(env, path) {
  const r = await fetch(ghUrl(env, path) + '?ref=' + encodeURIComponent(branch(env)), { headers: ghHeaders(env) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub read failed (' + r.status + ')');
  return r.json();
}
async function ghPutFile(env, path, bytes, message, sha) {
  const body = { message: message, content: bytesToB64(bytes), branch: branch(env) };
  if (sha) body.sha = sha;
  return fetch(ghUrl(env, path), { method: 'PUT', headers: Object.assign({ 'content-type': 'application/json' }, ghHeaders(env)), body: JSON.stringify(body) });
}
async function ghDeleteFile(env, path, message) {
  const f = await ghGetFile(env, path);
  if (!f) return;
  await fetch(ghUrl(env, path), { method: 'DELETE', headers: Object.assign({ 'content-type': 'application/json' }, ghHeaders(env)), body: JSON.stringify({ message: message, sha: f.sha, branch: branch(env) }) });
}
async function readGroups(env) {
  const f = await ghGetFile(env, 'groups.json');
  if (!f) return { groups: [], sha: null };
  const text = new TextDecoder().decode(b64ToBytes(f.content));
  let parsed = {};
  try { parsed = JSON.parse(text); } catch (e) { parsed = {}; }
  return { groups: Array.isArray(parsed.groups) ? parsed.groups : [], sha: f.sha };
}
// mutate(groups) returns the new array, or throws to cancel.
async function updateGroups(env, mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await readGroups(env);
    const next = mutate(JSON.parse(JSON.stringify(cur.groups)));
    const text = JSON.stringify({ groups: next }, null, 2) + '\n';
    const r = await ghPutFile(env, 'groups.json', new TextEncoder().encode(text), message, cur.sha);
    if (r.ok) return next;
    if (r.status !== 409 && r.status !== 422) throw new Error('GitHub write failed (' + r.status + ')');
  }
  throw new Error('GitHub was busy. Try again.');
}

/* ---------- Discord: replies ---------- */

async function editOriginal(env, i, body) {
  await fetch(API + '/webhooks/' + env.DISCORD_APP_ID + '/' + i.token + '/messages/@original', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}
function who(i) {
  const u = (i.member && i.member.user) || i.user || {};
  return u.global_name || u.username || 'a moderator';
}

/* ---------- Approve and reject buttons ---------- */

async function approve(env, i) {
  const msg = i.message;
  const e = msg.embeds && msg.embeds[0];
  const att = msg.attachments && msg.attachments[0];
  if (!e || !att) throw new Error('This request is missing its picture.');
  const f = {};
  e.fields.forEach(function (x) { f[x.name] = x.value; });

  const existing = await readGroups(env);
  if (existing.groups.some(function (g) { return g.link === f.Link; })) throw new Error('That invite link is already listed.');

  const img = await fetch(att.url);
  if (!img.ok) throw new Error('The picture could not be loaded from Discord.');
  const bytes = new Uint8Array(await img.arrayBuffer());
  const ext = /\.png$/i.test(att.filename) ? 'png' : 'jpg';
  const id = slug(f.Name);
  const pfp = 'pfp/' + id + '.' + ext;

  const up = await ghPutFile(env, pfp, bytes, 'Add picture for ' + f.Name);
  if (!up.ok) throw new Error('The picture could not be saved (' + up.status + ').');

  await updateGroups(env, function (groups) {
    if (groups.some(function (g) { return g.link === f.Link; })) throw new Error('That invite link is already listed.');
    groups.push({
      id: id, name: f.Name, link: f.Link, platform: f.Platform, network: f.Network, type: f.Type,
      desc: f.About || '', pfp: pfp, added: new Date().toISOString(), boostedUntil: null
    });
    return groups;
  }, 'Add ' + f.Name);

  const boost = /boost/i.test(f.Request || '');
  const color = 0x2e7d32;
  await editOriginal(env, i, {
    content: boost ? 'Boost requested: **' + f.Request + '**. After you get paid, run `/boost` on this group.' : '',
    embeds: [{ title: 'Approved: ' + f.Name, color: color, thumbnail: { url: att.url }, fields: e.fields, footer: { text: 'Approved by ' + who(i) + '. Live on the site in about a minute.' } }],
    components: []
  });
}
async function reject(env, i) {
  const e = i.message.embeds[0];
  const att = i.message.attachments && i.message.attachments[0];
  await editOriginal(env, i, {
    embeds: [{ title: 'Rejected', color: 0xb3261e, thumbnail: att ? { url: att.url } : undefined, fields: e.fields, footer: { text: 'Rejected by ' + who(i) } }],
    components: []
  });
}

/* ---------- Slash commands ---------- */

function opt(i, name) {
  const o = (i.data.options || []).filter(function (x) { return x.name === name; })[0];
  return o ? o.value : undefined;
}
function findGroup(groups, key) {
  return groups.filter(function (g) { return g.id === key; })[0];
}

async function runCommand(env, i) {
  const name = i.data.name;
  if (name === 'groups') {
    const { groups } = await readGroups(env);
    if (!groups.length) return { content: 'No groups yet.' };
    const now = Date.now();
    const lines = groups.map(function (g) {
      const b = g.boostedUntil && Date.parse(g.boostedUntil) > now ? ' (boosted until <t:' + Math.floor(Date.parse(g.boostedUntil) / 1000) + ':R>)' : '';
      return '- **' + g.name + '** `' + g.id + '`' + b;
    });
    return { embeds: [{ title: groups.length + ' groups', description: lines.join('\n').slice(0, 3900), color: 0x4b7f43 }] };
  }
  const key = opt(i, 'group');
  if (name === 'remove') {
    let removed;
    await updateGroups(env, function (groups) {
      removed = findGroup(groups, key);
      if (!removed) throw new Error('No group with that id.');
      return groups.filter(function (g) { return g.id !== key; });
    }, 'Remove ' + key);
    if (removed.pfp) await ghDeleteFile(env, removed.pfp, 'Remove picture for ' + removed.name);
    return { content: 'Removed **' + removed.name + '**. It disappears from the site in about a minute.' };
  }
  if (name === 'boost') {
    const days = Number(opt(i, 'days'));
    let until, label;
    await updateGroups(env, function (groups) {
      const g = findGroup(groups, key);
      if (!g) throw new Error('No group with that id.');
      const start = g.boostedUntil && Date.parse(g.boostedUntil) > Date.now() ? Date.parse(g.boostedUntil) : Date.now();
      until = Math.floor((start + days * 86400000) / 1000);
      g.boostedUntil = new Date(until * 1000).toISOString();
      label = g.name;
      return groups;
    }, 'Boost ' + key);
    return { content: '**' + label + '** is boosted until <t:' + until + ':f>.' };
  }
  if (name === 'unboost') {
    let label;
    await updateGroups(env, function (groups) {
      const g = findGroup(groups, key);
      if (!g) throw new Error('No group with that id.');
      g.boostedUntil = null; label = g.name;
      return groups;
    }, 'Unboost ' + key);
    return { content: 'Boost ended for **' + label + '**.' };
  }
  return { content: 'Unknown command.' };
}

async function autocomplete(env, i) {
  const o = (i.data.options || []).filter(function (x) { return x.focused; })[0];
  const q = String((o && o.value) || '').toLowerCase();
  try {
    const { groups } = await readGroups(env);
    const choices = groups.filter(function (g) { return !q || g.name.toLowerCase().indexOf(q) > -1; })
      .slice(0, 25).map(function (g) { return { name: g.name.slice(0, 100), value: g.id }; });
    return { type: 8, data: { choices: choices } };
  } catch (e) {
    return { type: 8, data: { choices: [] } };
  }
}

/* ---------- /interactions ---------- */

async function handleInteraction(req, env, ctx) {
  const raw = await req.text();
  const sig = req.headers.get('x-signature-ed25519');
  const ts = req.headers.get('x-signature-timestamp');
  let valid = false;
  try { valid = !!(sig && ts && await verifySignature(env.DISCORD_PUBLIC_KEY, sig, ts + raw)); } catch (e) { valid = false; }
  if (!valid) return new Response('Bad signature', { status: 401 });

  const i = JSON.parse(raw);
  if (i.type === 1) return json({ type: 1 });

  const admin = isAdmin(i, env);
  if (i.type === 4) return admin ? json(await autocomplete(env, i)) : json({ type: 8, data: { choices: [] } });
  if (!admin) return json({ type: 4, data: { content: 'You need the Manage Server permission to do that.', flags: 64 } });

  if (i.type === 3) {
    const action = i.data.custom_id;
    ctx.waitUntil((async function () {
      try {
        if (action === 'approve') await approve(env, i);
        else if (action === 'reject') await reject(env, i);
      } catch (err) {
        await fetch(API + '/webhooks/' + env.DISCORD_APP_ID + '/' + i.token, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'Could not finish: ' + err.message, flags: 64 })
        });
      }
    })());
    return json({ type: 6 });
  }

  if (i.type === 2) {
    ctx.waitUntil((async function () {
      let body;
      try { body = await runCommand(env, i); } catch (err) { body = { content: 'Could not finish: ' + err.message }; }
      await editOriginal(env, i, body);
    })());
    return json({ type: 5, data: { flags: 64 } });
  }
  return json({ type: 4, data: { content: 'Not supported.', flags: 64 } });
}

/* ---------- /register-commands (run once) ---------- */

async function handleRegister(req, env) {
  const key = new URL(req.url).searchParams.get('key');
  if (!env.SETUP_KEY || key !== env.SETUP_KEY) return new Response('Wrong key.', { status: 403 });
  const r = await fetch(API + '/applications/' + env.DISCORD_APP_ID + '/guilds/' + env.DISCORD_GUILD_ID + '/commands', {
    method: 'PUT', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(COMMANDS)
  });
  const text = await r.text();
  return new Response(r.ok ? 'Commands registered. Try /groups in your server.' : 'Discord said no (' + r.status + '): ' + text, { status: r.ok ? 200 : 502 });
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/submit') return handleSubmit(req, env);
    if (path === '/interactions' && req.method === 'POST') return handleInteraction(req, env, ctx);
    if (path === '/register-commands') return handleRegister(req, env);
    return new Response('groupsimple worker is running.', { status: 200 });
  }
};
