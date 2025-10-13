/* =========================
   UIS Resource Hub — app.js (with Guidelines enforcement)
   ========================= */

/* ====== Supabase Client ====== */
const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);

/* ====== Session safety (prevents Chrome hanging forever) ====== */
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

/* ====== Auth state ====== */
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

  // NEW: Policy elements
  policyModal: document.getElementById('policyModal'),
  policyClose: document.getElementById('policyClose'),
  openPolicy: document.getElementById('openPolicy'),
  policyFooterLink: document.getElementById('policyFooterLink'),
  policyAgree: document.getElementById('policyAgree'),
};

/* ====== Utils ====== */
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
let tagCache = [];

/* ====== Admin helpers ====== */
async function refreshAdminFlag(){
  if (!session) { isAdmin = false; return; }
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', session.user.id)
    .single();
  if (error) { console.warn(error); isAdmin = false; return; }
  isAdmin = !!data?.is_admin;
}
async function ensureProfile(){
  if (!session) return;
  const { user } = session;
  const { data, error } = await supabase
    .from('profiles').select('id').eq('id', user.id).single();
  if (error && error.code !== 'PGRST116') console.warn(error);
  if (!data) {
    await supabase.from('profiles').insert({
      id: user.id,
      full_name: user.user_metadata?.name || '',
      email: user.email
    });
  }
}
function toggleAuthButtons(){
  const logged = !!session;
  els.adminLogin.style.display = logged ? 'none' : '';
  els.logoutBtn.style.display  = logged ? '' : 'none';
}

/* ====== Setup filters ====== */
function setupFilters(){
  fillSelect(els.cat, CATS.map(c=>({label:c.name, value:c.id})));
  fillSelect(els.sub, [{label:'Any subcategory', value:''}]);
  fillSelect(els.tag, [{label:'Any tag', value:''}]);
  fillSelect(els.catI, CATS.filter(c=>c.id!=='all').map(c=>({label:c.name, value:c.id})));
}

/* ====== DB fetch (simple + robust) ====== */
async function fetchResources(){
  // Pull all (ordered); RLS hides unapproved for non-admins if your policies enforce that
  const { data, error } = await supabase
    .from('resources')
    .select('id,user_id,title,url,category,subcategory,tags,description,votes,approved,created_at')
    .order('votes', { ascending:false })
    .order('title', { ascending:true });
  if (error) { console.error(error); return []; }

  const list = (data||[])
    .filter(r => isAdmin || r.approved === true)
    .map(r => ({
      id:r.id, user_id:r.user_id || null, title:r.title, url:r.url,
      category:r.category, sub:r.subcategory||'',
      tags:r.tags||[], description:r.description||'',
      votes:r.votes||0
    }));
  return list;
}

/* ====== Render helpers ====== */
function computeTags(){ return tagCache; }
function filtered(){
  let list=[...items];
  if(state.cat!=='all') list=list.filter(r=> r.category===state.cat);
  if(state.sub) list=list.filter(r=> r.sub===state.sub);
  if(state.tag) list=list.filter(r=> (r.tags||[]).includes(state.tag));
  if(state.q){
    const q=state.q.toLowerCase();
    list=list.filter(r=>
      r.title.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      (r.tags||[]).some(t=> t.toLowerCase().includes(q)) ||
      r.url.toLowerCase().includes(q)
    );
  }
  list.sort((a,b)=> (b.votes-a.votes) || a.title.localeCompare(b.title));
  return list;
}

/* ====== Render ====== */
function render(){
  toggleAuthButtons();

  // sub options per category
  const catObj=CATS.find(c=> c.id===state.cat);
  const subOpts=[{label:'Any subcategory',value:''}, ...(catObj?.subs||[]).map(s=>({label:s,value:s}))];
  fillSelect(els.sub, subOpts); els.sub.value = state.sub;

  // tag options
  fillSelect(els.tag, [{label:'Any tag',value:''}, ...computeTags().map(t=>({label:'#'+t,value:t}))]);
  els.tag.value = state.tag;

  // chips
  els.chips.innerHTML='';
  CATS.forEach(c=>{
    const b=document.createElement('button'); b.textContent=c.name; b.className='badge';
    if(state.cat===c.id) b.style.outline='2px solid var(--brand)';
    b.onclick=()=>{ state.cat=c.id; state.sub=''; state.page=1; els.cat.value=c.id; render(); };
    els.chips.append(b);
  });

  const list=filtered();
  els.count.textContent = `${list.length} result${list.length!==1?'s':''} • sorted by votes`;
  els.empty.style.display = list.length ? 'none' : '';

  // cards
  els.list.innerHTML='';
  const start=(state.page-1)*state.pageSize;
  list.slice(start,start+state.pageSize).forEach(r=>{
    const card=document.createElement('article'); card.className='card';

    const top=document.createElement('div'); top.className='row';
    const title=document.createElement('a'); title.href=r.url; title.target='_blank'; title.rel='noopener'; title.className='link'; title.textContent=r.title;
    top.append(title);

    // admin-only delete button (UI)
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
      r.tags.forEach(t=>{ const chip=document.createElement('span'); chip.className='badge'; chip.textContent='#'+t; chip.onclick=()=>{ state.tag=t; render(); }; tagWrap.append(chip); });
      card.append(tagWrap);
    }

    const foot=document.createElement('div'); foot.className='footer';
    const open=document.createElement('a'); open.href=r.url; open.target='_blank'; open.rel='noopener'; open.className='badge'; open.textContent='Open link ↗';
    foot.append(open); card.append(foot);

    els.list.append(card);
  });

  // pager
  const pages=Math.max(1, Math.ceil(list.length/state.pageSize));
  els.pager.innerHTML='';
  if(pages>1){
    const prev=document.createElement('button'); prev.textContent='‹ Prev';
    prev.onclick=()=>{ state.page=Math.max(1,state.page-1); render(); };
    const info=document.createElement('span'); info.className='muted small'; info.textContent=`Page ${state.page} / ${pages}`;
    const next=document.createElement('button'); next.textContent='Next ›';
    next.onclick=()=>{ state.page=Math.min(pages,state.page+1); render(); };
    els.pager.append(prev,info,next);
  }
}

/* ====== Reload ====== */
async function reload(){
  items = await fetchResources();
  const s = new Set(); items.forEach(r => (r.tags||[]).forEach(t => s.add(t)));
  tagCache = Array.from(s).sort();
  render();
}

/* ====== Events ====== */
function openModal(show){ els.modal.style.display = show ? 'grid' : 'none'; if (show) setTimeout(()=> els.titleI?.focus(),0); }
els.addBtn.onclick = ()=> openModal(true);
els.cancel.onclick = ()=> openModal(false);
els.q.oninput = debounce(e=>{ state.q=e.target.value; state.page=1; render(); }, 150);
els.cat.onchange = e=>{ state.cat=e.target.value; state.sub=''; state.page=1; render(); };
els.sub.onchange = e=>{ state.sub=e.target.value; state.page=1; render(); };
els.tag.onchange = e=>{ state.tag=e.target.value; state.page=1; render(); };

/* ====== Save (with policy enforcement) ====== */
els.save.onclick = async () => {
  const title=els.titleI.value.trim();
  const url=els.urlI.value.trim();
  const category=els.catI.value;
  const subRaw=els.subI.value.trim();
  const tags=els.tagsI.value.split(',').map(s=>s.trim()).filter(Boolean);
  const description=els.descI.value.trim();

  if(!title || !url || !category) return alert('Please fill title, URL, and category.');
  if(!/^https?:\/\//i.test(url)) return alert('URL must start with http:// or https://');

  // NEW: enforce policy agreement
  if (!els.policyAgree?.checked) {
    return alert('Please confirm your submission follows the School Resource Guidelines.');
  }

  const subNorm = (category==='courses') ? subRaw.toUpperCase() : subRaw;

  const { error } = await supabase.from('resources').insert({
    user_id: session?.user?.id || null,
    title, url, category,
    subcategory: subNorm, tags, description
  });
  if (error) return alert(error.message);

  els.titleI.value = els.urlI.value = els.subI.value = els.tagsI.value = els.descI.value = '';
  els.policyAgree.checked = false;
  openModal(false);
  await reload();
};

/* ====== Policy modal wiring ====== */
function openPolicy(show){ if (!els.policyModal) return; els.policyModal.style.display = show ? 'grid' : 'none'; }
els.openPolicy?.addEventListener('click', (e)=>{ e.preventDefault(); openPolicy(true); });
els.policyFooterLink?.addEventListener('click', (e)=>{ e.preventDefault(); openPolicy(true); });
els.policyClose?.addEventListener('click', ()=> openPolicy(false));

/* ====== Admin auth (email/password) ====== */
els.adminLogin.onclick = async () => {
  const email = prompt('Admin email:'); if (!email) return;
  const password = prompt('Admin password:'); if (!password) return;

  // Try sign-in first
  let { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error && error.status === 400) {
    // If not existing, create account (then set is_admin=true in Table Editor)
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

/* ====== Boot ====== */
setupFilters();
await refreshAdminFlag();
toggleAuthButtons();
await reload();

// Feedback link → your Google Form
els.feedbackLink?.addEventListener('click', (e) => {
  e.preventDefault();
  window.open('https://docs.google.com/forms/d/e/1FAIpQLSe-pZFxPiXsyy53qCLOuN82-9gplif_TpVXt_VF877b2G9W3w/viewform?usp=sharing&ouid=107599033470817781782', '_blank', 'noopener');
});
