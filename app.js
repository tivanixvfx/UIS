/* =========================
   UIS Resource Hub — app.js
   Perf-focused, resilient version
   ========================= */

/* ====== Supabase Client ====== */
const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);

/** Robust session getter (prevents Chrome from hanging on refresh) */
async function getSessionSafe(ms = 4000) {
  try {
    return await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Session timeout')), ms)),
    ]);
  } catch {
    return { data: { session: null } };
  }
}

let session = (await getSessionSafe()).data.session || null;
let isAdmin = false;

supabase.auth.onAuthStateChange(async (_evt, s) => {
  session = s;
  await refreshAdminFlag();
  toggleAuthButtons();
  // reload is guarded (single-flight)
  await reload();
});

/* ====== Admin Profile Helpers ====== */
async function refreshAdminFlag() {
  if (!session) { isAdmin = false; return; }
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', session.user.id)
    .single();
  if (error) { console.warn('[profiles]', error); isAdmin = false; return; }
  isAdmin = !!data?.is_admin;
}

async function ensureProfile() {
  if (!session) return;
  const { user } = session;
  const { data, error } = await supabase
    .from('profiles').select('id').eq('id', user.id).single();
  if (error && error.code !== 'PGRST116') console.warn(error);
  if (!data) {
    await supabase.from('profiles').insert({
      id: user.id,
      full_name: user.user_metadata?.name || '',
      email: user.email,
    });
  }
}

/* ====== DOM Elements ====== */
const els = {
  q: document.getElementById('q'),
  cat: document.getElementById('cat'),
  sub: document.getElementById('sub'),
  tag: document.getElementById('tag'),
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  chips: document.getElementById('catChips'),
  pager: document.getElementById('pager'),
  empty: document.getElementById('empty'),

  modal: document.getElementById('modal'),
  addBtn: document.getElementById('addBtn'),
  titleI: document.getElementById('titleI'),
  urlI: document.getElementById('urlI'),
  catI: document.getElementById('catI'),
  subI: document.getElementById('subI'),
  tagsI: document.getElementById('tagsI'),
  descI: document.getElementById('descI'),
  save: document.getElementById('save'),
  cancel: document.getElementById('cancel'),

  adminLogin: document.getElementById('adminLogin'),
  logoutBtn: document.getElementById('logoutBtn'),
  feedbackLink: document.getElementById('feedbackLink'),
};

/* ====== Utils ====== */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function fillSelect(sel, opts) { sel.innerHTML = ''; opts.forEach(o => sel.append(new Option(o.label, o.value))); }
function labelOf(id) { return (CATS.find(c => c.id === id) || {}).name || id; }

/* ====== Data / Filters ====== */
const CATS = [
  { id:'all', name:'All', subs:[] },
  { id:'admin', name:'School Admin', subs:['Calendar','Clubs','Counseling'] },
  { id:'math', name:'Math', subs:['Algebra','Calculus','Geometry'] },
  { id:'science', name:'Science', subs:['Biology','Chemistry','Physics'] },
  { id:'computing', name:'Computing', subs:['Web Dev','Python','AI'] },
  { id:'writing', name:'Writing', subs:['Grammar','Essays','Citations'] },
  { id:'wellness', name:'Wellness', subs:['Mental Health','Fitness','Nutrition'] },
  // Courses (your codes)
  { id:'courses', name:'Courses', subs:[
    'ESLBO','ESLCO','ESLDO','ENG2D','ENG3U','ENG4U','CGC1W','MCR3U','SPH3U',
    'SBI4U','AWQ3M','AWQ4M','BBB4M','ESLEO','SNC1W','SNC2D','MPM2D','PPL2O',
    'CHC2D','MHF4U','SCH3U','SCH4U','TGJ4M','CGW4U','HIF2O','OLC4O','MCV4U'
  ]},
];

// Client state
const state = { q:'', cat:'all', sub:'', tag:'', page:1, pageSize:9 };

// View model cache (results + tags)
let items = [];       // current page of items (server-filtered)
let totalCount = 0;   // total filtered count from server
let tagCache = [];    // all tags across current filter (computed from current page + incremental fetch)

/* ====== Perf: Build filters server-side ====== */
/** Fetch a filtered & paginated slice from Supabase, plus total count. */
async function fetchResourcesServer() {
  const { q, cat, sub, tag, page, pageSize } = state;
  const from = (page - 1) * pageSize;
  const to   = from + pageSize - 1;

  // Start base query
  let query = supabase.from('resources')
    .select('id,user_id,title,url,category,subcategory,tags,description,votes,approved,created_at', { count: 'exact' });

  // Only approved for non-admins
  if (!isAdmin) query = query.eq('approved', true);

  // Category / sub filters
  if (cat && cat !== 'all') query = query.eq('category', cat);
  if (sub) query = query.eq('subcategory', sub);

  // Tag filter (Postgres text[] contains)
  if (tag) query = query.contains('tags', [tag]);

  // Search across title/description/url
  if (q) {
    const like = `%${q}%`;
    query = query.or(`title.ilike.${like},description.ilike.${like},url.ilike.${like}`);
  }

  // Sort by votes desc, then title asc
  query = query.order('votes', { ascending: false }).order('title', { ascending: true });

  // Page window
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) { console.error('[fetchResources]', error); return { items: [], count: 0 }; }

  const normalized = (data || []).map(r => ({
    id: r.id,
    user_id: r.user_id || null,
    title: r.title,
    url: r.url,
    category: r.category,
    sub: r.subcategory || '',
    tags: r.tags || [],
    description: r.description || '',
    votes: r.votes || 0,
  }));

  return { items: normalized, count: count || 0 };
}

/** Refresh tags using a cheap pass over current results.
 *  (For full accuracy across *all* pages, switch to a small RPC later.) */
function refreshTagCacheFrom(itemsPage) {
  const s = new Set(tagCache);
  itemsPage.forEach(r => (r.tags || []).forEach(t => s.add(t)));
  tagCache = Array.from(s).sort((a, b) => a.localeCompare(b));
}
function computeTags(){ return tagCache; }

/* ====== Single-flight reload (prevents overlapping calls) ====== */
let _reloading = false;
async function reload() {
  if (_reloading) return;
  _reloading = true;
  try {
    const { items: pageItems, count } = await fetchResourcesServer();
    items = pageItems;
    totalCount = count;
    refreshTagCacheFrom(items);
    render();
  } catch (e) {
    console.error('[reload]', e);
    // Optionally show a visible banner:
    // els.count.textContent = 'Network issue — unable to load resources.';
  } finally {
    _reloading = false;
  }
}

/* ====== UI Setup / Render ====== */
function setupFilters() {
  fillSelect(els.cat, CATS.map(c => ({ label: c.name, value: c.id })));
  fillSelect(els.sub, [{ label: 'Any subcategory', value: '' }]);
  fillSelect(els.tag, [{ label: 'Any tag', value: '' }]);
  fillSelect(els.catI, CATS.filter(c => c.id !== 'all').map(c => ({ label: c.name, value: c.id })));
}

function filteredLocalPreview() {
  // With server-side filters, `items` is already filtered for current page.
  // We still keep a defensive local filter for super-fast client search tweaks (optional).
  const q = state.q.trim().toLowerCase();
  if (!q) return items;
  return items.filter(r =>
    r.title.toLowerCase().includes(q) ||
    r.description.toLowerCase().includes(q) ||
    (r.tags || []).some(t => t.toLowerCase().includes(q)) ||
    r.url.toLowerCase().includes(q)
  );
}

function render() {
  toggleAuthButtons();

  // sub options per category
  const catObj = CATS.find(c => c.id === state.cat);
  const subOpts = [{ label:'Any subcategory', value:'' }, ...(catObj?.subs || []).map(s => ({ label: s, value: s }))];
  fillSelect(els.sub, subOpts); els.sub.value = state.sub;

  // tag options
  fillSelect(els.tag, [{ label: 'Any tag', value: '' }, ...computeTags().map(t => ({ label: '#'+t, value: t }))]);
  els.tag.value = state.tag;

  // chips
  els.chips.innerHTML = '';
  CATS.forEach(c => {
    const b = document.createElement('button');
    b.textContent = c.name;
    b.className = 'badge';
    if (state.cat === c.id) b.style.outline = '2px solid #3459b6';
    b.onclick = () => { state.cat = c.id; state.sub = ''; state.page = 1; els.cat.value = c.id; reload(); };
    els.chips.append(b);
  });

  // list
  const list = filteredLocalPreview();
  els.count.textContent = `${totalCount} result${totalCount !== 1 ? 's' : ''} • page ${state.page}`;

  els.empty.style.display = (totalCount === 0) ? '' : 'none';
  els.list.innerHTML = '';

  list.forEach(r => {
    const card = document.createElement('article'); card.className = 'card';

    const top = document.createElement('div'); top.className = 'row';
    const title = document.createElement('a');
    title.href = r.url; title.target = '_blank'; title.rel = 'noopener';
    title.className = 'link'; title.textContent = r.title;
    top.append(title);

    if (isAdmin) {
      const del = document.createElement('button'); del.className = 'ghost'; del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete this resource?')) return;
        const { error } = await supabase.from('resources').delete().eq('id', r.id);
        if (error) return alert(error.message);
        await reload();
      };
      top.append(del);
    }
    card.append(top);

    const meta = document.createElement('div'); meta.className = 'muted small';
    meta.textContent = `${labelOf(r.category)}${r.sub ? ' • ' + r.sub : ''}`;
    card.append(meta);

    if (r.description) { const d = document.createElement('div'); d.textContent = r.description; card.append(d); }

    if (r.tags?.length) {
      const tagWrap = document.createElement('div');
      r.tags.forEach(t => {
        const chip = document.createElement('span'); chip.className = 'badge'; chip.textContent = '#'+t;
        chip.onclick = () => { state.tag = t; state.page = 1; reload(); };
        tagWrap.append(chip);
      });
      card.append(tagWrap);
    }

    const foot = document.createElement('div'); foot.className = 'footer';
    const open = document.createElement('a'); open.href = r.url; open.target = '_blank'; open.rel = 'noopener';
    open.className = 'badge'; open.textContent = 'Open link ↗';
    foot.append(open);
    card.append(foot);

    els.list.append(card);
  });

  // pager (based on server-reported totalCount)
  const pages = Math.max(1, Math.ceil(totalCount / state.pageSize));
  els.pager.innerHTML = '';
  if (pages > 1) {
    const prev = document.createElement('button'); prev.textContent = '‹ Prev';
    prev.onclick = () => { state.page = Math.max(1, state.page - 1); reload(); };
    const info = document.createElement('span'); info.className = 'muted small'; info.textContent = `Page ${state.page} / ${pages}`;
    const next = document.createElement('button'); next.textContent = 'Next ›';
    next.onclick = () => { state.page = Math.min(pages, state.page + 1); reload(); };
    els.pager.append(prev, info, next);
  }
}

/* ====== Events ====== */
function openModal(show) {
  els.modal.style.display = show ? 'grid' : 'none';
  if (show) setTimeout(() => els.titleI?.focus(), 0);
}
els.addBtn.onclick = () => openModal(true);
els.cancel.onclick = () => openModal(false);

// Debounced search → resets to page 1 & fetches server-side
els.q.oninput = debounce(e => { state.q = e.target.value.trim(); state.page = 1; reload(); }, 200);
els.cat.onchange = e => { state.cat = e.target.value; state.sub = ''; state.page = 1; reload(); };
els.sub.onchange = e => { state.sub = e.target.value; state.page = 1; reload(); };
els.tag.onchange = e => { state.tag = e.target.value; state.page = 1; reload(); };

// Modal category → suggest subcodes for "Courses" via datalist
els.catI.onchange = () => {
  if (els.catI.value === 'courses') {
    let dl = document.getElementById('subsOptions');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'subsOptions'; document.body.appendChild(dl); }
    const courseCat = CATS.find(c => c.id === 'courses');
    dl.innerHTML = (courseCat?.subs || []).map(s => `<option value="${s}">`).join('');
    els.subI.setAttribute('list', 'subsOptions');
  } else {
    els.subI.removeAttribute('list');
  }
};

// Save with validation + clear error messages
els.save.onclick = async () => {
  const title = els.titleI.value.trim();
  const url = els.urlI.value.trim();
  const category = els.catI.value;
  const subRaw = els.subI.value.trim();
  const tags = els.tagsI.value.split(',').map(s => s.trim()).filter(Boolean);
  const description = els.descI.value.trim();

  if (!title || !url || !category) return alert('Please fill title, URL, and category.');
  if (!/^https?:\/\//i.test(url)) return alert('URL must start with http:// or https://');

  const subNorm = (category === 'courses') ? subRaw.toUpperCase() : subRaw;

  const { error } = await supabase.from('resources').insert({
    user_id: session?.user?.id || null,
    title, url, category,
    subcategory: subNorm, tags, description,
  });

  if (error) { console.error(error); return alert('Error saving: ' + error.message); }

  els.titleI.value = els.urlI.value = els.subI.value = els.tagsI.value = els.descI.value = '';
  openModal(false);
  // after insert, refresh from first page of that category/sub for the best UX
  state.page = 1;
  await reload();
};

/* ====== Admin Auth (email/password) ====== */
function toggleAuthButtons() {
  const logged = !!session;
  els.adminLogin.style.display = logged ? 'none' : '';
  els.logoutBtn.style.display = logged ? '' : 'none';
}

els.adminLogin.onclick = async () => {
  const email = prompt('Admin email:'); if (!email) return;
  const password = prompt('Admin password:'); if (!password) return;

  // Try sign-in first
  let { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error && error.status === 400) {
    // If not existing, create account (then set is_admin=true in Table Editor)
    const up = await supabase.auth.signUp({ email, password });
    if (up.error) return alert('Sign-up failed: ' + up.error.message);
    alert('Account created. In Supabase → Table Editor → profiles, set is_admin=true on your row, then sign in again.');
    return;
  }
  if (error) return alert('Sign-in failed: ' + error.message);

  await ensureProfile();
  await refreshAdminFlag();
  toggleAuthButtons();
  await reload();
};

els.logoutBtn.onclick = async () => {
  await supabase.auth.signOut();
  isAdmin = false;
  toggleAuthButtons();
  await reload();
};

/* ====== Boot ====== */
// Build filter UIs immediately so the page doesn't look empty
setupFilters();
render();                           // optimistic first paint
await refreshAdminFlag();
toggleAuthButtons();
await reload();
els.cat.value = state.cat;

// (Optional) Ensure the feedback link opens in new tab with safe rel
/*if (els.feedbackLink) {
  els.feedbackLink.target = '_blank';
  els.feedbackLink.rel = 'noopener noreferrer';
  // If you didn't set href in HTML, you can assign here:
  // els.feedbackLink.href = 'https://docs.google.com/forms/d/YOUR_FORM_ID/viewform';
  */
}
