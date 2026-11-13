(function(){
"use strict";

/* ---------- tiny DOM helper (no innerHTML: user text is always escaped) ---------- */
function h(tag, props, ...kids){
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(props||{})){
    if (v==null || v===false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k==='class') e.className = v;
    else if (k==='value') e.value = v;
    else if (k==='checked'||k==='selected'||k==='disabled') e[k] = !!v;
    else e.setAttribute(k, v);
  }
  kids.flat(Infinity).forEach(c => { if (c==null||c===false) return; e.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return e;
}
const $ = s => document.querySelector(s);

/* ---------- state ---------- */
const S = {
  db:null, user:null, uid:null, isCEO:false, canWrite:false,
  wrestlers:{}, events:{}, champs:[], loadedW:false, loadedE:false, failed:false, editing:false, draft:null
};

const pleLogo=i=>'img/ple/ple-'+String(i+1).padStart(2,'0')+'.webp';
const pleIdx=e=>(e&&e.ple&&e.date)?Number(e.date.slice(5,7))-1:-1;
const evImg=(e,cls)=>{ if(!e) return null; const i=pleIdx(e); return i>=0?pleImg(i,cls,e.title):h('img',{class:cls+' mayhem-logo',src:'img/mayhem.webp',alt:e.title||'Monday Night Mayhem',loading:'lazy'}); };
const pleImg=(i,cls,name)=>(i>=0&&i<12)?h('img',{class:cls,src:pleLogo(i),alt:name||'',loading:'lazy'}):null;
const PLE_MONTHS = [
  ['January',"New Year's Ball"],['February',"St. Valentine's Day Massacre"],['March','March Madness'],['April','Rage in the Cage'],
  ['May','Memphis in May'],['June','Summer Spectacular'],['July','Beach Bash'],['August','Clash of the Titans'],
  ['September','Annihilation'],['October','Halloween Horror'],['November','Rumble in the Jungle'],['December','Holiday Havoc']
];
const CUES = [['','No sound'],['bell','Bell'],['crowd_pop','Crowd pop'],['crowd_boo','Crowd boos'],['crowd_chant','Crowd chant'],['mat_slam','Slam on the mat'],['pin_count','Pin count'],['chair_shot','Chair shot'],['entrance','Entrance theme…']];
const LENGTHS = [[1,'Short · 1 min'],[3,'Medium · 3 min'],[6,'Long · 6 min'],[10,'Epic · 10 min']];
const WORDS_PER_MIN = 150;
const defLength = type => type==='match'?6:3;
const wordCount = t => (String(t||'').trim().match(/\S+/g)||[]).length;
const SEG_TYPES = {match:'Match', promo:'Promo / Interview', backstage:'Backstage Segment', angle:'Angle / Brawl', ceremony:'Ceremony / Announcement', other:'Other'};
const MOVE_CATS = [
  ['strikes','Strikes & Kicks'],
  ['grapples','Slams, Suplexes & Power Moves'],
  ['submissions','Submissions'],
  ['aerial','High-Flying & Aerial'],
  ['signature','Signature Moves & Taunts']
];

/* ---------- utils ---------- */
function toast(msg, err){
  const t = h('div',{class:'toast'+(err?' err':'')}, msg);
  document.body.append(t); setTimeout(()=>t.remove(), 3500);
}
function todayISO(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function nextMonday(){
  const d=new Date(); const add=(8-d.getDay())%7 || 7; // always a future Monday; today if Monday? use next
  const base = d.getDay()===1 ? 0 : add;
  d.setDate(d.getDate()+base);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function fmtDate(iso){ if(!iso) return 'Date TBA'; const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
function fmtTime(t){ if(!t) return ''; const [hh,mm]=t.split(':').map(Number); const ap=hh>=12?'PM':'AM'; return ((hh%12)||12)+':'+String(mm).padStart(2,'0')+' '+ap; }
function uid8(){ return 'x'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); }
function lines(s){ return String(s||'').split('\n').map(x=>x.trim()).filter(Boolean); }
function wname(id){ const w=S.wrestlers[id]; return w ? w.ringName : 'Unknown Wrestler'; }
function canEditW(id){ return S.isCEO || (S.canWrite && id===S.uid); }
function upcomingEvents(ple){
  const t=todayISO();
  return Object.entries(S.events).map(([id,e])=>({id,...e}))
    .filter(e=>e.published && (e.date||'')>=t && (ple===undefined || !!e.ple===ple))
    .sort((a,b)=>(a.date+(a.time||'')).localeCompare(b.date+(b.time||'')));
}
function modal(title, body, actions){
  const bg=h('div',{class:'modal-bg',onclick:e=>{if(e.target===bg)close();}},
    h('div',{class:'modal'}, h('h3',{},title), h('div',{},body), h('div',{class:'row',style:'margin-top:18px;justify-content:flex-end'}, actions(close))));
  function close(){ bg.remove(); }
  $('#overlay').append(bg);
}
function confirmDlg(title, text, label, fn){
  modal(title, text, close=>[
    h('button',{class:'btn alt sm',onclick:close},'Cancel'),
    h('button',{class:'btn danger sm',onclick:async()=>{close(); await fn();}},label)
  ]);
}
async function safe(fn, okMsg){
  try{ await fn(); if(okMsg) toast(okMsg); return true; }
  catch(e){
    if (e && e.status===401){ clearAuth(); renderNav(route()); }
    toast((e && e.message) || 'Something went wrong.', true);
    return false;
  }
}

/* ---------- routing ---------- */
function route(){
  const raw=(location.hash||'#home').slice(1)||'home';
  const m=raw.match(/^(wrestler|event|watch|edit|ceo-edit|reset|verify)-(.+)$/);
  if (m) return {name:m[1], id:m[2]};
  return {name:raw};
}
function navTo(hash){ if(location.hash==='#'+hash) render(); else location.hash=hash; }

function renderNav(r){
  const nav=$('#nav'); nav.replaceChildren();
  const items=[['home','Home'],['mayhem','Mayhem'],['superstars','Superstars'],['ples','PLE Calendar']];
  if (S.user) items.push(['my-wrestler', S.wrestlers[S.uid] ? 'My Wrestler' : 'Create Wrestler']);
  if (S.isCEO) items.push(['ceo','CEO Office']);
  const active = r.name==='wrestler'?'superstars': (r.name==='event'||r.name==='watch')?((S.events[r.id]&&S.events[r.id].ple)?'ples':'mayhem'): (r.name==='ceo-new-event'||r.name==='ceo-edit')?'ceo': (r.name==='edit'&&r.id===S.uid)?'my-wrestler': r.name;
  items.forEach(([k,l])=>nav.append(h('a',{href:'#'+k,class:active===k?'on':''},l)));
  if (S.user) nav.append(h('a',{href:'#home',onclick:e=>{e.preventDefault();doLogout();}},'Log out'));
  else { nav.append(h('a',{href:'#login',class:active==='login'?'on':''},'Log in')); nav.append(h('a',{href:'#register',class:active==='register'?'on':''},'Sign up')); }
}

/* ---------- pages ---------- */
function pageHome(){
  const next=upcomingEvents(false)[0];
  const nextPle=upcomingEvents(true)[0];
  const me=S.wrestlers[S.uid];
  const wrap=h('div',{});
  wrap.append(h('div',{class:'hero'},
    h('div',{class:'cond',style:'color:var(--star);font-weight:700;font-size:15px'},'Live every Monday night'),
    h('img',{class:'hero-logo',src:'img/uscw-logo.webp',alt:'USCW – United States Championship Wrestling'}),
    h('h1',{class:'sr-only'},'United States Championship Wrestling'),
    h('p',{},'Create your wrestler. Build your legend. Step through the curtain on Monday Night Mayhem.'),
    h('div',{class:'row c'},
      h('a',{class:'btn',href:S.user?'#my-wrestler':'#register'}, S.user?(me?'Edit My Wrestler':'Create Your Wrestler'):'Join USCW'),
      h('a',{class:'btn alt',href:'#superstars'},'Meet the Superstars'),
      h('a',{class:'btn alt',href:'#mayhem'},'Monday Night Mayhem'))));
  wrap.append(h('div',{class:'sect'},
    h('div',{class:'sect-h'},h('h2',{},'Next Monday Night Mayhem')),
    next ? eventTeaser(next) : h('div',{class:'empty'},'No show has been announced yet. Check back soon.')));
  if (nextPle) wrap.append(h('div',{class:'sect'},
    h('div',{class:'sect-h'},h('h2',{},'Next Premium Live Event'),h('div',{class:'sp'}),h('a',{href:'#ples',class:'cond'},'PLE calendar →')),
    eventTeaser(nextPle)));
  const champs=S.champs.filter(c=>c.holders.some(id=>S.wrestlers[id]));
  if (champs.length) wrap.append(h('div',{class:'sect'},
    h('div',{class:'sect-h'},h('h2',{},'Reigning Champions'),h('div',{class:'sp'}),h('a',{href:'#superstars',class:'cond'},'All titles →')),
    champs.map(c=>champCard(c,true))));
  const ws=Object.entries(S.wrestlers).map(([id,w])=>({id,...w}));
  if (ws.length){
    wrap.append(h('div',{class:'sect'},
      h('div',{class:'sect-h'},h('h2',{},'Superstars'),h('div',{class:'sp'}),h('a',{href:'#superstars',class:'cond'},'All superstars →')),
      h('div',{class:'tiles'}, ws.slice(0,6).map(superTile))));
  }
  return wrap;
}
function eventTeaser(e){
  const matches=(e.segments||[]).filter(s=>s.type==='match');
  return h('a',{href:'#event-'+e.id,class:'card',style:'display:block;text-decoration:none'},
    h('div',{class:'teaser'},
      evImg(e,'teaser-logo'),
      h('div',{},
        e.ple?h('span',{class:'tag red',style:'margin-bottom:6px'},'Premium Live Event'):null,
        h('h2',{style:'font-size:38px'},e.title||'Monday Night Mayhem'),
        h('div',{class:'cond',style:'color:var(--blue);font-size:18px'},fmtDate(e.date)+(e.time?' · '+fmtTime(e.time)+(e.tz?' '+e.tz:''):'')),
        h('div',{style:'color:var(--muted)'},[e.venue,e.city].filter(Boolean).join(' — ')),
        matches.length ? h('div',{style:'margin-top:10px;color:var(--text)'}, matches.length+' match'+(matches.length>1?'es':'')+' announced · see the full card →') : null)));
}

function superTile(w){
  const isChamp=champsOf(w.id).length>0;
  const bg=h('div',{class:'tile-bg'});
  if(w.image) bg.style.backgroundImage='url("'+String(w.image).replace(/"/g,'%22')+'")';
  return h('a',{href:'#wrestler-'+w.id,class:'tile '+(w.alignment||'Tweener')},
    bg,
    isChamp?h('span',{class:'tile-champ'},'★ Champion'):null,
    h('div',{class:'tile-txt'},
      h('div',{class:'tile-name'},w.ringName),
      w.nickname?h('div',{class:'tile-nick'},'“'+w.nickname+'”'):null));
}

// A small wrestler card, used as the header over each match.
function miniCard(id){
  const w=S.wrestlers[id];
  if(!w) return h('div',{class:'tile mini Tweener unknown'},h('div',{class:'tile-bg'}),h('div',{class:'tile-txt'},h('div',{class:'tile-name'},'TBA')));
  const bg=h('div',{class:'tile-bg'});
  if(w.image) bg.style.backgroundImage='url("'+String(w.image).replace(/"/g,'%22')+'")';
  return h('a',{href:'#wrestler-'+id,class:'tile mini '+(w.alignment||'Tweener'),title:w.ringName},
    bg,
    champsOf(id).length?h('span',{class:'tile-champ'},'★ Champ'):null,
    h('div',{class:'tile-txt'},h('div',{class:'tile-name'},w.ringName)));
}
// anim = {k} plays the live-show entrance (cards slam in one by one, then VS); k scales the timing (1 = normal speed).
const CARD_GAP=0.33;
function matchHeader(sides,anim){
  const real=(sides||[]).filter(x=>x&&x.length);
  if(!real.length) return null;
  const out=[]; let n=0;
  const k=anim?anim.k:1;
  real.forEach((side,i)=>{
    const cards=side.map(miniCard);
    if(anim) cards.forEach(c=>{ c.style.animationDelay=(n++*CARD_GAP*k).toFixed(2)+'s'; });
    if(i>0){ const vs=h('div',{class:'mh-vs'},'VS'); if(anim) vs.style.animationDelay=(((n-side.length)*CARD_GAP+0.1)*k).toFixed(2)+'s'; out.push(vs); }
    out.push(h('div',{class:'mh-side'+(anim?' from-'+(i===0?'l':i===1?'r':'b'):'')},cards));
  });
  const el=h('div',{class:'mh'+(anim?' anim':'')},out);
  if(anim){ el.style.setProperty('--k',k); el._cards=n; }
  return el;
}

function pageSuperstars(){
  const wrap=h('div',{});
  const ws=Object.entries(S.wrestlers).map(([id,w])=>({id,...w})).sort((a,b)=>a.ringName.localeCompare(b.ringName));
  wrap.append(h('div',{class:'sect-h'},h('h2',{},'Champions')));
  if(!S.champs.length) wrap.append(h('div',{class:'empty'},'The championships haven’t been set up yet.'));
  S.champs.forEach(c=>wrap.append(champCard(c)));
  wrap.append(h('div',{class:'sect-h',style:'margin-top:30px'},h('h2',{},'Superstars'),h('span',{class:'cond',style:'color:var(--muted)'},ws.length+' competitor'+(ws.length===1?'':'s'))));
  let q='', f='All';
  const chips=h('div',{class:'chips'});
  const gridBox=h('div',{class:'tiles'});
  const emptyBox=h('div',{class:'empty'}, ws.length?'No superstars match your search.':'The locker room is empty. Be the first to sign a contract!');
  function draw(){
    chips.replaceChildren();
    ['All','Face','Heel','Tweener','Champions'].forEach(k=>chips.append(h('button',{type:'button',class:'fchip'+(f===k?' on':''),onclick:()=>{f=k;draw();}},k)));
    const list=ws.filter(w=>(f==='All'||(f==='Champions'?champsOf(w.id).length>0:w.alignment===f))&&(!q||(w.ringName+' '+(w.nickname||'')+' '+(w.hometown||'')).toLowerCase().includes(q)));
    gridBox.replaceChildren(); emptyBox.remove();
    if(list.length){ gridBox.style.display=''; list.forEach(w=>gridBox.append(superTile(w))); }
    else { gridBox.style.display='none'; gridBox.after(emptyBox); }
  }
  wrap.append(h('div',{class:'row',style:'margin-bottom:14px'},
    h('input',{type:'text',placeholder:'Search name, nickname or hometown…',style:'max-width:340px',oninput:e=>{q=e.target.value.toLowerCase();draw();}}),
    chips));
  wrap.append(gridBox); draw();
  return wrap;
}

function pageWrestler(id){
  const w=S.wrestlers[id];
  if(!w) return h('div',{class:'empty'},'That wrestler could not be found. ',h('a',{href:'#superstars',style:'color:var(--red2)'},'Back to the superstars'));
  const wrap=h('div',{});
  wrap.append(h('div',{class:'row',style:'margin-bottom:14px'},
    h('a',{href:'#superstars',class:'cond',style:'color:var(--muted)'},'← Superstars'),
    h('div',{style:'flex:1'}),
    canEditW(id)?h('a',{class:'btn sm',href:'#edit-'+id},'Edit'):null,
    S.isCEO?h('button',{class:'btn danger sm',onclick:()=>confirmDlg('Release '+w.ringName+'?','This permanently removes the wrestler from the roster.','Release',()=>safe(async()=>{await S.db.doc('wrestlers/'+id).delete(); navTo('superstars');},'Wrestler released.'))},'Release'):null));
  const al=w.alignment||'Tweener';
  const bg=h('div',{class:'tile-bg'});
  if(w.image) bg.style.backgroundImage='url("'+String(w.image).replace(/"/g,'%22')+'")';
  const belts=champsOf(id);
  const mv=w.moves||{};
  const cats=MOVE_CATS.filter(([k])=>(mv[k]||[]).length);
  const priv=(canEditW(id))&&(w.realName||cats.length);
  const card=h('div',{class:'wp '+al},
    h('div',{class:'wp-top'},
      h('div',{class:'tile wp-portrait '+al},bg),
      h('div',{class:'wp-head'},
        h('div',{class:'wp-tags'},
          w.alignment?h('span',{class:'tag '+w.alignment},w.alignment):null,
          w.style?h('span',{class:'tag'},w.style):null,
          belts.map(c=>h('span',{class:'tag red'},'★ '+c.name.replace(/ Championship$/,' Champion')))),
        h('h1',{class:'wp-name'},w.ringName),
        w.nickname?h('div',{class:'wp-nick'},'“'+w.nickname+'”'):null,
        h('div',{class:'stats'},
          stat('Hometown',w.hometown), stat('Height',w.height), stat('Weight',w.weight?w.weight+' lbs':''),
          stat('Age',w.age), stat('Entrance theme',w.theme)))),
    w.finisher&&w.finisher.name?h('div',{class:'wp-band'},
      h('div',{class:'cond wp-band-l'},'Finishing move'),
      h('div',{class:'wp-fin'},w.finisher.name),
      w.finisher.desc?h('div',{class:'wp-fin-d'},w.finisher.desc):null):null,
    w.bio?h('div',{class:'wp-body'},h('h2',{},'Biography'),h('div',{class:'bio'},w.bio)):null,
    priv?h('div',{class:'wp-private'},
      h('div',{class:'cond wp-priv-h'},S.isCEO?'CEO only — hidden from the public':'Only you and the CEO can see this'),
      w.realName?h('div',{class:'stats',style:'margin-top:0'},stat('Real name',w.realName)):null,
      cats.length?h('div',{class:'moves',style:'margin-top:12px'},cats.map(([k,l])=>h('div',{class:'card'},h('h3',{},l),h('ul',{},mv[k].map(m=>h('li',{},m)))))):null):null);
  wrap.append(card);
  return wrap;
}
function stat(l,v){ return v?h('div',{class:'stat'},h('small',{},l),h('span',{},v)):null; }

/* ----- wrestler editor ----- */
const REQ_TEXT=[['ringName','Ring name'],['nickname','Nickname'],['realName','Your name'],['hometown','Hometown'],['height','Height'],['weight','Weight'],['age','Age'],['style','Wrestling style'],['theme','Entrance theme music'],['bio','Biography']];
function missingFields(F){
  const m=[];
  REQ_TEXT.forEach(([k,l])=>{ if(!F[k].value.trim()) m.push([k,l,F[k]]); });
  const wt=F.weight.value.trim(), ag=F.age.value.trim();
  if(wt&&!(/^\d{2,3}$/.test(wt)&&+wt>=50&&+wt<=700)) m.push(['weight','Weight (a number, 50–700)',F.weight]);
  if(ag&&!(/^\d{2}$/.test(ag)&&+ag>=16&&+ag<=99)) m.push(['age','Age (16–99)',F.age]);
  MOVE_CATS.forEach(([k,l])=>{ if(!lines(F['m_'+k].value).length) m.push(['m_'+k,'at least one move under '+l,F['m_'+k]]); });
  if(!F.finName.value.trim()) m.push(['finName','Finisher name',F.finName]);
  if(!F.finDesc.value.trim()) m.push(['finDesc','Finisher description',F.finDesc]);
  return m;
}
function pageEditWrestler(id, isNew){
  if(!S.user) return h('div',{class:'notice'},'Please ',linkTo('#login','log in'),' or ',linkTo('#register','sign up'),' to create a wrestler.');
  if(!isNew && !canEditW(id)) return h('div',{class:'empty'},'You can only edit your own wrestler.');
  const w=Object.assign({alignment:'Face'}, S.wrestlers[id]||{});
  const mv=w.moves||{}, fin=w.finisher||{};
  const F={};
  const inp=(k,label,ph,type)=>h('div',{class:'f'},h('label',{class:'l'},label),F[k]=h('input',{type:type||'text',value:w[k]||'',placeholder:ph||'',maxlength:'120'}));
  const form=h('form',{onsubmit:async e=>{
    e.preventDefault();
    const miss=missingFields(F);
    if(miss.length){ toast('Please complete: '+miss.map(m=>m[1]).join(', ')+'.',true); miss[0][2].focus(); miss[0][2].scrollIntoView({block:'center'}); return; }
    const ringName=F.ringName.value.trim();
    const moves={}; MOVE_CATS.forEach(([k])=>moves[k]=lines(F['m_'+k].value));
    const data={
      ringName, nickname:F.nickname.value.trim(), realName:F.realName.value.trim(), age:F.age.value.trim(),
      hometown:F.hometown.value.trim(), height:F.height.value.trim(), weight:F.weight.value.trim(),
      alignment:F.alignment.value, style:F.style.value.trim(), theme:F.theme.value.trim(), bio:F.bio.value.trim(),
      moves, finisher:{name:F.finName.value.trim(), desc:F.finDesc.value.trim()},
      owner: (S.wrestlers[id]&&S.wrestlers[id].owner) || (isNew&&S.isCEO&&id!==S.uid ? null : S.uid),
      updatedAt:Date.now()
    };
    const ok=await safe(()=>S.db.doc('wrestlers/'+id).set(data),'Wrestler saved!');
    if(ok){ S.editing=false; navTo('wrestler-'+id); }
  }},
    h('div',{class:'cols'},
      inp('ringName','Ring name *','e.g. Marcus “Iron” Hale'),
      inp('nickname','Nickname *','e.g. The Pride of Pittsburgh'),
      inp('realName','Your name *','e.g. Jason Adams')),
    h('div',{class:'cols'},
      inp('hometown','Hometown / billed from *','e.g. Pittsburgh, PA'),
      inp('height','Height *','e.g. 6\'3"'),
      inp('weight','Weight (lbs) *','e.g. 245'),
      inp('age','Age *','e.g. 29')),
    h('div',{class:'cols'},
      h('div',{class:'f'},h('label',{class:'l'},'Alignment'),F.alignment=h('select',{},['Face','Heel','Tweener'].map(a=>h('option',{value:a,selected:w.alignment===a},a)))),
      inp('style','Wrestling style *','e.g. Powerhouse, High-flyer, Technician'),
      inp('theme','Entrance theme music *','Song / title')),
    h('div',{class:'f'},h('label',{class:'l'},'Biography *'),F.bio=h('textarea',{style:'min-height:150px',placeholder:'Where did they come from? What drives them? Training, rivalries, gimmick…'},w.bio||'')),
    h('div',{class:'sect-h',style:'margin-top:28px'},h('h2',{},'Move Set')),
    h('div',{class:'hint',style:'margin:-6px 0 12px'},'List one move per line, with at least one in every category. Be as comprehensive as you like — the CEO uses this to book your matches.'),
    h('div',{class:'cols'}, MOVE_CATS.map(([k,l])=>h('div',{class:'f'},h('label',{class:'l'},l+' *'),F['m_'+k]=h('textarea',{placeholder:'One move per line'},(mv[k]||[]).join('\n'))))),
    h('div',{class:'sect-h',style:'margin-top:20px'},h('h2',{style:'color:var(--red)'},'Finishing Move')),
    h('div',{class:'cols'},
      h('div',{class:'f'},h('label',{class:'l'},'Finisher name *'),F.finName=h('input',{type:'text',value:fin.name||'',placeholder:'e.g. The Iron Curtain',maxlength:'120'})),
      h('div',{class:'f'},h('label',{class:'l'},'How it looks *'),F.finDesc=h('textarea',{style:'min-height:60px',placeholder:'Describe the move'},fin.desc||''))),
    h('div',{class:'row',style:'margin-top:10px'},
      h('button',{class:'btn',type:'submit'},isNew?'Sign Contract':'Save Wrestler'),
      h('a',{class:'btn alt',href:S.wrestlers[id]?'#wrestler-'+id:'#home',onclick:()=>{S.editing=false;}},'Cancel')));
  S.editing=true;
  return h('div',{},h('div',{class:'sect-h'},h('h2',{},isNew?'Create Your Wrestler':'Edit '+(w.ringName||'Wrestler'))),
    h('div',{class:'card'},
      h('div',{class:'hint',style:'margin-bottom:14px'},'Every field marked * is required to sign your contract.'),
      (!isNew&&S.wrestlers[id]&&legacyMissing(w).length)?h('div',{class:'notice'},'Your profile was created before every field became required. Please complete: '+legacyMissing(w).join(', ')+'.'):null,
      form));
}
function legacyMissing(w){
  const m=[]; const mv=w.moves||{}, fin=w.finisher||{};
  REQ_TEXT.forEach(([k,l])=>{ if(!String(w[k]||'').trim()) m.push(l); });
  MOVE_CATS.forEach(([k,l])=>{ if(!(mv[k]||[]).length) m.push('moves under '+l); });
  if(!fin.name) m.push('Finisher name'); if(!fin.desc) m.push('Finisher description');
  return m;
}

/* ----- event view ----- */
function sidesLine(sides){
  const out=[];
  sides.forEach((side,i)=>{
    if(i>0) out.push(h('i',{},'vs.'));
    side.forEach((id,j)=>{ if(j>0) out.push(h('span',{style:'color:var(--muted)'},' & ')); out.push(S.wrestlers[id]?h('a',{href:'#wrestler-'+id},S.wrestlers[id].ringName):h('span',{style:'color:var(--muted)'},'Unknown')); });
  });
  return out;
}
function pageEvent(e){
  const wrap=h('div',{});
  if(!e) return h('div',{class:'empty'},'Show not found.');
  if(!e.published) wrap.append(h('div',{class:'notice'},'DRAFT — only the CEO can see this. Publish it from the CEO Office to put it on the public schedule.'));
  wrap.append(h('div',{class:'show-banner'},
    evImg(e,'banner-logo'),
    h('div',{class:'cond',style:'color:var(--star);font-weight:700'},'United States Championship Wrestling presents'),
    e.ple?h('div',{style:'margin:6px 0'},h('span',{class:'tag red'},'Premium Live Event')):null,
    h('h1',{},e.title||'Monday Night Mayhem'),
    h('div',{class:'when'},fmtDate(e.date),e.time?[' · ',h('span',{},fmtTime(e.time)+(e.tz?' '+e.tz:''))]:null),
    (e.venue||e.city)?h('div',{style:'color:var(--on-navy);font-size:18px;margin-top:2px'},[e.venue,e.city].filter(Boolean).join(' — ')):null,
    e.notes?h('div',{class:'bio',style:'margin-top:12px;color:#e3e9ff'},e.notes):null));
  if(e.hasScript){
    const live=S.isCEO||(e.releaseAt&&Date.now()>=e.releaseAt);
    wrap.append(h('div',{class:'watch-cta'}, live
      ? [h('a',{class:'btn',href:'#watch-'+e.id},'▶ Watch the show'),h('span',{class:'hint'},'The show’s text unfolds a little at a time. Start whenever you’re ready.')]
      : h('span',{class:'tag navy'},'Live text unlocks at show time')));
  }
  const all=e.segments||[];
  const segs=all.filter(s=>s.type==='match');
  const segLine=(s,i,isMain,hidden)=>h('div',{class:'seg '+s.type},
      s.type==='match'?matchHeader(s.sides):null,
      h('div',{class:'seg-h'},
        h('span',{class:'tag '+(s.type==='match'?'navy':'')},SEG_TYPES[s.type]||'Segment'),
        isMain?h('span',{class:'tag red'},'Main Event'):null,
        hidden?h('span',{class:'tag draft'},'Hidden from public'):null,
        s.stip?h('span',{class:'tag'},s.stip):null),
      s.title?h('div',{class:'cond',style:'font-size:20px;font-weight:600;color:var(--blue)'},s.title):null,
      s.type!=='match'&&(s.sides||[]).some(x=>x.length)?h('div',{class:'vs'},sidesLine([(s.sides||[]).flat()])):null,
      s.desc?h('div',{class:'bio',style:'color:var(--text);margin-top:4px'},s.desc):null);
  wrap.append(h('div',{class:'sect-h'},h('h2',{},'The Card')));
  if(!segs.length) wrap.append(h('div',{class:'empty'},'The card has not been announced yet.'));
  segs.forEach((s,i)=>wrap.append(segLine(s,i,i===segs.length-1&&segs.length>1,false)));
  if(S.isCEO && all.length){
    const lastMatch=all.reduce((a,s,i)=>s.type==='match'?i:a,-1), mc=segs.length;
    wrap.append(h('div',{class:'sect-h',style:'margin-top:30px'},h('h2',{},'CEO Run Sheet')));
    wrap.append(h('div',{class:'hint',style:'margin:-6px 0 12px'},'Full show order, visible only to you. Promos, backstage scenes and other non-match segments stay hidden from everyone else.'));
    all.forEach((s,i)=>wrap.append(segLine(s,i,i===lastMatch&&mc>1,s.type!=='match')));
  }
  return wrap;
}
function pageMayhem(){
  const up=upcomingEvents(false);
  if(!up.length) return h('div',{},h('div',{class:'sect-h'},h('h2',{},'Monday Night Mayhem')),h('div',{class:'empty'},'No upcoming show has been announced yet. The CEO is working on the card!'));
  const wrap=h('div',{}, pageEvent(up[0]));
  if(up.length>1) wrap.append(h('div',{class:'sect'},h('div',{class:'sect-h'},h('h2',{},'Later Shows')),
    h('div',{class:'grid'},up.slice(1).map(eventTeaser))));
  return wrap;
}

/* ----- watching a show: text revealed a little at a time ----- */
function pageWatch(id){
  const e=S.events[id];
  if(!e||!(e.published||S.isCEO)) return h('div',{class:'empty'},'Show not found.');
  const wrap=h('div',{class:'watch'});
  const KEY='uscw_view_'+id;
  const loadSaved=()=>{ try{ return JSON.parse(localStorage.getItem(KEY)||'null'); }catch(_){ return null; } };
  const saveView=o=>{ try{ localStorage.setItem(KEY,JSON.stringify(o)); }catch(_){} };
  const clearView=()=>{ try{ localStorage.removeItem(KEY); }catch(_){} };
  const timers=new Set(); let stopped=false;
  const later=(fn,ms)=>{ const t=setTimeout(()=>{ timers.delete(t); if(!stopped) fn(); },ms); timers.add(t); return t; };
  S.stopWatch=()=>{ stopped=true; timers.forEach(t=>{clearTimeout(t);clearInterval(t);}); timers.clear(); };
  const wc=t=>(String(t||'').trim().match(/\S+/g)||[]).length;

  function startScreen(msg){
    wrap.replaceChildren();
    const sv=loadSaved();
    const notLive=!S.isCEO&&e.releaseAt&&Date.now()<e.releaseAt;
    const speedSel=S.isCEO?h('select',{style:'width:auto'},[[1,'Normal speed'],[4,'CEO preview ×4'],[8,'CEO preview ×8'],[16,'CEO preview ×16']].map(([v,l])=>h('option',{value:v},l))):null;
    wrap.append(h('div',{class:'watch-start'},
      evImg(e,'banner-logo'),
      h('h2',{},e.title||'Monday Night Mayhem'),
      msg?h('div',{class:'notice'},msg):null,
      notLive
        ? h('p',{},'This show goes live '+new Date(e.releaseAt).toLocaleString(undefined,{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'})+'. Come back then!')
        : [h('p',{},'The show unfolds a little at a time, just as it happens. Get comfortable and press start.'),
           h('div',{class:'row c'},
             sv?h('button',{class:'btn',onclick:()=>begin(sv)},'▶ Resume the show'):null,
             h('button',{class:sv?'btn alt':'btn',onclick:()=>begin(null)},sv?'Start over':'▶ Start the show'),
             speedSel)],
      h('div',{style:'margin-top:14px'},h('a',{href:'#event-'+id,class:'cond',style:'color:var(--muted)'},'← Back to the card'))));
    async function begin(resume){
      try{
        let view=resume&&resume.view, shown=resume?resume.shown||0:0, speed=resume?resume.speed||1:1;
        if(!resume){
          const r=await api('POST','/events/'+id+'/watch',{speed:speedSel?Number(speedSel.value):1});
          view=r.view; speed=r.speed; shown=0; saveView({view,shown:0,speed});
        }
        play(view,speed,shown);
      }catch(err){ if(err.code==='notlive') toast(err.message,true); else startScreen(err.message); }
    }
  }

  function play(view,speed,resumeShown){
    wrap.replaceChildren();
    const feed=h('div',{class:'feed'});
    const fill=h('div',{class:'w-fill'});
    const pauseBtn=h('button',{class:'btn alt sm',type:'button',onclick:()=>{
      st.paused=!st.paused; pauseBtn.textContent=st.paused?'▶ Resume':'❚❚ Pause'; if(!st.paused) playNext(); }},'❚❚ Pause');
    wrap.append(h('div',{class:'w-bar'},pauseBtn,h('div',{class:'w-prog'},fill),h('a',{href:'#event-'+id,class:'cond',style:'color:var(--on-navy)'},'Leave')),feed);
    const st={queue:[],received:0,shown:0,total:0,done:false,paused:false,busy:false,finished:false};
    const reduceMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Returns how long (ms) the text should wait so the match entrance can play.
    function segHeader(sg,animate){
      const sides=(sg.sides||[]).filter(x=>x.length);
      const k=1/speed, play=!!animate&&!reduceMotion&&sg.type==='match'&&sides.length>0;
      const mh=sg.type==='match'?matchHeader(sg.sides,play?{k}:null):null;
      const late=(el)=>{ if(play&&el){ el.classList.add('w-late'); el.style.animationDelay=((mh._cards*CARD_GAP+0.45)*k).toFixed(2)+'s'; el.style.setProperty('--k',k); } return el; };
      feed.append(h('div',{class:'w-seg'},
        mh,
        late(h('span',{class:'tag '+(sg.type==='match'?'red':'navy')},SEG_TYPES[sg.type]||'Segment')),
        late(sg.title?h('div',{class:'cond w-title'},sg.title):null),
        late(sg.stip?h('div',{class:'w-stip'},sg.stip):null),
        sg.type!=='match'&&sides.length?h('div',{class:'vs'},sidesLine([sides.flat()])):null));
      return play?Math.round((mh._cards*CARD_GAP+1.4)*1000*k):0;
    }
    function nearBottom(){ return window.innerHeight+window.scrollY>=document.body.scrollHeight-160; }
    function follow(was){ if(was) window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}); }
    function progress(){ fill.style.width=(st.total?Math.min(100,100*st.shown/st.total):0)+'%'; }
    function shownOne(){ st.shown++; saveView({view,shown:st.shown,speed}); progress(); }
    function instant(b){ if(b.seg) segHeader(b.seg); if(b.text) feed.append(h('p',{class:'w-beat'},b.text)); shownOne(); }
    function playNext(){
      if(stopped||st.paused||st.busy||st.finished) return;
      const b=st.queue.shift();
      if(!b){ if(st.done&&st.received>=st.total&&st.shown>=st.total) finish(); return; }
      st.busy=true; const was=nearBottom();
      const hold=b.seg?segHeader(b.seg,true):0;
      if(hold>0) follow(was);
      const runBeat=()=>{
        const was1=nearBottom();
        const p=h('p',{class:'w-beat'}); feed.append(p);
        follow(was1||was);
        const words=(b.text||'').split(/\s+/).filter(Boolean);
        const total=Math.max(1.5,words.length/2.5)*1000/speed;
        let n=0; const step=Math.max(25,total/Math.max(1,words.length));
        const finishBeat=()=>{ shownOne(); later(()=>{ st.busy=false; playNext(); },(b.pause||0)*1000/speed); };
        if(!words.length){ finishBeat(); return; }
        const iv=setInterval(()=>{
          if(stopped){ clearInterval(iv); return; }
          const was2=nearBottom(); n++; p.textContent=words.slice(0,n).join(' '); follow(was2&&n===words.length);
          if(n>=words.length){ clearInterval(iv); timers.delete(iv); finishBeat(); }
        },step); timers.add(iv);
      };
      if(hold>0) later(runBeat,hold); else runBeat();
    }
    function finish(){
      st.finished=true; clearView();
      feed.append(h('div',{class:'w-end'},h('h2',{},'That’s the show!'),
        h('div',{class:'row c'},h('a',{class:'btn',href:'#event-'+id},'Back to the card'),h('button',{class:'btn alt',onclick:()=>startScreen()},'Watch again'))));
      follow(true); pauseBtn.style.display='none';
    }
    async function fetchMore(){
      if(stopped) return;
      try{
        const r=await api('GET','/events/'+id+'/script?view='+view+'&after='+st.received);
        st.total=r.total; st.done=!!r.done;
        r.beats.forEach(b=>{ st.received++; if(resumeShown>0&&st.shown<resumeShown){ instant(b); } else st.queue.push(b); });
        progress(); playNext();
        if(!st.done) later(fetchMore,Math.max(1000,Math.min(15000,((r.nextIn==null?2:r.nextIn)*1000)+300)));
        else playNext();
      }catch(err){
        if(err.code==='noview'){ clearView(); startScreen('That viewing expired. Start the show again.'); return; }
        later(fetchMore,5000);
      }
    }
    fetchMore();
  }
  startScreen();
  return wrap;
}

/* ----- CEO office ----- */
function pageCEO(){
  if(!S.isCEO) return h('div',{class:'empty'},'The CEO Office is for the CEO only.');
  const wrap=h('div',{});
  const evs=Object.entries(S.events).map(([id,e])=>({id,...e})).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  wrap.append(h('div',{class:'sect-h'},h('h2',{},'CEO’s Office'),h('div',{class:'sp'}),h('a',{class:'btn',href:'#ceo-new-event'},'+ New Event')));
  wrap.append(h('div',{class:'cond',style:'color:var(--muted);margin:-6px 0 14px'},'Owner & CEO: Jason Adams'));
  if(!evs.length) wrap.append(h('div',{class:'empty'},'No events yet. Create your first Monday Night Mayhem.'));
  else wrap.append(h('div',{class:'card'},h('table',{class:'table'},
    h('thead',{},h('tr',{},['Show','Date','Venue','Card','Status',''].map(x=>h('th',{},x)))),
    h('tbody',{},evs.map(e=>h('tr',{},
      h('td',{},h('a',{href:'#event-'+e.id,style:'font-weight:600'},e.title||'Untitled'),e.ple?[' ',h('span',{class:'tag red'},'PLE')]:null),
      h('td',{},e.date?fmtDate(e.date).replace(/^\w+, /,''):'—'),
      h('td',{style:'color:var(--muted)'},e.venue||'—'),
      h('td',{},(e.segments||[]).length+' seg. ('+(e.segments||[]).filter(s=>s.type==='match').length+' matches)'),
      h('td',{},e.published?h('span',{class:'tag navy'},'Published'):h('span',{class:'tag draft'},'Draft')),
      h('td',{style:'text-align:right;white-space:nowrap'},
        h('a',{class:'btn alt sm',href:'#ceo-edit-'+e.id},'Edit'),' ',
        h('button',{class:'btn alt sm',onclick:()=>safe(()=>S.db.doc('events/'+e.id).update({published:!e.published}),e.published?'Moved back to draft.':'Published!')},e.published?'Unpublish':'Publish'),' ',
        h('button',{class:'btn danger sm',onclick:()=>confirmDlg('Delete this event?','“'+(e.title||'Untitled')+'” and its whole card will be removed.','Delete',()=>safe(()=>S.db.doc('events/'+e.id).delete(),'Event deleted.'))},'Delete'))))))));
  const ws=Object.entries(S.wrestlers).map(([id,w])=>({id,...w}));
  wrap.append(h('div',{class:'sect'},h('div',{class:'sect-h'},h('h2',{},'Roster Management'),h('div',{class:'sp'}),
    h('a',{class:'btn alt sm',href:'#edit-'+uid8()},'+ Add NPC / Guest Wrestler')),
    ws.length?h('div',{class:'tiles'},ws.map(superTile)):h('div',{class:'empty'},'No wrestlers have signed yet. Share the page with your players!')));
  wrap.append(h('div',{class:'hint',style:'margin-top:24px'},'Tip: to make another user a CEO, set is_admin = 1 on their row in the D1 users table (see the README).'));
  return wrap;
}

/* ----- event editor ----- */
function newEvent(){ return {title:'Monday Night Mayhem', date:nextMonday(), time:'20:00', tz:'ET', venue:'', city:'', notes:'', published:false, segments:[]}; }
function pageEditEvent(id){
  if(!S.isCEO) return h('div',{class:'empty'},'The CEO Office is for the CEO only.');
  if(id && !S.events[id]) return h('div',{class:'empty'},'Event not found.');
  const d=id?JSON.parse(JSON.stringify(S.events[id])):newEvent();
  d.segments=(d.segments||[]).map(s=>({id:s.id||uid8(), type:s.type||'match', title:s.title||'', stip:s.stip||'', desc:s.desc||'', sides:(s.sides&&s.sides.length)?s.sides:[[],[]], length:Number(s.length)>=1?Number(s.length):defLength(s.type||'match'), beats:(s.beats||[]).map(b=>({text:b.text||'',pause:b.pause||0,cue:b.cue||''}))}));
  S.draft=d; S.editing=true;
  const segBox=h('div',{});
  const titleField=field('title','Show title');
  function field(k,label,type,ph){ return h('div',{class:'f'},h('label',{class:'l'},label),h('input',{type:type||'text',value:d[k]||'',placeholder:ph||'',oninput:e=>{d[k]=e.target.value;}})); }
  function drawSegs(){
    segBox.replaceChildren();
    if(!d.segments.length) segBox.append(h('div',{class:'empty'},'No segments yet. Add a match, promo, or backstage scene below.'));
    d.segments.forEach((s,i)=>segBox.append(segEditor(s,i)));
    updateTotal();
  }
  function segEditor(s,i){
    const isMatch=s.type==='match';
    const sidesBox=h('div',{});
    function drawSides(){
      sidesBox.replaceChildren();
      if(!isMatch && s.sides.length>1) s.sides=[s.sides.flat()];
      s.sides.forEach((side,si)=>{
        const picker=h('select',{onchange:e=>{ if(e.target.value){ side.push(e.target.value); drawSides(); } }},
          h('option',{value:''},'+ Add wrestler…'),
          Object.entries(S.wrestlers).filter(([wid])=>!side.includes(wid)).sort((a,b)=>a[1].ringName.localeCompare(b[1].ringName)).map(([wid,w])=>h('option',{value:wid},w.ringName)));
        sidesBox.append(h('div',{class:'side'},
          h('div',{class:'side-h'},h('span',{},isMatch?'Side '+(si+1)+' (add several for a tag team)':'Involved'),
            isMatch&&s.sides.length>2?h('button',{type:'button',class:'btn alt sm',style:'padding:0 8px',onclick:()=>{s.sides.splice(si,1);drawSides();}},'Remove side'):null),
          side.map((wid,k)=>h('span',{class:'chip'},wname(wid),h('button',{type:'button',title:'Remove',onclick:()=>{side.splice(k,1);drawSides();}},'×'))),
          picker));
      });
      if(isMatch) sidesBox.append(h('button',{type:'button',class:'btn alt sm',onclick:()=>{s.sides.push([]);drawSides();}},'+ Add another side (triple threat, fatal 4-way…)'));
    }
    const typeSel=h('select',{onchange:e=>{ s.type=e.target.value; if(s.type!=='match') s.sides=[s.sides.flat()]; else if(s.sides.length<2) s.sides.push([]); drawSegs(); }},
      Object.entries(SEG_TYPES).map(([k,l])=>h('option',{value:k,selected:s.type===k},l)));
    const el=h('div',{class:'seg '+s.type},
      h('div',{class:'row',style:'margin-bottom:10px'},
        h('span',{class:'cond',style:'font-weight:700;color:var(--muted)'},'#'+(i+1)),
        h('div',{style:'width:230px'},typeSel),
        isMatch?null:h('span',{class:'tag draft'},'Hidden from public'),
        h('div',{style:'flex:1'}),
        h('button',{type:'button',class:'btn alt sm',disabled:i===0,onclick:()=>{[d.segments[i-1],d.segments[i]]=[d.segments[i],d.segments[i-1]];drawSegs();}},'↑'),
        h('button',{type:'button',class:'btn alt sm',disabled:i===d.segments.length-1,onclick:()=>{[d.segments[i+1],d.segments[i]]=[d.segments[i],d.segments[i+1]];drawSegs();}},'↓'),
        h('button',{type:'button',class:'btn danger sm',onclick:()=>{d.segments.splice(i,1);drawSegs();}},'Remove')),
      h('div',{class:'cols'},
        h('div',{class:'f'},h('label',{class:'l'},isMatch?'Match title (optional)':'Segment title'),h('input',{type:'text',value:s.title,placeholder:isMatch?'e.g. USCW Championship':'e.g. Contract signing',oninput:e=>{s.title=e.target.value;}})),
        isMatch?h('div',{class:'f'},h('label',{class:'l'},'Stipulation'),h('input',{type:'text',value:s.stip,placeholder:'e.g. Steel Cage, No DQ, 30-min Iron Man',oninput:e=>{s.stip=e.target.value;}})):null),
      sidesBox,
      h('div',{class:'f',style:'margin-top:10px'},h('label',{class:'l'},isMatch?'Notes / storyline':'What happens'),h('textarea',{placeholder:isMatch?'Build-up, rivalry, what\'s at stake…':'Describe the in-ring or backstage event…',oninput:e=>{s.desc=e.target.value;}},s.desc)));
    drawSides();
    // ---- length + script ----
    const isPreset=()=>LENGTHS.some(l=>l[0]===s.length);
    const customIn=h('input',{type:'number',min:'1',max:'30',style:'width:80px',value:s.length,oninput:e=>{ s.length=Math.max(1,Math.min(30,Math.round(Number(e.target.value))||1)); updateScript(); updateTotal(); }});
    const lenSel=h('select',{style:'width:auto',onchange:e=>{
      if(e.target.value==='custom'){ customWrap.style.display=''; }
      else { s.length=Number(e.target.value); customWrap.style.display='none'; customIn.value=s.length; updateScript(); updateTotal(); }
    }}, LENGTHS.map(l=>h('option',{value:l[0],selected:s.length===l[0]},l[1])), h('option',{value:'custom',selected:!isPreset()},'Custom…'));
    const customWrap=h('span',{style:'display:'+(isPreset()?'none':'')},customIn,' minutes');
    const beatsBox=h('div',{});
    const scriptInfo=h('span',{class:'hint'});
    function updateScript(){
      const words=s.beats.reduce((n,b)=>n+wordCount(b.text),0), target=s.length*WORDS_PER_MIN;
      scriptInfo.textContent=s.beats.length+' beat'+(s.beats.length===1?'':'s')+' · '+words+' words · target about '+target+' words for '+s.length+' min';
    }
    function drawBeats(){
      beatsBox.replaceChildren();
      s.beats.forEach((b,bi)=>{
        const cueBase=b.cue.startsWith('entrance:')?'entrance':b.cue;
        const wsel=h('select',{style:'width:auto;display:'+(cueBase==='entrance'?'':'none'),onchange:e=>{ b.cue=e.target.value?'entrance:'+e.target.value:'entrance'; }},
          h('option',{value:''},'— whose entrance? —'),
          Object.entries(S.wrestlers).sort((a,c)=>a[1].ringName.localeCompare(c[1].ringName)).map(([wid,w])=>h('option',{value:wid,selected:b.cue==='entrance:'+wid},w.ringName)));
        const cueSel=h('select',{style:'width:auto',onchange:e=>{ b.cue=e.target.value; wsel.style.display=b.cue==='entrance'?'':'none'; }},
          CUES.map(([k,l])=>h('option',{value:k,selected:cueBase===k},l)));
        beatsBox.append(h('div',{class:'beat'},
          h('div',{class:'row',style:'margin-bottom:6px'},
            h('span',{class:'cond',style:'font-weight:700;color:var(--muted)'},'Beat '+(bi+1)),
            cueSel, wsel,
            h('label',{class:'hint',style:'display:flex;gap:6px;align-items:center'},'Pause after',h('input',{type:'number',min:'0',max:'30',value:b.pause||0,style:'width:64px',oninput:e=>{ b.pause=Math.max(0,Math.min(30,Math.round(Number(e.target.value))||0)); }}),'sec'),
            h('div',{style:'flex:1'}),
            h('button',{type:'button',class:'btn alt sm',disabled:bi===0,onclick:()=>{[s.beats[bi-1],s.beats[bi]]=[s.beats[bi],s.beats[bi-1]];drawBeats();}},'↑'),
            h('button',{type:'button',class:'btn alt sm',disabled:bi===s.beats.length-1,onclick:()=>{[s.beats[bi+1],s.beats[bi]]=[s.beats[bi],s.beats[bi+1]];drawBeats();}},'↓'),
            h('button',{type:'button',class:'btn danger sm',onclick:()=>{s.beats.splice(bi,1);drawBeats();updateScript();}},'×')),
          h('textarea',{maxlength:'1200',placeholder:'A few sentences of the action…',oninput:e=>{ b.text=e.target.value; updateScript(); }},b.text)));
      });
      updateScript();
    }
    drawBeats();
    el.append(h('div',{class:'script'},
      h('div',{class:'row',style:'margin-bottom:8px'},
        h('span',{class:'cond',style:'font-weight:700;color:var(--navy)'},'Length'), lenSel, customWrap,
        h('div',{style:'flex:1'}), scriptInfo),
      h('div',{class:'hint',style:'margin:0 0 8px'},'Script: the text viewers are shown a few beats at a time when they watch the show. Sound cues play when a beat appears.'),
      beatsBox,
      h('button',{type:'button',class:'btn alt sm',onclick:()=>{s.beats.push({text:'',pause:0,cue:''});drawBeats();}},'+ Add beat')));
    return el;
  }
  const totalEl=h('span',{class:'cond',style:'color:var(--muted)'});
  function updateTotal(){ const m=d.segments.reduce((n,x)=>n+(Number(x.length)||0),0); totalEl.textContent='Show length: about '+m+' min'+(m>=60?' ('+Math.floor(m/60)+' h '+(m%60)+' min)':''); }
  drawSegs();
  const addBtns=h('div',{class:'row',style:'margin:10px 0 20px'},
    h('span',{class:'cond',style:'color:var(--muted)'},'Add:'),
    Object.entries(SEG_TYPES).map(([k,l])=>h('button',{type:'button',class:'btn alt sm',onclick:()=>{d.segments.push({id:uid8(),type:k,title:'',stip:'',desc:'',sides:k==='match'?[[],[]]:[[]],length:defLength(k),beats:[]});drawSegs();}},'+ '+l)));
  async function save(publish){
    if(!d.title.trim()){ toast('Give the show a title.',true); return; }
    if(!d.date){ toast('Pick a date for the show.',true); return; }
    const evId=id||('e'+Date.now().toString(36)+Math.random().toString(36).slice(2,5));
    const data={title:d.title.trim(), date:d.date, time:d.time||'', tz:(d.tz||'').trim(), venue:(d.venue||'').trim(), city:(d.city||'').trim(), notes:(d.notes||'').trim(),
      published: publish===null ? !!d.published : publish, ple: !!d.ple,
      segments:d.segments.map(s=>({id:s.id,type:s.type,title:s.title.trim(),stip:s.type==='match'?s.stip.trim():'',desc:s.desc.trim(),sides:s.sides.map(x=>x.filter(w=>S.wrestlers[w])),length:Number(s.length)||defLength(s.type),beats:(s.beats||[]).filter(b=>(b.text||'').trim()||b.cue).map(b=>({text:(b.text||'').trim(),pause:b.pause||0,cue:b.cue||''}))})),
      updatedAt:Date.now()};
    const ok=await safe(()=>S.db.doc('events/'+evId).set(data), publish===true?'Show published!':'Event saved.');
    if(ok){ S.editing=false; navTo(publish===true||data.published?'event-'+evId:'ceo'); }
  }
  return h('div',{},
    h('div',{class:'sect-h'},h('h2',{},id?'Edit Event':'New Event'),h('div',{class:'sp'}),d.published?h('span',{class:'tag navy'},'Published'):h('span',{class:'tag draft'},'Draft')),
    h('div',{class:'card'},h('div',{class:'cols'},
      titleField, field('date','Date','date'), field('time','Start time','time'), field('tz','Time zone','text','ET'),
      field('venue','Venue','text','e.g. Heinz Field Arena'), field('city','City','text','e.g. Pittsburgh, PA')),
      h('div',{class:'f'},h('label',{style:'display:flex;gap:8px;align-items:center;cursor:pointer'},
        h('input',{type:'checkbox',checked:!!d.ple,style:'width:auto',onchange:e=>{
          d.ple=e.target.checked;
          const ti=titleField.querySelector('input');
          if(d.ple && /^Monday Night Mayhem$/.test(d.title||'') && d.date){ const nm=PLE_MONTHS[Number(d.date.slice(5,7))-1]; if(nm){ d.title=nm[1]; ti.value=nm[1]; } }
          if(!d.ple && PLE_MONTHS.some(m=>m[1]===d.title)){ d.title='Monday Night Mayhem'; ti.value=d.title; }
        }}),
        h('span',{},'This is a Premium Live Event (PLE)'))),
      h('div',{class:'f'},h('label',{class:'l'},'Show notes / theme'),h('textarea',{placeholder:'Special announcements, theme of the night, etc.',oninput:e=>{d.notes=e.target.value;}},d.notes||''))),
    h('div',{class:'sect-h',style:'margin-top:26px'},h('h2',{},'Show Card'),h('div',{class:'sp'}),totalEl),
    h('div',{class:'hint',style:'margin:-6px 0 12px'},'Everything in the order it happens. Only matches appear on the public card — promos, interviews, backstage scenes and other segments are CEO-only surprises. The last match is billed as the main event.'),
    segBox, addBtns,
    h('div',{class:'row'},
      h('button',{class:'btn',type:'button',onclick:()=>save(true)},d.published?'Save & Keep Published':'Save & Publish'),
      h('button',{class:'btn alt',type:'button',onclick:()=>save(d.published?null:false)},d.published?'Save Changes':'Save as Draft'),
      h('a',{class:'btn alt',href:'#ceo',onclick:()=>{S.editing=false;}},'Cancel')));
}


/* ----- champions ----- */
function champsOf(id){ return S.champs.filter(c=>c.holders.includes(id)); }
function champCard(c,readOnly){
  const holders=c.holders.filter(id=>S.wrestlers[id]);
  const names = holders.length
    ? h('div',{class:'champ-names'}, holders.map((id,i)=>[i?h('span',{class:'amp'},' & '):null, h('a',{href:'#wrestler-'+id},wname(id))]))
    : h('div',{class:'champ-vacant'},'Vacant');
  const meta=[c.since?'Champion since '+fmtDate(c.since).replace(/^\w+, /,''):'', c.wonAt?'Won at '+c.wonAt:''].filter(Boolean).join(' · ');
  return h('div',{class:'champ'},
    h('div',{class:'belt','aria-hidden':'true'},'★'),
    h('div',{class:'champ-body'},
      h('div',{class:'cond champ-title'},c.name),
      names,
      holders.length&&meta?h('div',{class:'champ-meta'},meta):null,
      S.isCEO&&!readOnly?h('div',{style:'margin-top:10px'},h('button',{class:'btn alt sm',onclick:()=>editChampion(c)},holders.length?'Change champion':'Award title')):null));
}
function editChampion(c){
  const roster=Object.entries(S.wrestlers).map(([id,w])=>({id,name:w.ringName})).sort((a,b)=>a.name.localeCompare(b.name));
  const count=c.kind==='tag'?2:1;
  const sels=[];
  for(let i=0;i<count;i++){
    const cur=c.holders[i]||'';
    sels.push(h('div',{class:'f'},h('label',{class:'l'},count>1?'Champion '+(i+1):'Champion'),
      h('select',{},h('option',{value:''},'— choose a wrestler —'),roster.map(r=>h('option',{value:r.id,selected:cur===r.id},r.name)))));
  }
  const since=h('input',{type:'date',value:c.since||todayISO()});
  const wonAt=h('input',{type:'text',value:c.wonAt||'',placeholder:'e.g. Rumble in the Jungle',maxlength:'100'});
  const body=h('div',{},sels,h('div',{class:'f'},h('label',{class:'l'},'Champion since'),since),h('div',{class:'f'},h('label',{class:'l'},'Won at'),wonAt),
    roster.length?null:h('div',{class:'hint'},'There are no wrestlers on the roster yet.'));
  modal(c.name,body,close=>[
    h('button',{class:'btn alt sm',onclick:close},'Cancel'),
    c.holders.length?h('button',{class:'btn danger sm',onclick:async()=>{ if(await safe(()=>S.db.doc('championships/'+c.id).set({holders:[]}),'Title vacated.')) close(); }},'Vacate'):null,
    h('button',{class:'btn sm',onclick:async()=>{
      const holders=sels.map(s=>s.querySelector('select').value).filter(Boolean);
      if(holders.length===0){ toast('Choose a champion, or use Vacate.',true); return; }
      if(holders.length<count){ toast('A tag team title needs two wrestlers.',true); return; }
      if(new Set(holders).size<holders.length){ toast('Pick two different wrestlers.',true); return; }
      if(await safe(()=>S.db.doc('championships/'+c.id).set({holders,since:since.value,wonAt:wonAt.value}),'Championship updated.')) close();
    }},'Save')
  ]);
}

/* ----- Premium Live Event calendar ----- */
function pagePLE(){
  const today=todayISO(), nowM=new Date().getMonth();
  const booked=Object.entries(S.events).map(([id,e])=>({id,...e}))
    .filter(e=>e.ple && (S.isCEO||e.published) && (e.date||'')>=today)
    .sort((a,b)=>(a.date+(a.time||'')).localeCompare(b.date+(b.time||'')));
  const nextId=booked.filter(e=>e.published)[0]?.id;
  const wrap=h('div',{});
  wrap.append(h('div',{class:'sect-h'},h('h2',{},'Premium Live Event Calendar')));
  wrap.append(h('p',{style:'color:var(--muted);margin:-4px 0 16px'},'One Premium Live Event (PLE) every month.'));
  PLE_MONTHS.forEach(([month,name],i)=>{
    const ev=booked.find(e=>Number((e.date||'').slice(5,7))-1===i);
    const title=ev&&ev.title&&ev.title!==name?ev.title:name;
    wrap.append(h('div',{class:'ple'+(i===nowM?' now':'')},
      h('div',{class:'ple-art'},pleImg(i,'ple-logo',name),h('div',{class:'ple-month cond'},month)),
      h('div',{},
        h('div',{class:'ple-name'},title),
        ev?h('div',{class:'ple-sub'},[fmtDate(ev.date).replace(/^\w+, /,''),ev.time?fmtTime(ev.time)+(ev.tz?' '+ev.tz:''):'',[ev.venue,ev.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ')):h('div',{class:'ple-sub'},'Date and card to be announced'),
        h('div',{style:'margin-top:4px'},
          ev&&ev.id===nextId?h('span',{class:'tag red'},'Next PLE'):null,
          i===nowM&&!(ev&&ev.id===nextId)?h('span',{class:'tag navy'},'This month'):null,
          ev&&!ev.published?[' ',h('span',{class:'tag draft'},'Draft')]:null)),
      ev?h('a',{class:'btn alt sm',href:'#event-'+ev.id},'View card'):h('span',{})));
  });
  return wrap;
}

/* ---------- render ---------- */
function render(keep){
  const r=route();
  S.editing=false;
  if(S.stopWatch){ S.stopWatch(); S.stopWatch=null; }
  renderNav(r);
  const app=$('#app'); app.replaceChildren();
  if(!keep) window.scrollTo(0,0);
  const authPage=['login','register','forgot','reset','verify'].includes(r.name);
  if(!authPage && S.failed && !(S.loadedW&&S.loadedE)){ app.append(h('div',{class:'empty'},'We can’t reach the league data right now. Please try again in a moment.')); return; }
  if(!authPage && !(S.loadedW&&S.loadedE)){ app.append(h('div',{class:'empty'},'Loading the arena…')); return; }
  let el;
  switch(r.name){
    case 'mayhem': el=pageMayhem(); break;
    case 'superstars': el=pageSuperstars(); break;
    case 'ples': el=pagePLE(); break;
    case 'wrestler': el=pageWrestler(r.id); break;
    case 'watch': el=pageWatch(r.id); break;
    case 'event': { const e=S.events[r.id]; el=(e&&(e.published||S.isCEO))?pageEvent(e):pageEvent(null); break; }
    case 'my-wrestler': el=pageEditWrestler(S.uid, !S.wrestlers[S.uid]); break;
    case 'edit': el=pageEditWrestler(r.id, !S.wrestlers[r.id]); break;
    case 'login': el=pageLogin(); break;
    case 'register': el=pageRegister(); break;
    case 'forgot': el=pageForgot(); break;
    case 'reset': el=pageReset(r.id); break;
    case 'verify': el=pageVerify(r.id); break;
    case 'ceo': el=pageCEO(); break;
    case 'ceo-new-event': el=pageEditEvent(null); break;
    case 'ceo-edit': el=pageEditEvent(r.id); break;
    default: el=pageHome();
  }
  app.append(el);
}
// data snapshots re-render, except while a form is open (would wipe typing)
function onData(){ if(S.editing) { renderNav(route()); return; } render(); }

/* ---------- API + auth ---------- */
const TOKEN_KEY = 'uscw_token';
S.token = null; S.sig = '';

async function api(method, path, body){
  let res;
  try{
    res = await fetch(window.USCW_CONFIG.API_BASE + '/api' + path, {
      method,
      headers: Object.assign({}, body ? {'Content-Type':'application/json'} : {}, S.token ? {Authorization:'Bearer '+S.token} : {}),
      body: body ? JSON.stringify(body) : undefined
    });
  }catch(e){
    const err = new Error('Can’t reach the USCW server. Check your connection and try again.'); err.network = true; throw err;
  }
  let data = null; try{ data = await res.json(); }catch(_){}
  if (!res.ok){
    const err = new Error((data && data.error) || ('Request failed ('+res.status+')'));
    err.status = res.status; err.code = data && data.code; throw err;
  }
  return data;
}
function setUser(u){ S.user={id:u.id,email:u.email,isAdmin:!!u.isAdmin}; S.uid=u.id; S.isCEO=!!u.isAdmin; S.canWrite=true; }
function clearAuth(){ S.token=null; S.user=null; S.uid=null; S.isCEO=false; S.canWrite=false; try{localStorage.removeItem(TOKEN_KEY);}catch(e){} }
async function doLogout(){
  try{ await api('POST','/logout',{}); }catch(e){}
  clearAuth(); await loadAll().catch(()=>{});
  if (location.hash==='#home'||location.hash==='') render(); else location.hash='home';
}

async function loadAll(){
  const [w,e,c] = await Promise.all([api('GET','/wrestlers'), api('GET','/events'), api('GET','/championships')]);
  const wm={}, em={};
  w.wrestlers.forEach(x=>{wm[x.id]=x;}); e.events.forEach(x=>{em[x.id]=x;});
  const sig = JSON.stringify([wm,em,c.championships]);
  const changed = sig!==S.sig;
  S.sig=sig; S.wrestlers=wm; S.events=em; S.champs=c.championships||[]; S.loadedW=S.loadedE=true; S.failed=false;
  return changed;
}
async function refresh(){
  try{ if (await loadAll() && !S.editing) render(true); }catch(e){}
}
// small shim so the page code can write through the API
S.db = { doc(path){
  const [col,id]=path.split('/');
  const store = () => col==='events' ? S.events : S.wrestlers;
  return {
    async set(data){ await api('PUT','/'+col+'/'+id,data); await loadAll(); setTimeout(()=>{ if(!S.editing) render(true); },0); },
    async update(patch){ await api('PUT','/'+col+'/'+id,Object.assign({},store()[id]||{},patch)); await loadAll(); setTimeout(()=>{ if(!S.editing) render(true); },0); },
    async delete(){ await api('DELETE','/'+col+'/'+id); await loadAll(); setTimeout(()=>{ if(!S.editing) render(true); },0); }
  };
}};

/* ----- auth pages ----- */
function authCard(title, ...kids){
  return h('div',{style:'max-width:440px;margin:30px auto'},
    h('img',{class:'auth-badge',src:'img/uscw-badge.webp',alt:'USCW',width:'120'}),
    h('div',{class:'sect-h'},h('h2',{},title)),
    h('div',{class:'card'},kids));
}
function field(label, input, hint){ return h('div',{class:'f'},h('label',{class:'l'},label),input,hint?h('div',{class:'hint'},hint):null); }
function msgBox(){ return h('div',{class:'notice',style:'display:none'}); }
function showMsg(box, text, ok){ box.textContent=text; box.style.display='block'; box.className='notice'+(ok?'':' err'); }
function linkTo(href,text){ return h('a',{href,style:'text-decoration:underline;color:var(--blue)'},text); }

function pageLogin(){
  if (S.user) return h('div',{class:'empty'},'You’re already logged in. ',linkTo('#home','Back to home'));
  const email=h('input',{type:'text',autocomplete:'username',inputmode:'email'});
  const pw=h('input',{type:'password',autocomplete:'current-password'});
  const box=msgBox(); const resend=h('div',{style:'margin-top:10px'});
  const btn=h('button',{class:'btn',type:'submit'},'Log in');
  const form=h('form',{onsubmit:async e=>{
    e.preventDefault(); btn.disabled=true; box.style.display='none'; resend.replaceChildren();
    try{
      const r=await api('POST','/login',{email:email.value,password:pw.value});
      S.token=r.token; try{localStorage.setItem(TOKEN_KEY,r.token);}catch(_){}
      setUser(r.user); await loadAll(); location.hash='home'; render();
    }catch(err){
      showMsg(box,err.message,false);
      if (err.code==='unverified') resend.append(h('button',{class:'btn alt sm',type:'button',onclick:async()=>{
        try{ const r=await api('POST','/resend-verification',{email:email.value}); showMsg(box,r.message,true); }catch(e2){ showMsg(box,e2.message,false); }
      }},'Resend confirmation email'));
    } finally { btn.disabled=false; }
  }}, field('Email',email), field('Password',pw), box, h('div',{class:'row',style:'margin-top:10px'},btn), resend);
  return authCard('Log in', form, h('div',{class:'hint',style:'margin-top:16px'},linkTo('#forgot','Forgot your password?'),' · ',linkTo('#register','Create an account')));
}
function pageRegister(){
  if (S.user) return h('div',{class:'empty'},'You’re already logged in. ',linkTo('#home','Back to home'));
  const email=h('input',{type:'text',autocomplete:'username',inputmode:'email'});
  const pw=h('input',{type:'password',autocomplete:'new-password'});
  const pw2=h('input',{type:'password',autocomplete:'new-password'});
  const box=msgBox();
  const btn=h('button',{class:'btn',type:'submit'},'Create account');
  const form=h('form',{onsubmit:async e=>{
    e.preventDefault(); box.style.display='none';
    if (pw.value.length<8||pw.value.length>128) return showMsg(box,'Password must be 8 to 128 characters long.',false);
    if (pw.value!==pw2.value) return showMsg(box,'The two passwords don’t match.',false);
    btn.disabled=true;
    try{ const r=await api('POST','/register',{email:email.value,password:pw.value}); showMsg(box,r.message,true); form.reset(); }
    catch(err){ showMsg(box,err.message,false); } finally { btn.disabled=false; }
  }}, field('Email',email,'Your email is your username. We’ll send a confirmation link.'), field('Password',pw,'8 to 128 characters.'), field('Confirm password',pw2), box, h('div',{class:'row',style:'margin-top:10px'},btn));
  return authCard('Join USCW', form, h('div',{class:'hint',style:'margin-top:16px'},'Already have an account? ',linkTo('#login','Log in')));
}
function pageForgot(){
  const email=h('input',{type:'text',autocomplete:'username',inputmode:'email'});
  const box=msgBox(); const btn=h('button',{class:'btn',type:'submit'},'Send reset link');
  const form=h('form',{onsubmit:async e=>{
    e.preventDefault(); btn.disabled=true; box.style.display='none';
    try{ const r=await api('POST','/forgot',{email:email.value}); showMsg(box,r.message,true); }
    catch(err){ showMsg(box,err.message,false); } finally { btn.disabled=false; }
  }}, field('Email',email), box, h('div',{class:'row',style:'margin-top:10px'},btn));
  return authCard('Reset your password', form, h('div',{class:'hint',style:'margin-top:16px'},linkTo('#login','Back to log in')));
}
function pageReset(token){
  const pw=h('input',{type:'password',autocomplete:'new-password'});
  const pw2=h('input',{type:'password',autocomplete:'new-password'});
  const box=msgBox(); const btn=h('button',{class:'btn',type:'submit'},'Set new password');
  const form=h('form',{onsubmit:async e=>{
    e.preventDefault(); box.style.display='none';
    if (pw.value.length<8||pw.value.length>128) return showMsg(box,'Password must be 8 to 128 characters long.',false);
    if (pw.value!==pw2.value) return showMsg(box,'The two passwords don’t match.',false);
    btn.disabled=true;
    try{ await api('POST','/reset',{token,password:pw.value}); clearAuth(); location.hash='login'; toast('Password updated. Please log in.'); }
    catch(err){ showMsg(box,err.message,false); btn.disabled=false; }
  }}, field('New password',pw,'8 to 128 characters.'), field('Confirm new password',pw2), box, h('div',{class:'row',style:'margin-top:10px'},btn));
  return authCard('Choose a new password', form);
}
const verifyCache = {};
function pageVerify(token){
  const body=h('div',{},'Confirming your email…');
  if (!verifyCache[token]) verifyCache[token]=api('POST','/verify',{token}).then(()=>({ok:true}),e=>({ok:false,msg:e.message}));
  verifyCache[token].then(r=>{
    body.replaceChildren(r.ok
      ? h('div',{},h('div',{class:'notice success'},'Your email is confirmed! You can log in now.'),h('a',{class:'btn',href:'#login'},'Log in'))
      : h('div',{},h('div',{class:'notice'},r.msg)));
  });
  return authCard('Email confirmation', body);
}

/* ---------- boot ---------- */
async function boot(){
  renderNav(route());
  try{ S.token = localStorage.getItem(TOKEN_KEY); }catch(e){ S.token=null; }
  if (S.token){
    try{ const me=await api('GET','/me'); setUser(me.user); }
    catch(e){ if (e.status===401) clearAuth(); }
  }
  try{ await loadAll(); }catch(e){ S.failed=true; }
  render();
  setInterval(()=>{ if(!document.hidden && !S.editing) refresh(); }, 60000);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && !S.editing) refresh(); });
}
window.addEventListener('hashchange', ()=>{ render(); refresh(); });
boot();
})();
