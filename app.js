import * as L from './lib.js'

const $app = document.getElementById('app')
const code = new URLSearchParams(location.hash.slice(1)).get('g')
const KEY = `santa:${code}`

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmtReveal = (iso) => new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) + ' ET'

function loadMe() { try { return JSON.parse(localStorage.getItem(KEY)) } catch { return null } }
function saveMe(v) { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch {} }
function forgetMe() { try { localStorage.removeItem(KEY) } catch {} }

let group = null
let me = loadMe()
let revealTimer = null

const render = (html) => { $app.innerHTML = html }
const header = () => `
  <h1>${esc(group.name)}</h1>
  <p class="sub">${group.budget ? `Budget: ${esc(group.budget)} &middot; ` : ''}Full list opens ${esc(fmtReveal(group.reveal_at))}</p>`

async function refresh() {
  group = await L.api.group(code)
  if (me && !group.members.some((m) => m.id === me.memberId)) { forgetMe(); me = null }
  me ? home() : pickName()
}

// ---------- who are you ----------
function pickName() {
  render(`${header()}
    <section class="card">
      <h2>Who are you?</h2>
      <p class="muted small">Tap your name. This only happens once on each phone.</p>
      <div class="names">${group.members.map((m) => `
        <button class="name-btn" data-id="${m.id}">${esc(m.name)}<span class="tag">${m.claimed ? 'joined' : ''}</span></button>`).join('')}
      </div>
    </section>
    ${privacyNote()}`)
  $app.querySelectorAll('.name-btn').forEach((b) => b.onclick = () => {
    const m = group.members.find((x) => x.id === b.dataset.id)
    m.claimed ? restore(m) : join(m)
  })
}

async function join(m) {
  if (group.draw) { render(`${header()}<section class="card"><p>The draw already happened, so new people can't join.</p></section>`); return }
  const rc = L.newRecoveryCode()
  render(`${header()}
    <section class="card stack">
      <h2>Hi ${esc(m.name)}</h2>
      <p>This is your recovery code. You only need it if you switch phones or clear your browser. Take a screenshot or save it in your notes.</p>
      <div class="code">${rc}</div>
      <label class="check"><input type="checkbox" id="saved"> I saved my recovery code</label>
      <button id="go" disabled>Join</button>
      <button class="link" id="back">That's not me</button>
      <p class="error" id="err"></p>
    </section>`)
  const go = $app.querySelector('#go')
  $app.querySelector('#saved').onchange = (e) => { go.disabled = !e.target.checked }
  $app.querySelector('#back').onclick = pickName
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Joining...'
    try {
      const kp = await L.newKeyPair(), token = L.newToken()
      const backup = await L.lockBackup(rc, { priv: kp.priv, token })
      await L.api.claim(code, m.id, kp.pub, backup, token)
      me = { memberId: m.id, priv: kp.priv, token, rc }
      saveMe(me)
      await refresh()
    } catch (e) {
      $app.querySelector('#err').textContent = e.message
      go.disabled = false; go.textContent = 'Join'
    }
  }
}

function restore(m) {
  render(`${header()}
    <section class="card stack">
      <h2>Welcome back, ${esc(m.name)}</h2>
      <p class="muted">You joined on another phone or browser. Enter your recovery code to open your match here.</p>
      <input id="rc" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX">
      <button id="go">Unlock</button>
      <button class="link" id="back">That's not me</button>
      <p class="error" id="err"></p>
    </section>`)
  $app.querySelector('#back').onclick = pickName
  const go = $app.querySelector('#go')
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Unlocking...'
    try {
      const rc = $app.querySelector('#rc').value
      const s = await L.unlockBackup(rc, await L.api.backup(code, m.id))
      me = { memberId: m.id, priv: s.priv, token: s.token, rc: rc.toUpperCase().trim() }
      saveMe(me)
      await refresh()
    } catch (e) {
      $app.querySelector('#err').textContent = e.message
      go.disabled = false; go.textContent = 'Unlock'
    }
  }
}

// ---------- home ----------
async function home() {
  const mine = group.members.find((m) => m.id === me.memberId)
  const joined = group.members.filter((m) => m.claimed).length
  let match = null, matchErr = ''
  if (group.draw) {
    try { match = await L.openBox(me.priv, group.draw.assignments[me.memberId]) }
    catch { matchErr = "This phone can't open your match. Tap \"Not you?\" below and sign in with your recovery code." }
  }
  const them = match && group.members.find((m) => m.id === match.to)

  render(`${header()}
    ${group.draw ? `
      <section class="card feature">
        <p class="eyebrow">You're buying for</p>
        ${match ? `
          <div class="big-name">${esc(match.name)}</div>
          <p class="eyebrow">Their wishlist</p>
          ${them?.wishlist ? `<p class="wish">${esc(them.wishlist)}</p>` : `<p class="muted">${esc(match.name)} hasn't added a wishlist yet.</p>`}
        ` : `<p class="error">${esc(matchErr)}</p>`}
      </section>` : `
      <section class="card">
        <h2>The draw</h2>
        <p>${joined} of ${group.members.length} have joined.</p>
        ${joined < group.members.length
          ? `<p class="muted small">Once everyone has joined, anyone can run the draw.</p>`
          : `<div class="stack" id="drawbox"><p class="muted small">Everyone's in. The draw runs on this phone, seals each match so only that person can open it, and locks the full list until Christmas. Nobody sees it, including whoever presses the button.</p><button id="draw">Run the draw</button></div>`}
      </section>`}

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
      ${group.exclusions?.length ? `<p class="note">Can't draw each other: ${group.exclusions.map((p) => esc(p.join(' & '))).join(', ')}.</p>` : ''}
    </section>

    <footer class="stack">
      <div>Signed in as ${esc(mine.name)}.
        ${me.rc ? `<button class="link" id="showrc">Show recovery code</button> &middot;` : ''}
        <button class="link" id="notme">Not you?</button></div>
      <div id="rcbox"></div>
    </footer>`)

  const wl = $app.querySelector('#wl'), msg = $app.querySelector('#wlmsg')
  $app.querySelector('#savewl').onclick = async () => {
    msg.textContent = 'Saving...'
    try { await L.api.wishlist(code, me.memberId, me.token, wl.value); mine.wishlist = wl.value; msg.textContent = 'Saved.' }
    catch (e) { msg.textContent = e.message }
  }
  $app.querySelector('#notme').onclick = () => {
    if (confirmInline('#rcbox', "You'll need your recovery code to get back in on this phone.", 'Sign out', () => { forgetMe(); me = null; pickName() })) return
  }
  $app.querySelector('#showrc')?.addEventListener('click', () => {
    $app.querySelector('#rcbox').innerHTML = `<div class="code">${esc(me.rc)}</div>`
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
  if (!group.draw) { body.innerHTML = `<p class="muted">After the draw, the full list is locked until ${esc(fmtReveal(group.reveal_at))}.</p>`; return }
  const left = at - Date.now()
  if (left > 0) {
    const d = Math.floor(left / 864e5), h = Math.floor(left / 36e5) % 24, m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60
    body.innerHTML = `<div class="countdown">${d ? `${d}d ` : ''}${h}h ${m}m${d ? '' : ` ${s}s`}</div>
      <p class="muted small">Until the full list opens. It's locked with a key that won't exist until then, so nobody can open it early, not even the host.</p>`
    revealTimer = setTimeout(renderReveal, d ? 60000 : 1000)
    return
  }
  body.innerHTML = `<p class="muted">Opening the list...</p>`
  L.unTimelock(group.draw.reveal_ct).then((list) => {
    body.innerHTML = `<ul class="pairs">${list.map((p) => `<li>${esc(p.from)}<span class="arrow">&rarr;</span>${esc(p.to)}</li>`).join('')}</ul>`
  }).catch(() => {
    body.innerHTML = `<p class="muted">Almost there. Waiting for the unlock key...</p>`
    revealTimer = setTimeout(renderReveal, 10000)
  })
}

function privacyNote() {
  return `<p class="note">How the secret stays secret: your match is sealed on the phones themselves, and the server only stores scrambled data. The full list stays locked until Christmas morning.</p>`
}

// ---------- boot ----------
if (!code) {
  render(`<h1>Secret Santa</h1><p class="sub">Open the invite link the host sent you.</p>`)
} else {
  refresh().catch((e) => render(`<h1>Secret Santa</h1><p class="error">${esc(e.message === 'unknown group' ? "This invite link doesn't work. Ask the host for a fresh one." : e.message)}</p>`))
}
window.addEventListener('hashchange', () => location.reload())
