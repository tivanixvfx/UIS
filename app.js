/* =========================
   UIS Resource Hub — stable app.js (beginner-safe)
   ========================= */

/* ---- Supabase client (already defined in index.html) ---- */
const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);

/* ---- Session getter with a safety timeout (avoids Chrome hangs) ---- */
async function getSessionSafe(ms = 3500) {
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

/* ---- Show status text (so you see what’s happening) ---- */
function setStatus(msg, color = '#9aa3b2') {
  const el = document.getElementById('count');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color;
}

/* ---- Make errors visible (no more silent blank page) ---- */
window.addEventListener('error', e => { console.error(e.message || e.error); setStatus('Error loading page. See Console.', '#ff6b6b'); });
window.addEventListener('unhandledrejection', e => { console.error(e.reason); setStatus('Error loading data. See Console.', '#ff6b6b'); });

/* ---- Auth state changes ---- */
supabase.auth.onAuthStateChange(async (_evt, s) => {
  session = s;
  await refreshAdminFlag();
  toggleAuthButtons();
  await reload();
});

/* ====== Elements ====== */
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

  onboardModal: document.getElementById('onboardModal'),
  onboardClose: document.getElementById('onboardClose'),
  onboardStart: document.getElementById('onboardStart'),
  onboardDontShow: document.getElementById('onboardDontShow'),

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

/* ====== Small helpers ====== */
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
function fillSelect(sel, opts){ sel.innerHTML=''; opts.forEach(o=> sel.append(new Option(o.label,o.value))); }
function labelOf(id){ return (CATS.find(c=>c.id===id)||{}).name || id; }

/* ====== Categories (with your course codes) ====== */
const CATS = [
  { id:'all', name:'All', subs:[] },
  { id:'admin', name:'School Admin', subs:['Calendar','Clubs','Counseling'] },
  { id:'math', name:'Math', subs:['Algebra','Calculus','Geometry'] },
  { id:'science', name:'Science', subs:['Biology','Chemistry','Physics'] },
  { id:'computing', name:'Computing', subs:['Web Dev','Python','AI'] },
  { id:'writing', name:'Writing', subs:['Grammar','Essays','Citations'] },
  { id:'wellness', name:'Wellness', subs:['Mental Health','Fitness','Nutrition'] },
  { id:'courses', name:'Courses', subs:[
    'ESLBO','ESLCO','ESLDO','ENG2D','ENG3U','ENG4U','CGC1W','MCR3U','SPH3U',
    'SBI4U','AWQ3M','AWQ4M','BBB4M','ESLEO','SNC1W','SNC2D','MPM2D','PPL2O',
    'CHC2D','MHF4U','SCH3U','SCH4U','TGJ4M','CGW4U','HIF2O','OLC4O','MCV4U'
  ]},
];

/* ====== State & caches ====== */
const state = { q:'', cat:'all', sub:'', tag:'', page:1, pageSize:9 };
let items = [];
let totalCount = 0;
let tagCache = [];

/* ====== Build filter controls ====== */
function setupFilters(){
  fillSelect(els.cat, CATS.map(c=>({label:c.name, value:c.id})));
  fillSelect(els.sub, [{label:'Any subcategory', value:''}]);
  fillSelect(els.tag, [{label:'Any tag', value:''}]);
  fillSelect(els.catI, CATS.filter(c=>c.id!=='all').map(c=>({label:c.name, value:c.id})));
}

/* ====== Admin/profile ====== */
async function refreshAdminFlag(){
  if (!session) { isAdmin=false; return; }
  const { data, error } = await supabase
    .from('profiles').select('is_admin').eq('id', session.user.id).single();
  if (error) { console.warn(error); isAdmin=false; return; }
  isAdmin = !!data?.is_admin;
}
async function ensureProfile(){
  if (!session) return;
  const { user } = session;
  const { data, error } = await supabase
    .from('profiles').select('id').eq('id', user.id).single();
  if (!data && !error) return;
  if (!data) await supabase.from('profiles').insert({
    id: user.id, full_name: user.user_metadata?.name || '', email: user.email
  });
}

/* ====== Server fetch (filtered + paged). Falls back if needed. ====== */
async function fetchResources(){
  const { q, cat, sub, tag, page, pageSize } = state;
  const from = (page - 1) * pageSize;
  const to   = from + pageSize - 1;

  let query = supabase.from('resources')
    .select('id,user_id,title,url,category,subcategory,tags,description,votes,approved,created_at', { count: 'exact' });

  if (!isAdmin) query = query.eq('approved', true);
  if (cat && cat!=='all') query = query.eq('category', cat);
  if (sub) query = query.eq('subcategory', sub);
  if (tag) query = query.contains('tags', [tag]);
  if (q)  { const like = `%${q}%`; query = query.or(`title.ilike.${like},description.ilike.${like},url.ilike.${like}`); }

  query = query.order('votes', { ascending:false }).order('title', { ascending:true }).range(from, to);

  // Try main query
  let data, error, count;
  try {
    const res = await Promise.race([
      query,
      new Promise((_,rej)=> setTimeout(()=> rej(new Error('Request timeout')), 10000))
    ]);
    data = res.data; error = res.error; count = res.count;
    if (error) throw error;
  } catch (e) {
    // Fallback: same query minus the OR search (do local search if q exists)
    console.warn('[fallback fetch]', e?.message || e);
    let q2 = supabase.from('resources')
      .select('id,user_id,title,url,category,subcategory,tags,description,votes,approved,created_at', { count: 'exact' });
    if (!isAdmin) q2 = q2.eq('approved', true);
    if (cat && cat!=='all') q2 = q2.eq('category', cat);
    if (sub) q2 = q2.eq('subcategory', sub);
    if (tag) q2 = q2.contains('tags', [tag]);
    q2 = q2.order('votes', { ascending:false }).order('title', { ascending:true }).range(from, to);

    const res2 = await q2;
    data = res2.data; error = res2.error; count = res2.count;
    if (error) { console.error(error); return { items: [], count: 0 }; }
    if (q) {
      const qq = q.toLowerCase();
      data = (data||[]).filter(r =>
        r.title?.toLowerCase().includes(qq) ||
        r.description?.toLowerCase().includes(qq) ||
        (r.tags||[]).some(t => t.toLowerCase().includes(qq)) ||
        r.url?.toLowerCase().includes(qq)
      );
    }
  }

  const normalized = (data||[]).map(r=>({
    id:r.id, user_id:r.user_id||null, title:r.title, url:r.url,
    category:r.category, sub:r.subcategory||'',
    tags:r.tags||[], description:r.description||'',
    votes:r.votes||0
  }));
  return { items: normalized, count: count || normalized.length };
}

/* ====== Tag cache ====== */
function refreshTagCacheFrom(list) {
  const s = new Set(tagCache);
  list.forEach(r => (r.tags||[]).forEach(t => s.add(t)));
  tagCache = Array.from(s).sort((a,b)=>a.localeCompare(b));
}
function computeTags(){ return tagCache; }

/* ====== Render ====== */
function render(){
  toggleAuthButtons();

  // sub options per category
  const catObj = CATS.find(c=> c.id===state.cat);
  const subOpts = [{label:'Any subcategory', value:''}, ...(catObj?.subs||[]).map(s=>({label:s, value:s}))];
  fillSelect(els.sub, subOpts); els.sub.value = state.sub;

  // tag options
  fillSelect(els.tag, [{label:'Any tag', value:''}, ...computeTags().map(t=>({label:'#'+t, value:t}))]);
  els.tag.value = state.tag;

  // chips
  els.chips.innerHTML='';
  CATS.forEach(c=>{
    const b=document.createElement('button'); b.textContent=c.name; b.className='badge';
    if(state.cat===c.id) b.style.outline='2px solid #3459b6';
    b.onclick=()=>{ state.cat=c.id; state.sub=''; state.page=1; els.cat.value=c.id; reload(); };
    els.chips.append(b);
  });

  // list area
  els.list.innerHTML='';
  if (!items.length) {
    els.empty.style.display = '';
  } else {
    els.empty.style.display = 'none';
    items.forEach(r=>{
      const card=document.createElement('article'); card.className='card';

      const top=document.createElement('div'); top.className='row';
      const title=document.createElement('a'); title.href=r.url; title.target='_blank'; title.rel='noopener'; title.className='link'; title.textContent=r.title;
      top.append(title);

      if(isAdmin){
        const del=document.createElement('button'); del.className='ghost'; del.textContent='Delete';
        del.onclick=async()=>{ if(!confirm('Delete this resource?'))return;
          const { error }=await supabase.from('resources').delete().eq('id', r.id);
          if(error) return alert(error.message);
          await reload();
        };
        top.append(del);
      }
      card.append(top);

      const meta=document.createElement('div'); meta.className='muted small';
      meta.textContent=`${labelOf(r.category)}${r.sub ? ' • '+r.sub : ''}`;
      card.append(meta);

      if(r.description){ const d=document.createElement('div'); d.textContent=r.description; card.append(d); }

      if(r.tags?.length){
        const tagWrap=document.createElement('div');
        r.tags.forEach(t=>{ const chip=document.createElement('span'); chip.className='badge'; chip.textContent='#'+t; chip.onclick=()=>{ state.tag=t; state.page=1; reload(); }; tagWrap.append(chip); });
        card.append(tagWrap);
      }

      const foot=document.createElement('div'); foot.className='footer';
      const open=document.createElement('a'); open.href=r.url; open.target='_blank'; open.rel='noopener'; open.className='badge'; open.textContent='Open link ↗';
      foot.append(open); card.append(foot);

      els.list.append(card);
    });
  }

  // pager
  const pages=Math.max(1, Math.ceil(totalCount/state.pageSize));
  els.pager.innerHTML='';
  if(pages>1){
    const prev=document.createElement('button'); prev.textContent='‹ Prev';
    prev.onclick=()=>{ state.page=Math.max(1,state.page-1); reload(); };
    const info=document.createElement('span'); info.className='muted small'; info.textContent=`Page ${state.page} / ${pages}`;
    const next=document.createElement('button'); next.textContent='Next ›';
    next.onclick=()=>{ state.page=Math.min(pages,state.page+1); reload(); };
    els.pager.append(prev,info,next);
  }

  // status line
  setStatus(`${totalCount} result${totalCount!==1?'s':''} • page ${state.page}`);
}

/* ====== Reload (single-flight so it can’t overlap) ====== */
let _reloading = false;
async function reload(){
  if(_reloading) return;
  _reloading = true;
  try {
    setStatus('Loading…');
    const { items: pageItems, count } = await fetchResources();
    items = pageItems; totalCount = count;
    refreshTagCacheFrom(items);
    render();
  } catch(e){
    console.error('[reload]', e);
    setStatus('Network/Auth issue — see Console.', '#ff6b6b');
  } finally {
    _reloading = false;
  }
}

/* ====== Events ====== */
function openModal(show){ els.modal.style.display = show ? 'grid' : 'none'; if (show) setTimeout(()=> els.titleI?.focus(),0); }
els.addBtn.onclick = ()=> openModal(true);
els.cancel.onclick = ()=> openModal(false);

els.q.oninput = debounce(e=>{ state.q=e.target.value.trim(); state.page=1; reload(); }, 220);
els.cat.onchange = e=>{ state.cat=e.target.value; state.sub=''; state.page=1; reload(); };
els.sub.onchange = e=>{ state.sub=e.target.value; state.page=1; reload(); };
els.tag.onchange = e=>{ state.tag=e.target.value; state.page=1; reload(); };

// Modal: show course codes as suggestions if "Courses"
els.catI.onchange = () => {
  if (els.catI.value === 'courses') {
    let dl = document.getElementById('subsOptions');
    if (!dl) { dl = document.createElement('datalist'); dl.id='subsOptions'; document.body.appendChild(dl); }
    const courseCat = CATS.find(c=>c.id==='courses');
    dl.innerHTML = (courseCat?.subs||[]).map(s=>`<option value="${s}">`).join('');
    els.subI.setAttribute('list','subsOptions');
  } else {
    els.subI.removeAttribute('list');
  }
};

// Save
els.save.onclick = async () => {
  const title=els.titleI.value.trim();
  const url=els.urlI.value.trim();
  const category=els.catI.value;
  const subRaw=els.subI.value.trim();
  const tags=els.tagsI.value.split(',').map(s=>s.trim()).filter(Boolean);
  const description=els.descI.value.trim();

  if(!title || !url || !category) return alert('Please fill title, URL, and category.');
  if(!/^https?:\/\//i.test(url)) return alert('URL must start with http:// or https://');
  const subNorm = (category==='courses') ? subRaw.toUpperCase() : subRaw;

  const { error } = await supabase.from('resources').insert({
    user_id: session?.user?.id || null,
    title, url, category, subcategory: subNorm, tags, description
  });
  if (error) { console.error(error); return alert('Error saving: ' + error.message); }

  els.titleI.value = els.urlI.value = els.subI.value = els.tagsI.value = els.descI.value = '';
  openModal(false);
  state.page = 1;
  await reload();
};

/* ====== Admin auth ====== */
function toggleAuthButtons(){
  const logged = !!session;
  els.adminLogin.style.display = logged ? 'none' : '';
  els.logoutBtn.style.display  = logged ? '' : 'none';
}
els.adminLogin.onclick = async () => {
  const email = prompt('Admin email:'); if (!email) return;
  const password = prompt('Admin password:'); if (!password) return;

  let { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error && error.status === 400) {
    const up = await supabase.auth.signUp({ email, password });
    if (up.error) return alert("Sign-up failed: " + up.error.message);
    alert('Account created. In Supabase → Table Editor → profiles, set is_admin=true on your row, then sign in again.');
    return;
  }
  if (error) return alert("Sign-in failed: " + error.message);

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

// ---- First-visit onboarding ----
const ONBOARD_KEY = 'uis_onboard_seen';

function openOnboard(show) {
  if (!els.onboardModal) return;
  els.onboardModal.style.display = show ? 'grid' : 'none';
  if (!show) {
    const v = document.getElementById('onboardVideo');
    if (v) v.pause();
  }
}

function showOnboardIfFirstVisit() {
  if (!localStorage.getItem(ONBOARD_KEY)) openOnboard(true);
}

els.onboardClose?.addEventListener('click', () => {
  if (els.onboardDontShow?.checked) localStorage.setItem(ONBOARD_KEY, '1');
  openOnboard(false);
});

els.onboardStart?.addEventListener('click', () => {
  localStorage.setItem(ONBOARD_KEY, '1');
  openOnboard(false);
});


/* ====== Boot ====== */
// paint UI immediately so it never looks empty
setupFilters();
render();
showOnboardIfFirstVisit();

await refreshAdminFlag();
toggleAuthButtons();
await reload();

// ensure the <select> shows the current state
els.cat.value = state.cat;

// keep footer link safe (HTML already has real href)
if (els.feedbackLink) { els.feedbackLink.target = '_blank'; els.feedbackLink.rel = 'noopener noreferrer'; }
