/* =========================
   UIS Resource Hub — app.js
   ========================= */

const SUPABASE_URL  = "https://cacfbgxkohkxexduzgxc.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhY2ZiZ3hrb2hreGV4ZHV6Z3hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgzOTU4MjksImV4cCI6MjA3Mzk3MTgyOX0.-f2Hy2ZPexkD3mWbKAC1hti5pyGOd2HmfGFfDissqoc";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

/* ===== SUBJECT + COURSE MAPPING ===== */

const SUBJECTS = [
  { id:'esl',        name:'ESL',             codes:['ESLBO','ESLCO','ESLDO','ESLEO'] },
  { id:'english',    name:'English',         codes:['ENG2D','ENG3U','ENG4U','OLC4O'] },
  { id:'geography',  name:'Geography',       codes:['CGC1W','CGW4U'] },
  { id:'math',       name:'Math',            codes:['MPM2D','MCR3U','MHF4U','MCV4U'] },
  { id:'physics',    name:'Physics',         codes:['SPH3U'] },
  { id:'biology',    name:'Biology',         codes:['SBI4U'] },
  { id:'chemistry',  name:'Chemistry',       codes:['SCH3U','SCH4U'] },
  { id:'science',    name:'Science',         codes:['SNC1W','SNC2D'] },
  { id:'art',        name:'Visual Arts',     codes:['AWQ3M','AWQ4M'] },
  { id:'business',   name:'Business',        codes:['BBB4M'] },
  { id:'physed',     name:'Phys Ed',         codes:['PPL2O'] },
  { id:'history',    name:'History',         codes:['CHC2D'] },
  { id:'tech',       name:'Tech',            codes:['TGJ4M'] },
  { id:'social',     name:'Social Science',  codes:['HIF2O'] },
];

const COURSE_CODES = SUBJECTS.flatMap(s => s.codes);

const CODE_TO_SUBJECT = {};
SUBJECTS.forEach(s => s.codes.forEach(code => {
  CODE_TO_SUBJECT[code] = s.id;
}));

// For the chip bar
const SUBJECT_CHIPS = [
  { id:'all', name:'All' },
  ...SUBJECTS
];

/* ===== Auth helpers ===== */

async function getSessionSafe(ms = 3500) {
  try {
    return await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
  } catch {
    return { data: { session: null } };
  }
}

let session = (await getSessionSafe()).data.session || null;
let isAdmin = false;

supabase.auth.onAuthStateChange(async (_evt, s) => {
  session = s;
  await refreshAdminFlag().catch(console.warn);
  toggleAuthButtons();
  await reload();
});

/* ===== DOM refs ===== */

const els = {
  q: document.getElementById('q'),
  cat: document.getElementById('cat'),
  sub: document.getElementById('sub'),
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  chips: document.getElementById('catChips'),
  pager: document.getElementById('pager'),
  empty: document.getElementById('empty'),

  modal: document.getElementById('modal'),
  addBtn: document.getElementById('addBtn'),
  titleI: document.getElementById('titleI'),
  urlI: document.getElementById('urlI'),
  courseI: document.getElementById('courseI'),
  nameI: document.getElementById('nameI'),
  descI: document.getElementById('descI'),
  save: document.getElementById('save'),
  cancel: document.getElementById('cancel'),

  adminLogin: document.getElementById('adminLogin'),
  logoutBtn: document.getElementById('logoutBtn'),

  policyModal: document.getElementById('policyModal'),
  policyClose: document.getElementById('policyClose'),
  policyFooterLink: document.getElementById('policyFooterLink'),

  feedbackLink: document.getElementById('feedbackLink'),
};

/* ===== Utils ===== */

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function fillSelect(sel, opts) {
  sel.innerHTML = '';
  opts.forEach(o => sel.append(new Option(o.label, o.value)));
}

function subjectLabel(id) {
  const s = SUBJECTS.find(x => x.id === id);
  if (s) return s.name;
  return 'Other';
}

function isNewResource(r) {
  if (!r.created_at) return false;
  const created = new Date(r.created_at).getTime();
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return (now - created) <= sevenDays;
}

/* ===== State ===== */

const state = {
  q: '',
  cat: 'all',   // subject id, or 'all'
  sub: '',      // course code
  page: 1,
  pageSize: 9,
};

let items = [];

/* ===== Admin helpers ===== */

async function refreshAdminFlag() {
  if (!session) {
    isAdmin = false;
    return;
  }
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', session.user.id)
    .single();
  if (error) {
    console.warn(error);
    isAdmin = false;
    return;
  }
  isAdmin = !!data?.is_admin;
}

async function ensureProfile() {
  if (!session) return;
  const { user } = session;
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .single();
  if (error && error.code !== 'PGRST116') console.warn(error);
  if (!data) {
    await supabase.from('profiles').insert({
      id: user.id,
      full_name: user.user_metadata?.name || '',
      email: user.email,
    });
  }
}

function toggleAuthButtons() {
  const logged = !!session;
  els.adminLogin.style.display = logged ? 'none' : '';
  els.logoutBtn.style.display = logged ? '' : 'none';
}

/* ===== Setup filters ===== */

function setupFilters() {
  // Subject dropdown (filter)
  fillSelect(els.cat, [
    { label: 'All subjects', value: 'all' },
    ...SUBJECTS.map(s => ({ label: s.name, value: s.id })),
  ]);

  // Course dropdown (filter) – initial: all courses
  fillSelect(els.sub, [
    { label: 'Any course', value: '' },
    ...COURSE_CODES.map(c => ({ label: c, value: c })),
  ]);

  // Course dropdown in modal (posting)
  fillSelect(els.courseI, [
    { label: 'Select course', value: '' },
    ...COURSE_CODES.map(c => ({ label: c, value: c })),
  ]);
}

/* ===== Fetch from Supabase ===== */

async function fetchResources() {
  const { data, error } = await supabase
    .from('resources')
    .select('id,user_id,title,url,category,subcategory,student_name,description,votes,approved,created_at')
    .order('votes', { ascending: false })
    .order('title', { ascending: true });

  if (error) {
    console.error(error);
    return [];
  }

  return (data || [])
    .filter(r => isAdmin || r.approved === true)
    .map(r => ({
      id: r.id,
      user_id: r.user_id || null,
      title: r.title,
      url: r.url,
      category: r.category,          // subject id
      sub: r.subcategory || '',      // course code
      name: r.student_name || '',
      description: r.description || '',
      votes: r.votes || 0,
      created_at: r.created_at || null,
    }));
}

/* ===== Filter / render helpers ===== */

function filtered() {
  let list = [...items];

  // subject filter
  if (state.cat !== 'all') {
    list = list.filter(r => r.category === state.cat);
  }

  // course filter
  if (state.sub) {
    list = list.filter(r => r.sub === state.sub);
  }

  // search
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter(r =>
      r.title.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.sub.toLowerCase().includes(q) ||
      r.url.toLowerCase().includes(q)
    );
  }

  // sort: votes desc, then title
  list.sort((a, b) => (b.votes - a.votes) || a.title.localeCompare(b.title));
  return list;
}

/* ===== Render ===== */

function render() {
  toggleAuthButtons();

  // Update course dropdown (filter) based on selected subject
  let courseOptions;
  if (state.cat === 'all') {
    courseOptions = COURSE_CODES;
  } else {
    const subj = SUBJECTS.find(s => s.id === state.cat);
    courseOptions = subj ? subj.codes : [];
  }
  fillSelect(els.sub, [
    { label: 'Any course', value: '' },
    ...courseOptions.map(c => ({ label: c, value: c })),
  ]);
  els.sub.value = state.sub;

  // Subject chips
  els.chips.innerHTML = '';
  SUBJECT_CHIPS.forEach(c => {
    const b = document.createElement('button');
    b.textContent = c.name;
    b.className = 'badge';
    if (state.cat === c.id) {
      b.style.outline = '2px solid var(--brand)';
    }
    b.onclick = () => {
      state.cat = c.id;
      state.sub = '';
      state.page = 1;
      els.cat.value = c.id;
      render();
    };
    els.chips.append(b);
  });

  const list = filtered();
  els.count.textContent = `${list.length} result${list.length !== 1 ? 's' : ''} • sorted by votes`;
  els.empty.style.display = list.length ? 'none' : '';

  // Cards
  els.list.innerHTML = '';
  const start = (state.page - 1) * state.pageSize;
  list.slice(start, start + state.pageSize).forEach(r => {
    const card = document.createElement('article');
    card.className = 'card';

    const top = document.createElement('div');
    top.className = 'row';

    const title = document.createElement('a');
    title.href = r.url;
    title.target = '_blank';
    title.rel = 'noopener';
    title.className = 'link';
    title.textContent = r.title;
    top.append(title);

    // New badge if within 7 days
    if (isNewResource(r)) {
      const newBadge = document.createElement('span');
      newBadge.className = 'badge badge-new small';
      newBadge.style.marginLeft = '6px';
      newBadge.textContent = 'New';
      top.append(newBadge);
    }

    // Admin delete button
    if (isAdmin) {
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete this resource?')) return;
        const { error } = await supabase.from('resources').delete().eq('id', r.id);
        if (error) return alert(error.message);
        await reload();
      };
      top.append(del);
    }

    card.append(top);

    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = `${subjectLabel(r.category)}${r.sub ? ' • ' + r.sub : ''}`;
    card.append(meta);

    if (r.description) {
      const d = document.createElement('div');
      d.textContent = r.description;
      card.append(d);
    }

    const foot = document.createElement('div');
    foot.className = 'footer';

    const open = document.createElement('a');
    open.href = r.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.className = 'badge';
    open.textContent = 'Open link ↗';
    foot.append(open);

    if (r.name) {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'muted small';
      nameSpan.textContent = r.name;
      foot.append(nameSpan);
    }

    card.append(foot);

    els.list.append(card);
  });

  // Pagination
  const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
  els.pager.innerHTML = '';
  if (pages > 1) {
    const prev = document.createElement('button');
    prev.textContent = '‹ Prev';
    prev.onclick = () => {
      state.page = Math.max(1, state.page - 1);
      render();
    };

    const info = document.createElement('span');
    info.className = 'muted small';
    info.textContent = `Page ${state.page} / ${pages}`;

    const next = document.createElement('button');
    next.textContent = 'Next ›';
    next.onclick = () => {
      state.page = Math.min(pages, state.page + 1);
      render();
    };

    els.pager.append(prev, info, next);
  }
}

/* ===== Reload ===== */

async function reload() {
  items = await fetchResources();
  render();
}

/* ===== Modal & events ===== */

function openModal(show) {
  els.modal.style.display = show ? 'grid' : 'none';
  if (show) {
    setTimeout(() => els.titleI?.focus(), 0);
  }
}

els.addBtn.onclick = () => openModal(true);
els.cancel.onclick = () => openModal(false);

els.q.oninput = debounce(e => {
  state.q = e.target.value;
  state.page = 1;
  render();
}, 150);

els.cat.onchange = e => {
  state.cat = e.target.value;
  state.sub = '';
  state.page = 1;
  render();
};

els.sub.onchange = e => {
  state.sub = e.target.value;
  state.page = 1;
  render();
};

/* ===== Save new resource ===== */

els.save.onclick = async () => {
  const title = els.titleI.value.trim();
  const url = els.urlI.value.trim();
  const course = els.courseI.value;
  const name = els.nameI.value.trim();
  const description = els.descI.value.trim();

  if (!title || !url || !course) {
    return alert('Please fill title, URL, and course.');
  }
  if (!/^https?:\/\//i.test(url)) {
    return alert('URL must start with http:// or https://');
  }

  const agree = document.getElementById('policyAgree');
  if (!agree?.checked) {
    return alert('Please confirm your submission follows the School Resource Guidelines.');
  }

  const category = CODE_TO_SUBJECT[course] || 'other';

  const { error } = await supabase.from('resources').insert({
    user_id: session?.user?.id || null,
    title,
    url,
    category,          // subject id
    subcategory: course,
    student_name: name || null,
    description,
  });

  if (error) {
    return alert(error.message);
  }

  // Reset form
  els.titleI.value = '';
  els.urlI.value = '';
  els.nameI.value = '';
  els.descI.value = '';
  els.courseI.value = '';
  agree.checked = false;

  openModal(false);
  await reload();
};

/* ===== Policy modal ===== */

function openPolicy(show) {
  els.policyModal.style.display = show ? 'grid' : 'none';
}

els.policyFooterLink?.addEventListener('click', e => {
  e.preventDefault();
  openPolicy(true);
});

els.policyClose?.addEventListener('click', () => openPolicy(false));

/* ===== Admin auth ===== */

els.adminLogin.onclick = async () => {
  const email = prompt('Admin email:');
  if (!email) return;
  const password = prompt('Admin password:');
  if (!password) return;

  let { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error && error.status === 400) {
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

/* ===== Feedback link ===== */

els.feedbackLink?.addEventListener('click', e => {
  e.preventDefault();
  window.open(
    'https://docs.google.com/forms/d/e/1FAIpQLSe-pZFxPiXsyy53qCLOuN82-9gplif_TpVXt_VF877b2G9W3w/viewform?usp=sharing&ouid=107599033470817781782',
    '_blank',
    'noopener'
  );
});

/* ===== Boot ===== */

setupFilters();
await refreshAdminFlag().catch(console.warn);
toggleAuthButtons();
await reload();
