const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let PIN = sessionStorage.getItem('pin') || '';

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json', 'x-staff-pin': PIN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
  return j;
}
//Stop double-taps / button mashing by locking the submit button briefly
function guard(e) {
  e.preventDefault(); const b = e.target.querySelector('button');
  if (b.disabled) return false;
  const t = b.textContent; b.disabled = true; b.textContent = 'Saving...';
  setTimeout(() => { b.disabled = false; b.textContent = t; }, 3000);
  return true;
}
const formData = (f) => Object.fromEntries(new FormData(f));
//One key per form fill so a double tap or retry returns the same record while a new fill gets a new key
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
const keys = {};
const withKey = (f) => ({ ...formData(f), idemKey: (keys[f.id] ||= newKey()) });
const doneKey = (f) => { delete keys[f.id]; };
const codeBox = (c) => `<div class="card"><p>Write this code down or tell a volunteer. You need it to check back:</p><div class="code">${esc(c)}</div></div>`;
const fail = (el, e) => (el.innerHTML = `<p class="err">${esc(e.message)}</p>`);

//Tabs
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'staff' && PIN) loadStaff();
});

//Search
$('#searchForm').onsubmit = async (e) => {
  e.preventDefault(); const out = $('#searchOut');
  try {
    const { results } = await api('/search', 'POST', formData(e.target));
    out.innerHTML = results.length
      ? results.map((r) => `<div class="card"><b>${esc(r.name || 'Name not given')}</b> (${esc(r.ageGroup)})<br>Is at: <b>${esc(r.shelter || 'unknown')}</b><br><span class="muted">${esc(r.description)}</span></div>`).join('')
      : `<div class="card">No public match yet. Some people choose to stay private, so please leave a note below. If they check in we'll ask them for you.</div>`;
  } catch (er) { fail(out, er); }
};
$('#reportForm').onsubmit = async (e) => {
  if (!guard(e)) return; const out = $('#reportOut');
  try { const { code } = await api('/reports', 'POST', withKey(e.target)); out.innerHTML = codeBox(code) + '<p>Check back under "Code Check In". We will keep watching.</p>'; doneKey(e.target); e.target.reset(); }
  catch (er) { fail(out, er); }
};

//Check-in
$('#checkinForm').onsubmit = async (e) => {
  if (!guard(e)) return; const out = $('#checkinOut');
  try { localStorage.setItem('shelter', e.target.shelter.value); } catch {}
  try {
    const r = await api('/people', 'POST', withKey(e.target));
    out.innerHTML = codeBox(r.code) + `<p>Privacy: <b>${esc({ open: 'anyone can see where you are', ask: 'we ask you first', hidden: 'no one is told' }[r.visibility])}</b>. You can change this any time under "Code Check In".</p>`;
    doneKey(e.target); e.target.reset();
  } catch (er) { fail(out, er); }
};

$('#codeForm').onsubmit = async (e) => {
  e.preventDefault(); const out = $('#codeOut'); const code = formData(e.target).code.trim().toUpperCase();
  try {
    const d = await api('/lookup/' + encodeURIComponent(code));
    if (d.kind === 'report') {
      out.innerHTML = d.status === 'found'
        ? d.connections.map((c) => `<div class="card"><b>Good news.</b> ${esc(d.lookingFor)} agreed to be in touch.<br>Where: <b>${esc(c.shelter || 'ask staff')}</b><br>Contact: ${esc(c.contact_note || 'ask at that location')}</div>`).join('')
        : `<div class="card">Still waiting on "${esc(d.lookingFor)}". Check back again later. We keep watching new check-ins.</div>`;
    } else {
      out.innerHTML = `<div class="card"><b>${esc(d.name || 'Name not given')}</b><br>Location: ${esc(d.shelter || 'not set')}</div>` +
        (d.requests.length ? '<h3>Someone is looking for you</h3>' + d.requests.map((r) => `<div class="card">
          <b>${esc(r.seeker_name || 'Someone')}</b> says: ${esc(r.message || '(no message)')}
          <br><span class="muted">${esc(r.seeker_contact)}</span><br>
          <button data-act="respond" data-code="${code}" data-id="${r.id}" data-yes="1">Yes, share where I am</button>
          <button class="alt" data-act="respond" data-code="${code}" data-id="${r.id}">No</button></div>`).join('') : '<p class="muted">No one has asked about you.</p>') +
        `<h3>Update</h3><label>Where are you now?<input id="upShelter" value="${esc(d.shelter)}"></label>
         <label>Who can see me<select id="upVis"><option value="open">Anyone</option><option value="ask">Ask me first</option><option value="hidden">No one</option></select></label>
         <button data-act="update" data-code="${code}">Save</button>
         <button class="danger" data-act="erase" data-code="${code}">Delete my record</button>`;
      if ($('#upVis')) $('#upVis').value = d.visibility;
    }
  } catch (er) { fail(out, new Error(/not found/i.test(er.message) ? 'Code not found. Check the letters and numbers.' : er.message)); }
};

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const { act, code, id, yes } = b.dataset;
  if (b.disabled) return; b.disabled = true;
  try {
    if (act === 'respond') { await api(`/people/${code}/respond`, 'POST', { matchId: +id, accept: !!yes }); }
    if (act === 'update') { await api(`/people/${code}/update`, 'POST', { shelter: $('#upShelter').value, visibility: $('#upVis').value }); alert('Saved'); b.disabled = false; }
    if (act === 'erase' && confirm('Delete your record permanently?')) { await api('/people/' + code, 'DELETE'); $('#codeOut').innerHTML = '<p>Deleted.</p>'; return; }
    if (b.closest('#staffArea')) return loadStaff();
    if (act === 'respond') $('#codeForm').requestSubmit();
  } catch (er) { b.disabled = false; alert(er.message); }
});

//Staff
$('#pinForm').onsubmit = (e) => { e.preventDefault(); PIN = formData(e.target).pin; sessionStorage.setItem('pin', PIN); loadStaff(); };
$('#staffQ').oninput = () => loadStaff();
async function loadStaff() {
  try {
    const d = await api('/staff/overview?q=' + encodeURIComponent($('#staffQ').value));
    $('#pinForm').hidden = true; $('#staffArea').hidden = false;
    $('#staffCounts').textContent = `${d.counts.people} checked in, ${d.counts.reports} notes left`;
    $('#pendCount').textContent = d.pending.length;
    document.querySelector('[data-tab=staff]').textContent = d.pending.length ? `Staff (${d.pending.length})` : 'Staff';
    const conf = (s) => (s >= 0.9 ? ['Strong match', 'good'] : s >= 0.8 ? ['Likely match', 'ok'] : ['Possible match', 'weak']);
    const age = (a) => (a != null ? `, ~${esc(a)}` : '');
    $('#staffPending').innerHTML = d.pending.length ? d.pending.map((m) => {
      const [label, cls] = conf(m.score);
      return `<div class="card match ${cls}">
        <div><span class="pill ${cls}">${label} · ${Math.round(m.score * 100)}%</span>
        ${m.age_group === 'child' ? '<span class="pill kid">Child: verify the guardian in person</span>' : ''}</div>
        <div class="cols">
          <div><div class="muted">Someone is looking for</div><b>${esc(m.looking_for)}</b>${age(m.looking_age)}<br><span class="muted">${esc(m.looking_desc)}</span></div>
          <div><div class="muted">Checked in as</div><b>${esc(m.person_name)}</b>${age(m.person_age)}<br>${esc(m.shelter)}<br><span class="muted">${esc(m.person_desc)}</span></div>
        </div>
        <div class="muted">From ${esc(m.seeker_name || 'someone')}: ${esc(m.message)} ${esc(m.seeker_contact)}</div>
        <button data-act="respond" data-code="${esc(m.code)}" data-id="${m.id}" data-yes="1">They said yes</button>
        <button class="alt" data-act="respond" data-code="${esc(m.code)}" data-id="${m.id}">No / not them</button></div>`;
    }).join('') : '<p class="muted">Nothing waiting. New matches appear here automatically.</p>';
    $('#staffPeople').innerHTML = d.people.map((p) => `<div class="card"><b>${esc(p.name || 'Name not given')}</b> (${esc(p.age_group)}) · ${esc(p.shelter)} · <code>${esc(p.code)}</code> · ${esc(p.visibility)}</div>`).join('');
    $('#shelters').innerHTML = [...new Set(d.people.map((p) => p.shelter).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join('');
  } catch (er) { PIN = ''; sessionStorage.removeItem('pin'); $('#pinForm').hidden = false; $('#staffArea').hidden = true; alert(er.message); }
}
setInterval(() => { if (PIN && !$('#tab-staff').hidden) loadStaff(); }, 15000); // Auto-refresh queue
$('#importBtn').onclick = async () => {
  const rows = $('#importText').value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((a) => a[0])
    .map(([name, age, shelter, visibility, ...d]) => ({ name, age, shelter, visibility, description: d.join(', ') }));
  try { const r = await api('/staff/import', 'POST', { rows }); $('#importOut').textContent = `Imported ${r.imported}`; $('#importText').value = ''; loadStaff(); }
  catch (er) { $('#importOut').textContent = er.message; }
};

//Remember the shelter so a volunteer can enter many people quickly
function restoreShelter() { try { $('#checkinForm').shelter.value = localStorage.getItem('shelter') || ''; } catch {} }
restoreShelter();
$('#checkinForm').addEventListener('reset', () => setTimeout(restoreShelter, 0));
