import * as L from './lib.js?v=4'

const $app = document.getElementById('app')
const LAST = 'santa:last'
const normPw = (s) => String(s || '').trim().toLowerCase()
const HASH = new URLSearchParams(location.hash.slice(1))
const hostCode = (HASH.get('host') || '').trim()
let code = normPw(HASH.get('g')) || (() => { try { return localStorage.getItem(LAST) } catch { return null } })()
let KEY = `santa:${code}`

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
// Lists and links in free text: each line (or inline "- [ ]" item) becomes a bullet, URLs become short tappable links.
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g
const linkify = (s) => {
  let out = '', last = 0
  for (const m of s.matchAll(URL_RE)) {
    let label = m[0]
    try { const u = new URL(m[0]); label = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 || u.search ? '/…' : '') } catch {}
    out += esc(s.slice(last, m.index)) + `<a href="${esc(m[0])}" target="_blank" rel="noopener">${esc(label)}</a>`
    last = m.index + m[0].length
  }
  return out + esc(s.slice(last))
}
const splitItems = (s) => String(s ?? '').split(/\n|\s(?=-\s*\[[ xX]?\])|\s(?=•)/)
  .map((t) => t.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[[ xX]?\]\s*)?/, '').trim()).filter(Boolean)
const rich = (s) => {
  const items = splitItems(s)
  return items.length > 1 ? `<ul class="items">${items.map((t) => `<li>${linkify(t)}</li>`).join('')}</ul>` : `<span>${linkify(items[0] || '')}</span>`
}
const fmtReveal = (iso) => new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) + ' ET'

// The match key is kept per member on this phone, apart from the session, so signing out and
// back in on the same phone still opens the match. A new phone gets ideas + wishlist, not the match.
const keyStore = (id) => `${KEY}:key:${id}`
function loadKey(id) { try { return JSON.parse(localStorage.getItem(keyStore(id))) } catch { return null } }
function saveKey(id, priv) { try { if (priv) localStorage.setItem(keyStore(id), JSON.stringify(priv)) } catch {} }
function loadMe() {
  let v = null
  try { v = JSON.parse(localStorage.getItem(KEY)) } catch {}
  if (v?.priv) saveKey(v.memberId, v.priv)
  else if (v) v.priv = loadKey(v.memberId)
  return v
}
function saveMe(v) { saveKey(v.memberId, v.priv); try { localStorage.setItem(KEY, JSON.stringify(v)) } catch {} }
function forgetMe() { try { localStorage.removeItem(KEY) } catch {} }
const normEmail = (s) => String(s || '').trim().toLowerCase()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const friendly = (msg) => ({
  'wrong email': "That isn't the email on this name.",
  'verify your email first': 'Please confirm your email again.',
  'already drawn': "The draw already happened, so new people can't join.",
  'name already claimed': 'Someone already joined as this name. Go back and tap it again to log in.',
}[msg] || (/expired|invalid/i.test(msg) ? "That code didn't work. Check it, or send a new one." : msg))

let group = null
let me = loadMe()
let photo = null
let ideas = []
let revealTimer = null
// Open groups have a host who isn't playing and can see every match; nothing is sealed to a phone.
const isOpen = () => group?.mode === 'open'

const render = (html) => { $app.innerHTML = html }
const header = () => `
  ${photo ? `<figure class="feature-photo"><img src="${photo}" alt="Leo the elf in a Santa hat"><figcaption>Leo the Elf is watching</figcaption></figure>` : ''}
  <h1>${esc(group.name)}</h1>
  <p class="sub">${group.budget ? `Budget: ${esc(group.budget)} &middot; ` : ''}Full list opens ${esc(fmtReveal(group.reveal_at))}</p>`

async function loadPhoto() {
  const k = `santa:photo:${code}`
  try { photo = localStorage.getItem(k) } catch {}
  if (!photo) {
    try {
      const p = await L.api.photo(code)
      photo = p?.photo || null
      if (photo) { try { localStorage.setItem(k, photo) } catch {} }
      if (p?.icon) { try { localStorage.setItem(`${k}:icon`, p.icon) } catch {} }
    } catch {}
  }
  if (!photo) photo = ''
  let icon = null
  try { icon = localStorage.getItem(`${k}:icon`) } catch {}
  if (icon) for (const rel of ['icon', 'apple-touch-icon']) {
    const l = document.createElement('link'); l.rel = rel; l.href = icon; document.head.appendChild(l)
  }
}

async function refresh() {
  group = await L.api.group(code)
  if (photo === null) await loadPhoto()
  const mine = me && group.members.find((m) => m.id === me.memberId)
  // gone from the group, or (open groups) the host cleared this name's login
  if (me && (!mine || (isOpen() && !mine.claimed))) { forgetMe(); me = null }
  me ? home() : pickName()
}

// ---------- who are you ----------
function pickName() {
  render(`${header()}
    <section class="card">
      <h2>Who are you?</h2>
      <p class="muted small">Tap your name, then confirm with your email.</p>
      <div class="names">${group.members.map((m) => `
        <button class="name-btn" data-id="${m.id}" ${!m.claimed && group.draw && !isOpen() ? 'disabled' : ''}>${esc(m.name)}<span class="tag">${m.claimed ? 'log in' : ''}</span></button>`).join('')}
      </div>
    </section>
    ${privacyNote()}`)
  $app.querySelectorAll('.name-btn').forEach((b) => b.onclick = () => {
    const m = group.members.find((x) => x.id === b.dataset.id)
    emailStep(m)
  })
}

// Email + code, shared by joining, logging back in, and adding an email while signed in.
// Renders into `box`; calls onJwt(jwt) once the code checks out.
function otpFlow(box, { intro, email = '', onJwt, onBack }) {
  box.innerHTML = `
    <p class="muted">${intro}</p>
    <input id="em" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="you@example.com" value="${esc(email)}">
    <button id="send">Email me a code</button>
    ${onBack ? '<button class="link" id="back">Back</button>' : ''}
    <p class="error" id="oerr"></p>`
  box.classList.add('stack')
  if (onBack) box.querySelector('#back').onclick = onBack
  const em = box.querySelector('#em'), send = box.querySelector('#send'), err = box.querySelector('#oerr')
  em.onkeydown = (e) => { if (e.key === 'Enter') send.click() }
  send.onclick = async () => {
    const address = normEmail(em.value)
    if (!EMAIL_RE.test(address)) { err.textContent = 'Enter your email address.'; return }
    send.disabled = true; send.textContent = 'Sending...'; err.textContent = ''
    try { await L.auth.sendCode(address) } catch (e) {
      err.textContent = /rate|seconds/i.test(e.message) ? 'Too many codes just now. Wait a minute and try again.' : e.message
      send.disabled = false; send.textContent = 'Email me a code'; return
    }
    box.innerHTML = `
      <p class="muted">We sent a code to <strong>${esc(address)}</strong>. It can take a minute; check spam too.</p>
      <input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code">
      <button id="verify">Continue</button>
      <button class="link" id="again">Use a different email</button>
      <p class="error" id="oerr"></p>`
    const otp = box.querySelector('#otp'), verify = box.querySelector('#verify'), err2 = box.querySelector('#oerr')
    otp.focus()
    box.querySelector('#again').onclick = () => otpFlow(box, { intro, email: address, onJwt, onBack })
    otp.onkeydown = (e) => { if (e.key === 'Enter') verify.click() }
    verify.onclick = async () => {
      const t = otp.value.replace(/\D/g, '')
      if (t.length < 6) { err2.textContent = 'Enter the code from the email.'; return }
      verify.disabled = true; verify.textContent = 'Checking...'; err2.textContent = ''
      try { await onJwt(await L.auth.verify(address, t)) } catch (e) {
        err2.textContent = friendly(e.message)
        verify.disabled = false; verify.textContent = 'Continue'
      }
    }
  }
  em.focus()
}

function emailStep(m) {
  if (!m.claimed && group.draw && !isOpen()) { render(`${header()}<section class="card"><p>The draw already happened, so new people can't join.</p></section>`); return }
  render(`${header()}
    <section class="card">
      <h2>${m.claimed ? `Welcome back, ${esc(m.name)}` : `You're ${esc(m.name)}?`}</h2>
      <div id="otpbox"></div>
    </section>`)
  const intro = m.claimed
    ? (m.email_hint ? `Enter your email (${esc(m.email_hint)}) and we'll send you a code.` : "Enter your email and we'll send you a code. From now on it's how you log in as " + esc(m.name) + '.')
    : isOpen() ? `Enter your email and we'll send you a code. From now on it's how you log in as ${esc(m.name)}, from any phone or computer.`
    : 'Enter your email. This phone will open your match, so use the phone you\'ll have at Christmas. Your email lets you log back in from anywhere.'
  otpFlow($app.querySelector('#otpbox'), {
    intro, onBack: pickName,
    onJwt: async (jwt) => {
      const token = L.newToken()
      if (m.claimed || isOpen()) {
        await L.api.login(code, m.id, token, jwt)
        me = { memberId: m.id, priv: loadKey(m.id), token }
      } else {
        const kp = await L.newKeyPair()
        await L.api.claim(code, m.id, kp.pub, null, token, jwt)
        me = { memberId: m.id, priv: kp.priv, token }
      }
      saveMe(me)
      await refresh()
    },
  })
}

// ---------- home ----------
async function home() {
  const mine = group.members.find((m) => m.id === me.memberId)
  const joined = group.members.filter((m) => m.claimed).length
  let match = null, matchErr = ''
  if (isOpen()) {
    if (group.draw) {
      try { match = await L.api.myMatch(code, me.memberId, me.token) }
      catch (e) {
        if (e.message === 'not allowed') { forgetMe(); me = null; return pickName() }
        matchErr = "Couldn't load your match. Check your connection and reload."
      }
      if (!match && !matchErr) matchErr = "Couldn't load your match. Reload to try again."
    }
  } else if (group.draw) {
    if (!me.priv) matchErr = 'Your match only opens on the phone you first joined on (or your screenshot). You can still see and add gift ideas here.'
    else {
      try { match = await L.openBox(me.priv, group.draw.assignments[me.memberId]) }
      catch { matchErr = "This phone can't open your match. Check the phone you first joined on." }
    }
  }
  const them = match && group.members.find((m) => m.id === match.to)
  try { ideas = await L.api.ideas(code, me.memberId, me.token) } catch { ideas = [] }
  const PICK = `${KEY}:pick:${me.memberId}`
  let pick = null
  try { pick = localStorage.getItem(PICK) } catch {}
  if (!group.members.some((m) => m.id === pick)) pick = match?.to || group.members.find((m) => m.id !== me.memberId)?.id || me.memberId
  const picked = group.members.find((m) => m.id === pick)
  const ideaList = (about) => {
    const list = ideas.filter((i) => i.about === about)
    return list.length ? `<ul class="ideas">${list.map((i) => `<li><div class="idea-body">${rich(i.body)}</div>${i.mine ? `<button class="link del-idea" data-id="${i.id}">Remove</button>` : ''}</li>`).join('')}</ul>` : ''
  }

  render(`${header()}
    ${mine.email_hint ? '' : `
      <section class="card" id="addemail">
        <h2>Add your email</h2>
        <div id="emailbox"><p class="muted small">So you can log back in from any phone or computer to see and add gift ideas.</p>
          <button id="addemailbtn" class="secondary">Add email</button></div>
      </section>`}
    ${group.draw ? `
      <section class="card feature">
        <p class="eyebrow">You're buying for</p>
        ${match ? `
          <div class="big-name">${esc(match.name)}</div>
          <p class="eyebrow">Their wishlist</p>
          ${them?.wishlist ? `<div class="wish">${rich(them.wishlist)}</div>` : `<p class="muted">${esc(match.name)} hasn't added a wishlist yet.</p>`}
          <p class="eyebrow" style="margin-top:14px">Ideas from the group</p>
          ${ideaList(match.to) || `<p class="muted small">No ideas yet. The group can add them below.</p>`}
          ${isOpen() ? '' : '<p class="note">Take a screenshot of this. Your match only opens on this phone.</p>'}
        ` : `<p class="muted">${esc(matchErr)}</p>`}
      </section>` : isOpen() ? `
      <section class="card">
        <h2>The draw</h2>
        <p>Names haven't been drawn yet.</p>
        <p class="muted small">Check back soon. Once the host draws names, your match shows up right here. Add your wishlist below in the meantime.</p>
      </section>` : `
      <section class="card">
        <h2>The draw</h2>
        <p>${joined} of ${group.members.length} have joined.</p>
        ${joined < group.members.length
          ? `<p class="muted small">Once everyone has joined, anyone can run the draw.</p>`
          : `<div class="stack" id="drawbox"><p class="muted small">Everyone's in. The draw runs on this phone, seals each match so only that person can open it, and locks the full list until Christmas. Nobody sees it, including whoever presses the button.</p><button id="draw">Run the draw</button></div>`}
      </section>`}

    <section class="card stack" id="ideas">
      <h2>Gift ideas</h2>
      <p class="muted small">Pick someone to see their wishlist and the group's ideas, or add your own. Ideas are anonymous. You can suggest gifts for yourself too; ideas others add for you stay a surprise.</p>
      <select id="ideafor">${group.members.map((m) => {
        const n = ideas.filter((i) => i.about === m.id).length
        return `<option value="${m.id}" ${m.id === pick ? 'selected' : ''}>${m.id === me.memberId ? 'Me' : esc(m.name)}${n ? ` (${n})` : ''}</option>`
      }).join('')}</select>
      ${pick !== me.memberId ? `
        <p class="eyebrow">${esc(picked.name)}'s wishlist</p>
        ${picked.wishlist ? `<div class="wish">${rich(picked.wishlist)}</div>` : `<p class="muted small">${esc(picked.name)} hasn't added a wishlist yet.</p>`}` : ''}
      <p class="eyebrow">${pick === me.memberId ? 'Ideas you suggested for yourself' : `Ideas for ${esc(picked.name)}`}</p>
      ${ideaList(pick) || `<p class="muted small">No ideas yet.</p>`}
      <textarea id="ideatext" class="short" placeholder="${pick === me.memberId ? 'e.g. I could use new running gloves' : 'e.g. Has been eyeing a cast iron pan'}"></textarea>
      <p class="muted small">One idea per line. Each line becomes its own item.</p>
      <button id="addidea" class="secondary">Add idea${pick === me.memberId ? ' for me' : ` for ${esc(picked.name)}`}</button>
      <p class="error" id="ideaerr"></p>
    </section>

    <section class="card stack">
      <h2>Your wishlist</h2>
      <textarea id="wl" placeholder="Ideas, sizes, links, things to avoid...">${esc(mine.wishlist)}</textarea>
      <div class="row"><button id="savewl" class="secondary">Save wishlist</button></div>
      <p class="small muted" id="wlmsg"></p>
    </section>

    <section class="card" id="reveal">
      <h2>Christmas reveal</h2>
      <div id="revealbody"></div>
    </section>

    <section class="card">
      <h2>Who's in</h2>
      <ul class="roster">${group.members.map((m) => `
        <li><span><span class="dot ${m.claimed ? 'on' : ''}"></span>${esc(m.name)}${m.id === me.memberId ? ' <span class="muted small">(you)</span>' : ''}</span>
        <span class="muted small">${m.claimed ? 'joined' : 'waiting'}</span></li>`).join('')}
      </ul>
      ${isOpen() ? openNote() : ''}
      ${group.exclusions?.length ? `<p class="note">Can't draw each other: ${group.exclusions.map((p) => esc(p.join(' & '))).join(', ')}.</p>` : ''}
    </section>

    <footer class="stack">
      <div>Signed in as ${esc(mine.name)}${mine.email_hint ? ` (${esc(mine.email_hint)})` : ''}.
        <button class="link" id="notme">Sign out</button></div>
      <div id="rcbox"></div>
    </footer>`)

  const wl = $app.querySelector('#wl'), msg = $app.querySelector('#wlmsg')
  $app.querySelector('#savewl').onclick = async () => {
    msg.textContent = 'Saving...'
    try { await L.api.wishlist(code, me.memberId, me.token, wl.value); mine.wishlist = wl.value; msg.textContent = 'Saved.' }
    catch (e) { msg.textContent = e.message }
  }
  $app.querySelector('#notme').onclick = () => {
    const text = mine.email_hint
      ? `Sign out of this phone? Log back in any time with your email (${mine.email_hint}).`
      : "You haven't added an email yet, so you can't log back in as yourself. Add one first."
    confirmInline('#rcbox', text, 'Sign out', () => { forgetMe(); me = null; pickName() })
  }
  const addEmail = $app.querySelector('#addemailbtn')
  if (addEmail) addEmail.onclick = () => otpFlow($app.querySelector('#emailbox'), {
    intro: "Enter your email. We'll send a code to confirm it.",
    onBack: () => home(),
    onJwt: async (jwt) => { await L.api.setEmail(code, me.memberId, me.token, jwt); await refresh() },
  })
  const ideaText = $app.querySelector('#ideatext'), ideaErr = $app.querySelector('#ideaerr')
  $app.querySelector('#ideafor').onchange = (e) => { try { localStorage.setItem(PICK, e.target.value) } catch {}; home() }
  $app.querySelector('#addidea').onclick = async (e) => {
    const items = splitItems(ideaText.value)
    if (!items.length) return
    e.target.disabled = true
    const about = pick
    try { for (const t of items) await L.api.addIdea(code, me.memberId, me.token, about, t); await home() }
    catch (err) { ideaErr.textContent = err.message; e.target.disabled = false }
  }
  $app.querySelectorAll('.del-idea').forEach((b) => b.onclick = async () => {
    try { await L.api.deleteIdea(code, me.memberId, me.token, b.dataset.id); await home() } catch (err) { ideaErr.textContent = err.message }
  })
  const draw = $app.querySelector('#draw')
  if (draw) draw.onclick = () => confirmInline('#drawbox', 'The draw is final and can\'t be redone from the app. Ready?', 'Yes, draw names', doDraw)
  renderReveal()
}

function confirmInline(sel, text, label, fn) {
  const box = $app.querySelector(sel)
  box.innerHTML = `<p>${esc(text)}</p><button id="yes">${esc(label)}</button><button class="secondary" id="no">Cancel</button><p class="error" id="cerr"></p>`
  box.classList.add('stack')
  box.querySelector('#no').onclick = () => home()
  box.querySelector('#yes').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Working...'
    try { await fn() } catch (err) { box.querySelector('#cerr').textContent = err.message; e.target.disabled = false; e.target.textContent = label }
  }
  return true
}

async function doDraw() {
  const fresh = await L.api.group(code)
  await L.runDraw(code, fresh)
  await refresh()
}

// ---------- reveal ----------
function renderReveal() {
  clearTimeout(revealTimer)
  const body = $app.querySelector('#revealbody')
  if (!body) return
  const at = Date.parse(group.reveal_at)
  if (!group.draw) {
    body.innerHTML = `<p class="muted">After the draw, ${isOpen() ? 'you only see your own match. The full list opens for everyone' : 'the full list is locked until'} ${esc(fmtReveal(group.reveal_at))}.</p>`
    return
  }
  const left = at - Date.now()
  if (left > 0) {
    const d = Math.floor(left / 864e5), h = Math.floor(left / 36e5) % 24, m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60
    body.innerHTML = `<div class="countdown">${d ? `${d}d ` : ''}${h}h ${m}m${d ? '' : ` ${s}s`}</div>
      <p class="muted small">${isOpen() ? 'Until everyone can see the full list. Until then you only see your own match.'
        : "Until the full list opens. It's locked with a key that won't exist until then, so nobody can open it early, not even the host."}</p>`
    revealTimer = setTimeout(renderReveal, d ? 60000 : 1000)
    return
  }
  body.innerHTML = `<p class="muted">Opening the list...</p>`
  const full = isOpen()
    ? (group.pairs ? Promise.resolve(group.pairs) : L.api.group(code).then((g) => { if (!g.pairs) throw new Error('not yet'); group.pairs = g.pairs; return g.pairs }))
    : L.unTimelock(group.draw.reveal_ct)
  full.then((list) => {
    body.innerHTML = pairList(list)
  }).catch(() => {
    body.innerHTML = `<p class="muted">Almost there. ${isOpen() ? 'Opening the list...' : 'Waiting for the unlock key...'}</p>`
    revealTimer = setTimeout(renderReveal, 10000)
  })
}

const pairList = (list) => `<ul class="pairs">${list.map((p) => `<li>${esc(p.from)}<span class="arrow">&rarr;</span>${esc(p.to)}</li>`).join('')}</ul>`
const openNote = () => `<p class="note">Only you can see who you have. The host set this group up, isn't playing, and can see the full list in case anyone gets stuck.</p>`

function privacyNote() {
  if (isOpen()) return openNote()
  return `<p class="note">How the secret stays secret: your match is sealed on the phones themselves, and the server only stores scrambled data. The full list stays locked until Christmas morning.</p>`
}

// ---------- boot ----------
function passwordScreen(err = '') {
  render(`<h1>Secret Santa</h1>
    <p class="sub">Enter the group password to join.</p>
    <section class="card stack">
      <input id="pw" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Group password">
      <button id="go">Continue</button>
      <p class="error" id="err">${esc(err)}</p>
    </section>`)
  const pw = $app.querySelector('#pw'), go = $app.querySelector('#go')
  pw.onkeydown = (e) => { if (e.key === 'Enter') go.click() }
  go.onclick = () => { open(normPw(pw.value)) }
}

async function open(pw) {
  if (!pw) return passwordScreen()
  code = pw; KEY = `santa:${code}`; me = loadMe()
  try {
    await refresh()
    try { localStorage.setItem(LAST, code) } catch {}
  } catch (e) {
    try { localStorage.removeItem(LAST) } catch {}
    passwordScreen(e.message === 'unknown group' ? "That password doesn't match a group." : e.message)
  }
}

// ---------- host (open groups) ----------
// Opened from the host link (#g=<password>&host=<host code>). The host isn't playing: this page shows
// who has logged in and every match, and is where names get drawn.
async function hostPage(note = '') {
  let h
  try { h = await L.api.host(code, hostCode) } catch (e) {
    render(`<h1>Secret Santa</h1><section class="card"><p>${e.message === 'not allowed' ? "This host link doesn't match a group." : esc(e.message)}</p></section>`)
    return
  }
  const invite = `${location.origin}${location.pathname}#g=${encodeURIComponent(code)}`
  const joined = h.members.filter((m) => m.email).length
  render(`<h1>${esc(h.name)}</h1>
    <p class="sub">Host view &middot; ${h.budget ? `Budget: ${esc(h.budget)} &middot; ` : ''}Everyone sees the full list ${esc(fmtReveal(h.reveal_at))}</p>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    <section class="card feature">
      <p class="eyebrow">Who has whom</p>
      ${h.pairs ? `${pairList(h.pairs)}
        <p class="muted small" style="margin-top:10px">Drawn ${esc(fmtReveal(h.drawn_at))}. Each person sees only their own line when they log in.</p>` : `
        <p class="muted">Names haven't been drawn yet. People can log in and add wishlists before or after the draw.</p>`}
      <div class="stack" id="drawbox" style="margin-top:12px">
        <button id="draw" class="${h.pairs ? 'secondary' : ''}">${h.pairs ? 'Draw again' : 'Draw names'}</button>
        <p class="error" id="derr"></p>
      </div>
    </section>

    <section class="card">
      <h2>Who's logged in</h2>
      <p class="muted small">${joined} of ${h.members.length}. The first email to confirm a name becomes that name's login.</p>
      <ul class="roster">${h.members.map((m) => `
        <li><span><span class="dot ${m.email ? 'on' : ''}"></span>${esc(m.name)}${m.has_wishlist ? ' <span class="muted small">(wishlist)</span>' : ''}</span>
        <span class="muted small">${m.email ? `${esc(m.email)} <button class="link reset" data-id="${m.id}">Reset</button>` : 'not yet'}</span></li>`).join('')}
      </ul>
      <div id="resetbox"></div>
      ${h.exclusions?.length ? `<p class="note">Can't draw each other: ${h.exclusions.map((p) => esc(p.join(' & '))).join(', ')}.</p>` : ''}
    </section>

    <section class="card stack">
      <h2>Send this to the family</h2>
      <p class="muted small">Link (already has the password in it):</p>
      <div class="wish">${esc(invite)}</div>
      <p class="muted small">Or the group password: <strong>${esc(code)}</strong>. They tap their name, enter their email, and type the code we send.</p>
      <p class="note">Keep this host page to yourself. Its link is the only thing that opens the full list.</p>
    </section>`)

  const ask = (sel, text, label, fn) => {
    const box = $app.querySelector(sel)
    box.classList.add('stack')
    box.innerHTML = `<p>${esc(text)}</p><button id="yes">${esc(label)}</button><button class="secondary" id="no">Cancel</button><p class="error" id="cerr"></p>`
    box.querySelector('#no').onclick = () => hostPage()
    box.querySelector('#yes').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Working...'
      try { await fn() } catch (err) { box.querySelector('#cerr').textContent = err.message; e.target.disabled = false; e.target.textContent = label }
    }
  }
  const runDraw = async (redo) => {
    const fresh = await L.api.host(code, hostCode)
    await L.api.hostDraw(code, hostCode, L.makeDraw(fresh.members, fresh.exclusions || []), redo)
    await hostPage(redo ? 'Names redrawn. Anyone who already looked has a new match, so let them know.' : 'Names drawn.')
  }
  $app.querySelector('#draw').onclick = () => h.pairs
    ? ask('#drawbox', 'Draw again? Everyone gets a new match, including people who have already looked.', 'Yes, redraw', () => runDraw(true))
    : ask('#drawbox', `Draw names for all ${h.members.length} people now?`, 'Yes, draw names', () => runDraw(false))
  $app.querySelectorAll('.reset').forEach((b) => b.onclick = () => {
    const m = h.members.find((x) => x.id === b.dataset.id)
    ask('#resetbox', `Clear the email on ${m.name}? They get signed out and the next person to confirm an email becomes ${m.name}. Wishlist and match stay.`,
      'Yes, reset', async () => { await L.api.hostReset(code, hostCode, m.id); await hostPage(`${m.name} was reset.`) })
  })
}

if (hostCode && code) hostPage()
else open(code)
window.addEventListener('hashchange', () => location.reload())

