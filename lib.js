// Crypto, draw and API. No DOM here so it can be exercised from Node.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'
import { timelockEncrypt, timelockDecrypt, mainnetClient, roundAt, Buffer } from './vendor/tlock.js'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64 = (buf) => {
  const bytes = new Uint8Array(buf); let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// ---------- API ----------
async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await r.text()
  if (!r.ok) {
    let msg = text
    try { msg = JSON.parse(text).message || text } catch {}
    throw new Error(msg)
  }
  return text ? JSON.parse(text) : null
}
export const api = {
  group: (code) => rpc('santa_group', { p_code: code }),
  claim: (code, member, pubkey, backup, token) =>
    rpc('santa_claim', { p_code: code, p_member: member, p_pubkey: pubkey, p_backup: backup, p_token: token }),
  backup: (code, member) => rpc('santa_backup', { p_code: code, p_member: member }),
  wishlist: (code, member, token, wishlist) =>
    rpc('santa_wishlist', { p_code: code, p_member: member, p_token: token, p_wishlist: wishlist }),
  photo: (code) => rpc('santa_photo', { p_code: code }),
  ideas: (code, member, token) => rpc('santa_ideas_for', { p_code: code, p_member: member, p_token: token }),
  addIdea: (code, member, token, about, body) =>
    rpc('santa_add_idea', { p_code: code, p_member: member, p_token: token, p_about: about, p_body: body }),
  deleteIdea: (code, member, token, id) =>
    rpc('santa_delete_idea', { p_code: code, p_member: member, p_token: token, p_id: id }),
  draw: (code, assignments, revealCt, revealRound) =>
    rpc('santa_draw', { p_code: code, p_assignments: assignments, p_reveal_ct: revealCt, p_reveal_round: revealRound }),
}

// ---------- randomness ----------
export function randInt(n) {
  // unbiased integer in [0, n)
  const lim = Math.floor(0x100000000 / n) * n
  const a = new Uint32Array(1)
  do globalThis.crypto.getRandomValues(a); while (a[0] >= lim)
  return a[0] % n
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789' // no 0/O, 1/I/L, U
export function newRecoveryCode() {
  let s = ''
  for (let i = 0; i < 16; i++) s += CODE_ALPHABET[randInt(CODE_ALPHABET.length)]
  return s.match(/.{4}/g).join('-') // ~78 bits
}
export const normalizeCode = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
export function newToken() {
  const a = new Uint8Array(32); globalThis.crypto.getRandomValues(a)
  return b64(a).replace(/[^A-Za-z0-9]/g, '').padEnd(40, 'x')
}

// ---------- member keys ----------
export async function newKeyPair() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const pub = await subtle.exportKey('jwk', kp.publicKey)
  return { pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, priv: await subtle.exportKey('jwk', kp.privateKey) }
}
const importPub = (jwk) => subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
const importPriv = (jwk) => subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])

async function aesFromShared(bits, salt) {
  const ikm = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('secret-santa/v1') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// Seal a JSON value so only the holder of pubJwk's private key can open it (ECIES-style).
export async function seal(pubJwk, value) {
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'ECDH', public: await importPub(pubJwk) }, eph.privateKey, 256)
  const epk = await subtle.exportKey('jwk', eph.publicKey)
  const key = await aesFromShared(bits, enc.encode(epk.x + epk.y))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)))
  return { epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y }, iv: b64(iv), ct: b64(ct) }
}
export async function openBox(privJwk, box) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: await importPub(box.epk) }, await importPriv(privJwk), 256)
  const key = await aesFromShared(bits, enc.encode(box.epk.x + box.epk.y))
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct))
  return JSON.parse(dec.decode(pt))
}

// ---------- recovery-code backup ----------
async function codeKey(code, salt) {
  const base = await subtle.importKey('raw', enc.encode(normalizeCode(code)), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 200000 },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export async function lockBackup(code, secrets) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await codeKey(code, salt), enc.encode(JSON.stringify(secrets)))
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }
}
export async function unlockBackup(code, backup) {
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(backup.iv) },
      await codeKey(code, unb64(backup.salt)), unb64(backup.ct))
    return JSON.parse(dec.decode(pt))
  } catch { throw new Error("That recovery code doesn't match.") }
}

// ---------- the draw ----------
function blockedSet(members, exclusions) {
  const byName = new Map(members.map((m) => [m.name.toLowerCase(), m.id]))
  const bad = new Set()
  for (const [a, b] of exclusions) {
    const x = byName.get(String(a).toLowerCase()), y = byName.get(String(b).toLowerCase())
    if (x && y) { bad.add(`${x}>${y}`); bad.add(`${y}>${x}`) }
  }
  return bad
}
const allowed = (bad, g, r) => g !== r && !bad.has(`${g}>${r}`)

export function countDraws(members, exclusions) {
  const bad = blockedSet(members, exclusions), ids = members.map((m) => m.id), used = new Set()
  let n = 0
  const go = (i) => {
    if (i === ids.length) { n++; return }
    for (const r of ids) if (!used.has(r) && allowed(bad, ids[i], r)) { used.add(r); go(i + 1); used.delete(r) }
  }
  go(0)
  return n
}

// Uniform over valid draws: shuffle until one fits.
export function makeDraw(members, exclusions) {
  const bad = blockedSet(members, exclusions), ids = members.map((m) => m.id)
  for (let tries = 0; tries < 200000; tries++) {
    const p = ids.slice()
    for (let i = p.length - 1; i > 0; i--) { const j = randInt(i + 1); [p[i], p[j]] = [p[j], p[i]] }
    if (ids.every((g, i) => allowed(bad, g, p[i]))) return Object.fromEntries(ids.map((g, i) => [g, p[i]]))
  }
  throw new Error('No valid draw fits these rules.')
}

// ---------- timelock ----------
let _client
const client = () => (_client ||= mainnetClient())
export async function revealRoundFor(isoTime) {
  return roundAt(Date.parse(isoTime), await client().chain().info())
}
export const timelock = async (round, value) => timelockEncrypt(round, Buffer.from(JSON.stringify(value)), client())
export const unTimelock = async (ct) => JSON.parse((await timelockDecrypt(ct, client())).toString())

// Full draw: pair, seal each giver's match to their key, timelock the whole list, upload.
export async function runDraw(code, group) {
  const members = group.members
  if (members.some((m) => !m.pubkey)) throw new Error('Not everyone has joined yet.')
  const pairs = makeDraw(members, group.exclusions)
  const name = Object.fromEntries(members.map((m) => [m.id, m.name]))
  const assignments = {}
  for (const m of members) assignments[m.id] = await seal(m.pubkey, { to: pairs[m.id], name: name[pairs[m.id]] })
  const round = await revealRoundFor(group.reveal_at)
  const list = members.map((m) => ({ from: m.name, to: name[pairs[m.id]] })).sort((a, b) => a.from.localeCompare(b.from))
  const revealCt = await timelock(round, list)
  await api.draw(code, assignments, revealCt, round)
}
