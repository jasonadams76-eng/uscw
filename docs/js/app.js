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
  wrestlers:{}, events:{}, champs:[], story:{}, loadedW:false, loadedE:false, failed:false, editing:false, draft:null
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
const CUES = [['','No sound'],['intro_music','Show intro music'],['bell','Bell'],['crowd_pop','Crowd pop'],['crowd_boo','Crowd boos'],['crowd_chant','Crowd chant'],['mat_slam','Slam on the mat'],['pin_count','Pin count'],['chair_shot','Chair shot'],['entrance','Entrance theme…']];
const LENGTHS = [[1,'Short · 1 min'],[3,'Medium · 3 min'],[6,'Long · 6 min'],[10,'Epic · 10 min']];
const WORDS_PER_MIN = 200, REVEAL_WPS = 3.3, BREATH = 0.25;   // reveal pace: must match the Worker's timeline
const defLength = type => type==='match'?6:type==='show_intro'?4:3;
const wordCount = t => (String(t||'').trim().match(/\S+/g)||[]).length;
const SEG_TYPES = {show_intro:'Show Intro', match:'Match', promo:'Promo / Interview', backstage:'Backstage Segment', angle:'Angle / Brawl', ceremony:'Ceremony / Announcement', other:'Other'};
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
  if (S.user && S.wrestlers[S.uid]) items.push(['hub','My Hub']);
  if (S.isCEO) items.push(['ceo','CEO Office']);
  const active = r.name==='wrestler'?'superstars': (r.name==='event'||r.name==='watch')?((S.events[r.id]&&S.events[r.id].ple)?'ples':'mayhem'): (r.name==='ceo-new-event'||r.name==='ceo-edit')?'ceo': (r.name==='edit'&&r.id===S.uid)?'my-wrestler': r.name;
  items.forEach(([k,l])=>nav.append(h('a',{href:'#'+k,class:active===k?'on':''},l,(k==='ceo'&&unseenSubs())?h('span',{class:'badge',title:unseenSubs()+' new player submission(s)'},unseenSubs()):null)));
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

/* ----- storylines (CEO only) + intro writer ----- */
const RESULT_OPTS=['Win','Loss','Draw','No Contest'];
const MONTH_RE=/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const pick=a=>a[Math.floor(Math.random()*a.length)];
function shuffle(a){ a=a.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
const andList=a=>a.length<2?(a[0]||''):a.length===2?a[0]+' and '+a[1]:a.slice(0,-1).join(', ')+', and '+a[a.length-1];
const trimEnd=t=>String(t||'').trim().replace(/[.!?\s]+$/,'');
function ordinal(n){ const v=n%100; return n+(['th','st','nd','rd'][(v-20)%10]||['th','st','nd','rd'][v]||'th'); }
function niceDate(iso,dow){
  if(!iso) return '';
  const [y,m,d]=iso.split('-').map(Number), dt=new Date(y,m-1,d);
  return (dow?dt.toLocaleDateString('en-US',{weekday:'long'})+', ':'')+dt.toLocaleDateString('en-US',{month:'long'})+' '+ordinal(d);
}
function storyOf(id){ const s=(S.story&&S.story[id])||{}; return {results:s.results||[],feuds:s.feuds||[],notes:s.notes||[]}; }
async function saveStory(id, mutate){
  const st=JSON.parse(JSON.stringify(storyOf(id))); mutate(st);
  await api('PUT','/story/'+id,st);
  S.story=S.story||{}; S.story[id]=st;
}
function matchStakes(sg){
  const bits=[], t=(sg.title||'').trim(), st=(sg.stip||'').trim();
  if(t) bits.push(/\b(title|championship|belt|titles)\b/i.test(t)?'with the '+t+' on the line':'billed as '+t);
  if(st){ const core=st.replace(/\s+match$/i,''); bits.push('in '+(/^[aeiou]/i.test(core)?'an ':'a ')+core+' match'); }
  return bits;
}
const sidesText=sides=>(sides||[]).filter(x=>x.length).map(x=>andList(x.map(wname))).join(' vs. ');
// Upcoming matches for a wrestler come straight from the published cards.
function upcomingFor(wid,o){
  const out=[];
  Object.values(S.events).forEach(e=>{
    if(!e.published||(e.date||'')<o.from||e.id===o.exceptId) return;
    (e.segments||[]).forEach(sg=>{
      if(sg.type!=='match') return;
      const si=(sg.sides||[]).findIndex(side=>side.includes(wid));
      if(si>=0) out.push({e,sg,si});
    });
  });
  return out.sort((a,b)=>((a.e.date||'')+(a.e.time||'')).localeCompare((b.e.date||'')+(b.e.time||'')));
}
function upMeta(u,wid){
  const others=u.sg.sides.filter((_,i)=>i!==u.si).filter(x=>x.length).map(x=>andList(x.map(wname)));
  const partners=u.sg.sides[u.si].filter(x=>x!==wid).map(wname);
  const where=[u.e.venue,u.e.city].filter(Boolean).join(', ');
  return {others,partners,where,stakes:matchStakes(u.sg)};
}
function upcomingLine(u,wid){
  const m=upMeta(u,wid);
  return niceDate(u.e.date,true)+' · '+(u.e.title||'Show')+(m.where?' · '+m.where:'')+' — '+(m.partners.length?'with '+andList(m.partners)+' ':'')+'vs. '+(m.others.join(' vs. ')||'TBA')+(m.stakes.length?' ('+m.stakes.join(', ')+')':'');
}
function noteLine(n,note){
  let t=trimEnd(note.text);
  if(!t.toLowerCase().startsWith(n.toLowerCase())) t=n+' '+t;
  if(note.date&&!MONTH_RE.test(t)&&!/edition/i.test(t)) t+=' on the '+niceDate(note.date)+' edition of '+(note.show||'Mayhem');
  return t+'.';
}
function resultLine(n,r){
  const o=r.opponent, how=r.how?' ('+trimEnd(r.how)+')':'', on=r.show?' on '+r.show:'';
  const what=r.result==='Loss'?'a loss to '+o:r.result==='Draw'?'a draw with '+o:r.result==='No Contest'?'a no contest against '+o:'a win over '+o;
  return n+' comes in off '+what+on+how+'.';
}
// A short run of storyline sentences about one wrestler, as of the date of the show being written.
function storyBlurb(wid,d){
  const st=storyOf(wid), n=wname(wid), out=[], cut=d.date||'9999-12-31';
  const desc=(a,b)=>(b.date||'').localeCompare(a.date||'');
  const note=st.notes.filter(x=>!x.date||x.date<=cut).sort(desc)[0];
  if(note) out.push(noteLine(n,note));
  st.feuds.slice(0,2).forEach(f=>{
    const fn=S.wrestlers[f.with]?S.wrestlers[f.with].ringName:f.with;
    out.push(n+' is locked in a heated feud with '+fn+(f.reason?': '+trimEnd(f.reason):'')+'.');
  });
  const res=st.results.filter(x=>!x.date||x.date<=cut).sort(desc)[0];
  if(res) out.push(resultLine(n,res));
  const from=d.date&&d.date>todayISO()?d.date:todayISO();
  const up=upcomingFor(wid,{from,exceptId:d.id}).filter(u=>u.e.date>(d.date||''))[0];
  if(up){
    const m=upMeta(up,wid);
    out.push('Looking ahead, '+n+' is booked to '+(m.partners.length?'team with '+andList(m.partners)+' to ':'')+'face '+(andList(m.others)||'a mystery opponent')+' at '+(up.e.title||'an upcoming show')+' on '+niceDate(up.e.date,true)+(m.where?', live from '+m.where:'')+(m.stakes.length?', '+m.stakes.join(', '):'')+'.');
  }
  return out;
}
// The built-in Show Intro writer: opening logo + music, crowd pan, Mike Johnson's welcome and the card rundown.
function draftIntro(d){
  const beats=[], say=t=>'Mike Johnson: “'+t+'”';
  const matches=d.segments.filter(s=>s.type==='match'&&s.sides.some(x=>x.length));
  const venue=(d.venue||'').trim(), city=(d.city||'').trim();
  const place=venue?venue+(city?' in '+city:''):(city||'the arena');
  const title=(d.title||'').trim()||'Monday Night Mayhem';
  const night=d.date?new Date(+d.date.slice(0,4),+d.date.slice(5,7)-1,+d.date.slice(8,10)).toLocaleDateString('en-US',{weekday:'long'}):'';
  beats.push({cue:'intro_music',pause:2,text:'(The screen goes black. A single spotlight snaps on, the '+title+' logo explodes onto the screen, and the show’s theme music thunders through the building.)'});
  const crowd=[
    'The cameras sweep across a packed '+(venue||'arena')+', a sea of fans on their feet as the lights flash and the noise keeps building.',
    'A hand-held camera dives into the front rows: kids on shoulders, fans pounding the barricade, and signs for every superstar on the roster bobbing overhead.',
    'High above the ring, a wide shot reveals every seat taken, the upper deck shaking as a chant rolls around the building.',
    'Pyro bursts from the stage as the camera swings down the entrance ramp toward the ring, where the lights glint off the ring posts.',
    'Back in the crowd, fans in homemade shirts scream at the camera, some already hoarse, none of them willing to sit down.',
    'The shot pushes in on ringside, where the commentary desk waits under the spotlights and the front row leans in for a better view.',
    'Fans crane toward the giant video screen as the USCW logo flashes across it, and the crowd answers with a thunderous roar.'
  ];
  if(city) crowd.push(city+' has shown up in force tonight, and you can feel it in every shot of the building.');
  shuffle(crowd).slice(0,3).forEach((t,i)=>beats.push({text:'('+t+')',pause:1,cue:i===1?'crowd_pop':''}));
  beats.push({cue:'',pause:1,text:say(pick([
    'Ladies and gentlemen, welcome to '+title+', live from '+place+'! I’m Mike Johnson, and you are not going to believe the show USCW has in store for you '+(night?'this '+night+' ':'')+'night!',
    'Good evening, everybody, and welcome to '+title+', coming to you live from '+place+'! This is Mike Johnson, and tonight is one you will be talking about for a long time!',
    'Welcome, USCW universe, to '+title+'! We are live from '+place+', the crowd is red hot, and we have an unbelievable show for you tonight!'
  ])+' Let me run down what we have for you.')});
  matches.forEach((sg,i)=>{
    const main=matches.length>1&&i===matches.length-1;
    const lead=main?pick(['And in tonight’s main event','Closing the show, our main event','And the main event of the night']):i===0?pick(['Kicking things off','First up tonight']):pick(['Also on the card','Later tonight','Plus']);
    const stakes=matchStakes(sg);
    let t=lead+', '+sidesText(sg.sides)+(stakes.length?', '+stakes.join(', '):'')+'.';
    const ids=sg.sides.map(x=>x), flat=sg.sides.flat();
    let fl='';
    for(let a=0;a<flat.length&&!fl;a++) for(let b=0;b<flat.length&&!fl;b++){
      if(a===b||ids.findIndex(s=>s.includes(flat[a]))===ids.findIndex(s=>s.includes(flat[b]))) continue;
      const f=storyOf(flat[a]).feuds.find(x=>x.with===flat[b]);
      if(f) fl=' '+(f.reason?'This one is personal: '+trimEnd(f.reason)+'.':wname(flat[a])+' and '+wname(flat[b])+' have a score to settle.');
    }
    beats.push({cue:main?'crowd_pop':'',pause:0,text:say(t+fl)});
  });
  if(!matches.length) beats.push({cue:'',pause:0,text:say('The card is being kept under wraps tonight, and I can tell you, nobody is ready for what is coming!')});
  const inMatch=new Set(matches.flatMap(s=>s.sides.flat()));
  const appear=[];
  d.segments.filter(s=>s.type!=='match'&&s.type!=='show_intro').forEach(s=>s.sides.flat().forEach(w=>{ if(S.wrestlers[w]&&!inMatch.has(w)&&!appear.includes(w)) appear.push(w); }));
  appear.forEach(w=>{
    const n=wname(w), bl=storyBlurb(w,d);
    const lead=pick(['Also scheduled to be here tonight is '+n,'We have also been told that '+n+' is scheduled to be here tonight']);
    beats.push({cue:'',pause:0,text:say(lead+(bl.length?'. '+bl.join(' '):'!'))});
  });
  beats.push({cue:'crowd_pop',pause:0,text:say('It is going to be a wild one, so do not go anywhere. This is '+title+', and it starts right now!')});
  beats.forEach(b=>{ b.text=b.text.slice(0,1200); });
  const words=beats.reduce((n,b)=>n+wordCount(b.text),0), pauses=beats.reduce((n,b)=>n+(b.pause||0),0);
  return {beats, length:Math.max(1,Math.min(30,Math.ceil(words/WORDS_PER_MIN+pauses/60)))};
}
/* ----- AI writer (Gemini through the Worker) ----- */
const AI_GAP_MS=7000;   // pause between calls when writing the whole card, to stay under the free-tier rate limit
function segLabel(s){ return (SEG_TYPES[s.type]||'Segment')+(s.title?': '+s.title:'')+(s.type==='match'&&s.sides.some(x=>x.length)?' — '+sidesText(s.sides):''); }
function resultText(s){
  const r=s.result||{};
  if(Number.isInteger(r.winner)&&r.winner>=0&&s.sides[r.winner]) return andList(s.sides[r.winner].map(wname))+' won'+(r.finish?' ('+trimEnd(r.finish)+')':'');
  if(r.winner===-1) return 'ended in a draw / no contest';
  return '';
}
function feudLine(sg){
  const flat=sg.sides.flat();
  for(let a=0;a<flat.length;a++) for(let b=0;b<flat.length;b++){
    if(a===b||sg.sides.findIndex(x=>x.includes(flat[a]))===sg.sides.findIndex(x=>x.includes(flat[b]))) continue;
    const f=storyOf(flat[a]).feuds.find(x=>x.with===flat[b]);
    if(f) return ' (feud: '+wname(flat[a])+' vs. '+wname(flat[b])+(f.reason?' — '+trimEnd(f.reason):'')+')';
  }
  return '';
}
function introFacts(d){
  const matches=d.segments.filter(s=>s.type==='match'&&s.sides.some(x=>x.length));
  const lines=matches.map((sg,i)=>{
    const st=matchStakes(sg);
    return (matches.length>1&&i===matches.length-1?'MAIN EVENT: ':'')+sidesText(sg.sides)+(st.length?' ('+st.join(', ')+')':'')+feudLine(sg);
  });
  const inMatch=new Set(matches.flatMap(s=>s.sides.flat())), appear=[];
  d.segments.filter(s=>s.type!=='match'&&s.type!=='show_intro').forEach(s=>s.sides.flat().forEach(w=>{ if(S.wrestlers[w]&&!inMatch.has(w)&&!appear.includes(w)) appear.push(w); }));
  return {matches:lines, appearances:appear.map(w=>({name:wname(w),facts:storyBlurb(w,d).slice(0,6)}))};
}
function aiEarlier(d,idx){
  const out=[];
  d.segments.slice(0,idx).forEach(s=>{
    if(s.type==='show_intro') return;
    if(s.type==='match'){
      if(!s.sides.some(x=>x.length)) return;
      const r=resultText(s), st=matchStakes(s);
      out.push('Match: '+sidesText(s.sides)+(st.length?' ('+st.join(', ')+')':'')+(r?' — '+r:'')+(s.desc?'. '+s.desc.slice(0,150):''));
    } else if(s.title||s.desc){
      const who=s.sides.flat().filter(w=>S.wrestlers[w]).map(wname);
      out.push((SEG_TYPES[s.type]||'Segment')+(s.title?' "'+s.title+'"':'')+(who.length?' ('+andList(who)+')':'')+(s.desc?': '+s.desc.slice(0,200):''));
    }
  });
  return out.slice(-12).map(t=>t.slice(0,300));
}
// Intro, non-match segments and the main event use the stronger (but scarcer) model; other matches use Flash-Lite.
function aiTier(d,idx){
  const s=d.segments[idx], last=d.segments.reduce((a,x,i)=>x.type==='match'?i:a,-1);
  return (s.type!=='match'||idx===last)?'main':'lite';
}
function aiPayload(d,idx){
  const s=d.segments[idx], isIntro=s.type==='show_intro';
  const ids=[...new Set((isIntro?d.segments.filter(x=>x.type!=='show_intro'):[s]).flatMap(x=>x.sides.flat()).filter(w=>S.wrestlers[w]))].slice(0,24);
  const facts={}; ids.forEach(w=>{ facts[w]=storyBlurb(w,d).slice(0,6); });
  const p={kind:isIntro?'intro':'segment', tier:aiTier(d,idx),
    show:{title:d.title,date:d.date,venue:d.venue,city:d.city,ple:!!d.ple,notes:d.notes},
    segment:{type:s.type,title:s.title,stip:s.stip,desc:s.desc,length:s.length,sides:s.sides.map(x=>x.filter(w=>S.wrestlers[w]))},
    wrestlers:ids, facts, earlier:aiEarlier(d,idx),
    champions:S.champs.filter(c=>c.holders.some(id=>S.wrestlers[id])).map(c=>c.name+': '+andList(c.holders.filter(id=>S.wrestlers[id]).map(wname)))};
  if(s.type==='match') p.result={winner:Number.isInteger(s.result&&s.result.winner)?s.result.winner:-1,finish:(s.result&&s.result.finish)||''};
  if(isIntro){
    p.card=introFacts(d);
    p.base=(s.beats.some(b=>(b.text||'').trim())?s.beats:draftIntro(d).beats).map(b=>({text:b.text}));
  }
  return p;
}
async function aiRun(d,idx){
  const r=await api('POST','/ai/draft',aiPayload(d,idx));
  d.segments[idx].beats=r.beats.map(b=>({text:b.text||'',pause:b.pause||0,cue:b.cue||''}));
  return r;
}
// Polish a player's own text (from an approved Hub pitch). Shows the result next to the original; nothing changes until "Use polished".
function polishBeats(d,idx,beats){
  const p=aiPayload(d,idx);
  p.kind='polish'; p.tier='main'; p.base=beats.map(b=>({text:b.text}));
  return api('POST','/ai/draft',p);
}
function polishDialog(d,idx,beats,onUse){
  const asText=bs=>bs.map(b=>b.text).join('\n\n');
  const col=(t,txt)=>h('div',{style:'flex:1;min-width:240px'},h('div',{class:'hint',style:'font-weight:700;margin-bottom:4px'},t),h('div',{class:'bio',style:'white-space:pre-wrap;max-height:300px;overflow:auto;border:1px solid var(--line,#ccd);padding:8px;color:var(--text)'},txt));
  const box=h('div',{},h('div',{class:'hint'},'Gemini is polishing the text…'));
  let cur=null, close=()=>{};
  const status=h('span',{class:'hint'});
  const go=async()=>{
    cur=null; status.textContent='Writing…';
    try{
      const r=await polishBeats(d,idx,beats);
      cur=r.beats.map(b=>({text:b.text||'',pause:b.pause||0,cue:b.cue||''}));
      box.replaceChildren(h('div',{class:'row',style:'align-items:flex-start;gap:12px'},col('Original',asText(beats)),col('Polished',asText(cur))));
      status.textContent=r.fellBack?'Written by the backup model.':'';
    }catch(e){ box.replaceChildren(h('div',{class:'hint',style:'color:#b00'},(e&&e.message)||'The AI writer failed.')); status.textContent=''; }
    useBtn.disabled=!cur; redo.disabled=false;
  };
  const useBtn=h('button',{class:'btn sm',type:'button',disabled:true,onclick:()=>{ if(!cur) return; onUse(cur); close(); }},'Use polished');
  const redo=h('button',{class:'btn alt sm',type:'button',disabled:true,onclick:()=>{ useBtn.disabled=true; redo.disabled=true; box.replaceChildren(h('div',{class:'hint'},'Gemini is polishing the text…')); go(); }},'Redraft');
  modal('✨ Polish with AI',box,c=>{ close=c; return [status,h('button',{class:'btn alt sm',type:'button',onclick:c},'Keep original'),redo,useBtn]; });
  go();
}
function wholeCardDialog(d,onDone){
  if(!d.segments.length){ toast('Add some segments to the card first.',true); return; }
  let cancel=false;
  const status=h('div',{class:'hint',style:'margin-top:10px;min-height:20px'});
  const summary=h('div',{class:'hint',style:'margin:8px 0'});
  const rows=d.segments.map((s,i)=>{
    const has=s.beats.some(b=>(b.text||'').trim());
    const chk=h('input',{type:'checkbox',checked:!has,style:'width:auto',onchange:sum});
    let extra=null;
    if(s.type==='match'){
      s.result=s.result||{winner:null,finish:''};
      extra=h('div',{class:'row',style:'margin:4px 0 0 26px'},
        h('select',{style:'width:auto',onchange:e=>{ const v=e.target.value; s.result.winner=v===''?null:v==='draw'?-1:Number(v); }},
          h('option',{value:''},'— winner? —'),
          s.sides.map((side,si)=>side.length?h('option',{value:String(si),selected:s.result.winner===si},andList(side.map(wname))+' win'):null),
          h('option',{value:'draw',selected:s.result.winner===-1},'Draw / no contest')),
        h('input',{type:'text',style:'flex:1;min-width:180px',placeholder:'Finish (optional)',value:s.result.finish||'',oninput:e=>{s.result.finish=e.target.value;}}));
    }
    return {s,chk,el:h('div',{class:'wc-row'},h('label',{style:'display:flex;gap:8px;align-items:center;cursor:pointer'},chk,h('span',{},(i+1)+'. '+segLabel(s)+(has?'  (already has text)':''))),extra)};
  });
  function sum(){
    const picked=rows.filter(r=>r.chk.checked), main=picked.filter(r=>aiTier(d,d.segments.indexOf(r.s))==='main').length;
    summary.textContent=picked.length+' segment'+(picked.length===1?'':'s')+' selected · uses '+main+' Gemini 3.8 Flash (about 20 free a day) and '+(picked.length-main)+' Flash-Lite requests. Takes about '+Math.max(1,Math.round(picked.length*(AI_GAP_MS/1000+12)/60))+' min.';
  }
  sum();
  const body=h('div',{},
    h('p',{style:'margin:0 0 8px'},'The AI writes each ticked segment in card order, using the wrestlers’ profiles, their storylines and what happened earlier in the night. Pick the winner of every match first. Nothing is saved until you save the show.'),
    h('div',{class:'row',style:'margin-bottom:6px'},
      h('button',{type:'button',class:'btn alt sm',onclick:()=>{rows.forEach(r=>r.chk.checked=true);sum();}},'Select all'),
      h('button',{type:'button',class:'btn alt sm',onclick:()=>{rows.forEach(r=>r.chk.checked=false);sum();}},'Select none')),
    h('div',{class:'wc-list'},rows.map(r=>r.el)), summary, status);
  modal('Draft whole card with AI',body,close=>{
    const go=h('button',{class:'btn sm',type:'button',onclick:async()=>{
      const todo=rows.filter(r=>r.chk.checked);
      if(!todo.length){ status.textContent='Tick at least one segment.'; return; }
      if(todo.some(r=>r.s.type==='match'&&!Number.isInteger(r.s.result.winner))){ status.textContent='Pick a winner (or Draw) for every match you want written.'; return; }
      const thin=todo.find(r=>r.s.type==='match'&&r.s.sides.filter(x=>x.length).length<2);
      if(thin){ status.textContent='“'+segLabel(thin.s)+'” needs wrestlers on at least two sides before the AI can write it.'; return; }
      go.disabled=true; let done=0;
      for(let k=0;k<todo.length;k++){
        if(cancel) break;
        const r=todo[k];
        status.textContent='Writing '+(k+1)+' of '+todo.length+': '+segLabel(r.s)+'…';
        try{ await aiRun(d,d.segments.indexOf(r.s)); done++; }
        catch(e){ status.textContent='Stopped at “'+segLabel(r.s)+'”: '+(e.message||'failed')+' ('+done+' written so far.)'; onDone(); go.disabled=false; return; }
        if(k<todo.length-1&&!cancel) await new Promise(ok=>setTimeout(ok,AI_GAP_MS));
      }
      onDone(); status.textContent=cancel?'Stopped. '+done+' written.':'Done. '+done+' segment'+(done===1?'':'s')+' written. Review and edit them, then save the show.';
      go.textContent='Done'; go.disabled=false; go.onclick=close;
    }},'✨ Write it');
    return [h('button',{class:'btn alt sm',type:'button',onclick:()=>{cancel=true;close();}},'Close'),go];
  });
}

function storyPanel(id){
  const w=S.wrestlers[id], box=h('div',{class:'story'});
  async function mut(fn,msg){ if(await safe(()=>saveStory(id,fn),msg)) draw(); }
  const rosterOpts=Object.entries(S.wrestlers).filter(([k])=>k!==id).sort((a,b)=>a[1].ringName.localeCompare(b[1].ringName));
  const del=(label,fn)=>h('button',{type:'button',class:'btn danger sm',title:'Delete',onclick:()=>mut(fn,'Removed.')},label||'×');
  function draw(){
    box.replaceChildren();
    const st=storyOf(id);
    box.append(h('div',{class:'cond story-h'},'Storylines — CEO only'),
      h('div',{class:'hint',style:'margin:0 0 10px'},'The Show Intro writer reads this to describe what is going on with '+w.ringName+'. Keep it fresh after each show.'));
    const up=upcomingFor(id,{from:todayISO()});
    box.append(h('h3',{},'Upcoming matches'),
      up.length?h('ul',{class:'story-list'},up.map(u=>h('li',{},upcomingLine(u,id)))):h('div',{class:'hint'},'None yet. This fills in automatically from published cards.'));
    // results
    const r={date:todayISO(),show:'',opponent:'',result:'Win',how:''};
    box.append(h('h3',{},'Recent results'),
      st.results.length?h('ul',{class:'story-list'},st.results.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(it=>h('li',{},
        h('span',{},(it.date?niceDate(it.date)+' · ':'')+(it.show?it.show+' · ':'')+it.result+' vs. '+it.opponent+(it.how?' ('+it.how+')':'')),
        del('×',s=>{s.results=s.results.filter(x=>x.id!==it.id);})))):h('div',{class:'hint'},'No results recorded.'),
      h('div',{class:'story-add'},
        h('input',{type:'date',value:r.date,oninput:e=>{r.date=e.target.value;}}),
        h('input',{type:'text',placeholder:'Show (e.g. Mayhem)',oninput:e=>{r.show=e.target.value;}}),
        h('input',{type:'text',placeholder:'Opponent',list:'story-opps-'+id,oninput:e=>{r.opponent=e.target.value;}}),
        h('select',{onchange:e=>{r.result=e.target.value;}},RESULT_OPTS.map(o=>h('option',{value:o},o))),
        h('input',{type:'text',placeholder:'How (optional)',oninput:e=>{r.how=e.target.value;}}),
        h('button',{type:'button',class:'btn sm',onclick:()=>{ if(!r.opponent.trim()){toast('Enter the opponent.',true);return;} mut(s=>{s.results.unshift({id:uid8(),date:r.date,show:r.show.trim(),opponent:r.opponent.trim(),result:r.result,how:r.how.trim()});},'Result added.'); }},'Add result'),
        h('datalist',{id:'story-opps-'+id},rosterOpts.map(([k,x])=>h('option',{value:x.ringName})))));
    // feuds
    const f={with:'',reason:''};
    box.append(h('h3',{},'Current feuds'),
      st.feuds.length?h('ul',{class:'story-list'},st.feuds.map(it=>h('li',{},
        h('span',{},(S.wrestlers[it.with]?S.wrestlers[it.with].ringName:it.with)+(it.reason?' — '+it.reason:'')),
        del('×',s=>{s.feuds=s.feuds.filter(x=>x.id!==it.id);})))):h('div',{class:'hint'},'No active feuds.'),
      h('div',{class:'story-add'},
        h('select',{onchange:e=>{f.with=e.target.value;}},h('option',{value:''},'Feuding with…'),rosterOpts.map(([k,x])=>h('option',{value:k},x.ringName))),
        h('input',{type:'text',class:'wide',placeholder:'What it is about (optional)',oninput:e=>{f.reason=e.target.value;}}),
        h('button',{type:'button',class:'btn sm',onclick:()=>{ if(!f.with){toast('Pick who the feud is with.',true);return;} mut(s=>{s.feuds.push({id:uid8(),with:f.with,reason:f.reason.trim()});},'Feud added.'); }},'Add feud')));
    // notes
    const nt={date:todayISO(),show:'',text:''};
    box.append(h('h3',{},'Show notes'),
      st.notes.length?h('ul',{class:'story-list'},st.notes.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(it=>h('li',{},
        h('span',{},(it.date?niceDate(it.date)+' · ':'')+(it.show?it.show+' · ':'')+w.ringName+' '+it.text),
        del('×',s=>{s.notes=s.notes.filter(x=>x.id!==it.id);})))):h('div',{class:'hint'},'No notes yet.'),
      h('div',{class:'story-add'},
        h('input',{type:'date',value:nt.date,oninput:e=>{nt.date=e.target.value;}}),
        h('input',{type:'text',placeholder:'Show (e.g. Mayhem)',oninput:e=>{nt.show=e.target.value;}}),
        h('input',{type:'text',class:'wide',placeholder:'Continue the name: “was attacked backstage by …”',oninput:e=>{nt.text=e.target.value;}}),
        h('button',{type:'button',class:'btn sm',onclick:()=>{ if(!nt.text.trim()){toast('Write the note first.',true);return;} mut(s=>{s.notes.unshift({id:uid8(),date:nt.date,show:nt.show.trim(),text:nt.text.trim()});},'Note added.'); }},'Add note')));
  }
  draw();
  return box;
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
      cats.length?h('div',{class:'moves',style:'margin-top:12px'},cats.map(([k,l])=>h('div',{class:'card'},h('h3',{},l),h('ul',{},mv[k].map(m=>h('li',{},m)))))):null):null,
    S.isCEO?storyPanel(id):null);
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
/* ----- Sound: every file is optional. A cue with no file is silent; with an empty manifest the sound controls never appear. ----- */
const SND={man:null,loading:null,music:null,fade:null,shared:null,pref:(()=>{ try{ return Object.assign({on:true,vol:0.7},JSON.parse(localStorage.getItem('uscw_snd')||'{}')); }catch(_){ return {on:true,vol:0.7}; } })()};
function sndSave(){ try{ localStorage.setItem('uscw_snd',JSON.stringify(SND.pref)); }catch(_){} }
function sndLoad(){
  if(!SND.loading) SND.loading=fetch('audio/sounds.json',{cache:'no-cache'}).then(r=>r.ok?r.json():null).catch(()=>null).then(m=>{
    m=m&&typeof m==='object'?m:{}; SND.man={cues:m.cues||{},entrances:m.entrances||{},def:m.defaultEntrance||''}; return SND.man; });
  return SND.loading;
}
function sndAny(){ const m=SND.man; return !!(m&&(Object.values(m.cues).some(Boolean)||Object.values(m.entrances).some(Boolean)||m.def)); }
function sndFile(cue){
  const m=SND.man; if(!m||!cue) return '';
  if(cue==='entrance') return m.def;
  if(cue.startsWith('entrance:')) return m.entrances[cue.slice(9)]||m.def;
  return m.cues[cue]||'';
}
const sndIsMusic=cue=>cue==='intro_music'||cue==='entrance'||cue.startsWith('entrance:');
function sndFadeOut(ms,duck){
  const a=SND.music; if(!a) return; SND.music=null; clearInterval(SND.fade);
  if(duck){ try{a.volume=a.volume*duck;}catch(_){} }
  const v0=a.volume, t0=Date.now();
  SND.fade=setInterval(()=>{ const k=(Date.now()-t0)/ms; if(k>=1){ clearInterval(SND.fade); try{a.pause();}catch(_){} } else { try{a.volume=Math.max(0,v0*(1-k));}catch(_){} } },100);
}
function sndStop(){ clearInterval(SND.fade); if(SND.music){ try{SND.music.pause();}catch(_){} SND.music=null; } }
// Call from a click so browsers allow sound later.
function sndUnlock(){ try{ const a=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='); a.play().catch(()=>{}); }catch(_){} }
function sndPlay(cue,force){
  try{
    if(!cue||(!force&&!SND.pref.on)) return false;
    const f=sndFile(cue); if(!f) return false;
    const a=new Audio('audio/'+encodeURI(f)); a.volume=Math.max(0,Math.min(1,SND.pref.vol));
    if(sndIsMusic(cue)){ sndFadeOut(600); SND.music=a; SND.intro=(cue==='intro_music'); }
    a.addEventListener('error',()=>{ if(SND.music===a) SND.music=null; });
    const pr=a.play(); if(pr&&pr.catch) pr.catch(()=>{});
    return true;
  }catch(_){ return false; }
}
// A new beat arrives: let any music fade away under it, then play the beat's own sound.
// The show theme is long: it drops under the announcers and fades slowly. Other music fades out quickly.
function sndBeat(cue){ if(SND.music) (SND.intro?sndFadeOut(22000,0.35):sndFadeOut(4000)); if(cue) sndPlay(cue); }

// A pin or rope-break count: a beat that is only the numbers, e.g. "1 2" or "1 2 3". The page times it and plays the crowd count.
const COUNT_RE=/^\s*[1-4](?:[\s.]+[1-4])*[\s.]*$/;
const isCountBeat=t=>COUNT_RE.test(t||'');
function sndCount(n,pin){
  if(!SND.man||!SND.pref.on) return;
  if(pin&&sndFile('pin_count_'+n)){ sndPlay('pin_count_'+n); return; }
  sndPlay('count_'+n);
}

// When each character of a beat appears (ms): an even stream at REVEAL_WPS words a second, with a short breath after each sentence.
function revealSchedule(text){
  const words=(text.match(/\S+/g)||[]).length, speech=Math.max(1.5,words/REVEAL_WPS)*1000, len=text.length;
  const stops=[]; const re=/[.!?][”"')\]]*(?=\s)/g; let m;
  while((m=re.exec(text))) stops.push(m.index+m[0].length);
  const times=new Array(len); let si=0, extra=0;
  for(let i=0;i<len;i++){ while(si<stops.length&&i>=stops[si]){ extra+=BREATH*1000; si++; } times[i]=(i/len)*speech+extra; }
  return {times,total:speech+stops.filter(x=>x<len).length*BREATH*1000};
}

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
  S.stopWatch=()=>{ stopped=true; timers.forEach(t=>{clearTimeout(t);clearInterval(t);}); timers.clear(); sndStop(); };
  const wc=t=>(String(t||'').trim().match(/\S+/g)||[]).length;

  function startScreen(msg){
    wrap.replaceChildren();
    sndLoad().then(()=>{ if(sndAny()&&!stopped&&soundRow) soundRow.style.display=''; });
    const soundRow=h('label',{class:'hint snd-row',style:'display:none;justify-content:center;gap:6px;align-items:center;margin-top:10px'},h('input',{type:'checkbox',style:'width:auto',checked:SND.pref.on,onchange:e=>{ SND.pref.on=e.target.checked; sndSave(); }}),'🔊 Play sound and music');
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
             speedSel),soundRow],
      h('div',{style:'margin-top:14px'},h('a',{href:'#event-'+id,class:'cond',style:'color:var(--muted)'},'← Back to the card'))));
    async function begin(resume){
      sndUnlock();
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
    const muteBtn=h('button',{class:'btn alt sm',type:'button',title:'Sound on/off',style:'display:none',onclick:()=>{ SND.pref.on=!SND.pref.on; sndSave(); if(!SND.pref.on) sndStop(); drawMute(); }});
    const volIn=h('input',{type:'range',min:'0',max:'100',value:Math.round(SND.pref.vol*100),title:'Volume',style:'width:80px;display:none',oninput:e=>{ SND.pref.vol=Number(e.target.value)/100; sndSave(); if(SND.music){ try{SND.music.volume=SND.pref.vol;}catch(_){} } }});
    function drawMute(){ muteBtn.textContent=SND.pref.on?'🔊':'🔇'; }
    drawMute(); sndLoad().then(()=>{ if(sndAny()){ muteBtn.style.display=''; volIn.style.display=''; } });
    wrap.append(h('div',{class:'w-bar'},pauseBtn,h('div',{class:'w-prog'},fill),muteBtn,volIn,h('a',{href:'#event-'+id,class:'cond',style:'color:var(--on-navy)'},'Leave')),feed);
    const st={queue:[],received:0,shown:0,total:0,done:false,paused:false,busy:false,finished:false};
    const reduceMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Returns how long (ms) the text should wait so the match entrance can play.
    function segHeader(sg,animate){
      if(sg.type==='show_intro'){
        const intro=!!animate&&!reduceMotion;
        feed.append(h('div',{class:'w-seg w-intro'+(intro?' anim':'')},evImg(e,'intro-logo'),h('span',{class:'tag navy'},'Show Intro')));
        return intro?Math.round(1600/speed):0;
      }
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
    function countEl(nums,upTo){
      const p=h('p',{class:'w-beat w-count'});
      nums.slice(0,upTo).forEach((n,i)=>{ if(i) p.append(h('span',{class:'d'},' · · · · · ')); p.append(h('span',{class:'n'},String(n))); });
      return p;
    }
    function instant(b){ if(b.seg) segHeader(b.seg); if(b.text) feed.append(isCountBeat(b.text)?countEl(b.text.match(/[1-4]/g).map(Number),9):h('p',{class:'w-beat'+(/^\s*\(/.test(b.text)?' w-act':'')},b.text)); shownOne(); }
    function playNext(){
      if(stopped||st.paused||st.busy||st.finished) return;
      const b=st.queue.shift();
      if(!b){ if(st.done&&st.received>=st.total&&st.shown>=st.total) finish(); return; }
      st.busy=true; const was=nearBottom();
      const hold=b.seg?segHeader(b.seg,true):0;
      if(hold>0) follow(was);
      const runBeat=()=>{
        sndBeat(b.cue||'');
        const was1=nearBottom();
        const p=h('p',{class:'w-beat'+(/^\s*\(/.test(b.text||'')?' w-act':'')}); feed.append(p);
        follow(was1||was);
        if(isCountBeat(b.text)){
          const nums=b.text.match(/[1-4]/g).map(Number), pin=nums[nums.length-1]===3&&nums.length>=3;
          feed.removeChild(p); const cp=countEl(nums,0); feed.append(cp);
          const finishCount=()=>{
            // A kickout: the 2 hangs for a random 0.1 to 0.9 seconds before the kickout line appears.
            const extra=nums[nums.length-1]===2?(100+Math.random()*800)/speed:0;
            later(()=>{ shownOne(); later(()=>{ st.busy=false; playNext(); },(b.pause||0)*1000/speed); },extra);
          };
          const showNum=i=>{
            const wz=nearBottom();
            const n=h('span',{class:'n'},String(nums[i])); cp.append(n); follow(wz||was1);
            sndCount(nums[i],pin);
            if(i>=nums.length-1){ finishCount(); return; }
            const gap=1000/speed, dot=gap/6;
            const nd=h('span',{class:'d'}); cp.append(nd);
            for(let k=1;k<=5;k++) later(()=>{ nd.textContent+=' · '; },dot*k);
            later(()=>{ showNum(i+1); },gap);
          };
          // the first number lands right away
          showNum(0);
          return;
        }
        const text=b.text||'';
        const finishBeat=()=>{ shownOne(); later(()=>{ st.busy=false; playNext(); },(b.pause||0)*1000/speed); };
        if(!text.trim()){ finishBeat(); return; }
        // An even stream of letters. The rest of the text sits invisible so lines don't re-wrap as words grow.
        const sched=revealSchedule(text);
        const vis=h('span',{}), rest=h('span',{style:'visibility:hidden'},text);
        p.append(vis,rest);
        const t0=performance.now(); let shown=0;
        const frame=now=>{
          if(stopped) return;
          const el=(now-t0)*speed; let k=shown;
          while(k<text.length&&sched.times[k]<=el) k++;
          if(k!==shown){ shown=k; vis.textContent=text.slice(0,k); rest.textContent=text.slice(k); }
          if(k>=text.length){ follow(nearBottom()); finishBeat(); return; }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
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
  wrap.append(subInbox());
  wrap.append(h('div',{class:'hint',style:'margin-top:24px'},'Tip: to make another user a CEO, set is_admin = 1 on their row in the D1 users table (see the README).'));
  return wrap;
}

/* ----- Superstar Hub: player submissions ----- */
const SUB_TYPES={promo:'Promo / Interview', backstage:'Backstage Segment', angle:'Angle / Brawl', other:'Other'};
const MAX_OPEN_SUBS=3;
function unseenSubs(){ return S.isCEO?(S.subs||[]).filter(x=>!x.seen).length:0; }
function subStatusTag(x){
  if(x.status==='used') return h('span',{class:'tag navy'},'Used'+(S.events[x.usedEvent]?' in '+(S.events[x.usedEvent].title||'a show'):''));
  if(x.status==='approved') return h('span',{class:'tag navy'},'Approved');
  if(x.status==='declined') return h('span',{class:'tag draft'},'Declined');
  return h('span',{class:'tag'},x.seen?'Seen by the CEO':'Waiting');
}
function subDate(ms){ return new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
async function loadSubs(){ try{ S.subs=(await api('GET','/submissions')).submissions||[]; }catch(_){ S.subs=S.subs||[]; } }

function pageHub(){
  if(!S.user) return h('div',{class:'empty'},'Log in to open your Superstar Hub. ',h('a',{href:'#login',style:'color:var(--red2)'},'Log in'));
  const me=S.wrestlers[S.uid];
  if(!me) return h('div',{class:'empty'},'Create your wrestler first, then your Superstar Hub unlocks. ',h('a',{href:'#my-wrestler',style:'color:var(--red2)'},'Create wrestler'));
  const wrap=h('div',{});
  const listBox=h('div',{}), formBox=h('div',{});
  const F={type:'promo',title:'',mode:'idea',body:'',involved:[],eventId:''}; let editId=null;
  const mine=()=>(S.subs||[]).filter(x=>x.wrestlerId===S.uid);
  const pendingN=()=>mine().filter(x=>x.status==='pending').length;
  function drawForm(){
    formBox.replaceChildren();
    const full=!editId&&pendingN()>=MAX_OPEN_SUBS;
    const evs=upcomingEvents();
    const chips=h('div',{});
    function drawChips(){
      chips.replaceChildren(...F.involved.map((id,k)=>h('span',{class:'chip'},wname(id),h('button',{type:'button',title:'Remove',onclick:()=>{F.involved.splice(k,1);drawChips();}},'×'))),
        h('select',{style:'width:auto',onchange:e=>{ if(e.target.value){ F.involved.push(e.target.value); drawChips(); } }},
          h('option',{value:''},'+ Add another wrestler…'),
          Object.entries(S.wrestlers).filter(([id])=>id!==S.uid&&!F.involved.includes(id)).sort((a,b)=>a[1].ringName.localeCompare(b[1].ringName)).map(([id,w])=>h('option',{value:id},w.ringName))));
    }
    drawChips();
    const bodyIn=h('textarea',{rows:'8',maxlength:'4000',placeholder:F.mode==='idea'?'Describe what you’d like to happen: who is involved, what is said or done, how it fits your storyline…':'Write the exact text you want used: dialogue, narration, anything. The CEO may edit it.',oninput:e=>{F.body=e.target.value;}},F.body);
    formBox.append(h('div',{class:'card'},
      h('h3',{style:'margin:0 0 8px'},editId?'Edit your submission':'Pitch a segment'),
      full?h('div',{class:'notice'},'You have '+MAX_OPEN_SUBS+' submissions waiting for the CEO. Wait for a response or withdraw one below before sending another.'):null,
      h('div',{class:'cols'},
        h('div',{class:'f'},h('label',{class:'l'},'Segment type'),h('select',{onchange:e=>{F.type=e.target.value;}},Object.entries(SUB_TYPES).map(([k,l])=>h('option',{value:k,selected:F.type===k},l)))),
        h('div',{class:'f'},h('label',{class:'l'},'Title (optional)'),h('input',{type:'text',maxlength:'100',value:F.title,placeholder:'e.g. Calling out the champ',oninput:e=>{F.title=e.target.value;}})),
        h('div',{class:'f'},h('label',{class:'l'},'This is'),h('select',{onchange:e=>{F.mode=e.target.value;bodyIn.placeholder=F.mode==='idea'?'Describe what you’d like to happen…':'Write the exact text you want used…';}},
          h('option',{value:'idea',selected:F.mode==='idea'},'Just an idea'),h('option',{value:'text',selected:F.mode==='text'},'Actual text I want used'))),
        h('div',{class:'f'},h('label',{class:'l'},'Preferred show (optional)'),h('select',{onchange:e=>{F.eventId=e.target.value;}},h('option',{value:''},'Any show'),evs.map(e=>h('option',{value:e.id,selected:F.eventId===e.id},(e.title||'Show')+' · '+fmtDate(e.date).replace(/^\w+, /,'').replace(/, \d{4}$/,'')))))),
      h('div',{class:'f'},h('label',{class:'l'},'Others involved (optional)'),chips),
      h('div',{class:'f'},h('label',{class:'l'},'Your idea or text'),bodyIn),
      h('div',{class:'row'},
        h('button',{class:'btn',type:'button',disabled:full,onclick:async()=>{
          if(!F.body.trim()){ toast('Write your idea or text first.',true); return; }
          const payload={type:F.type,title:F.title.trim(),mode:F.mode,body:F.body.trim(),involved:F.involved,eventId:F.eventId};
          const ok=await safe(()=>editId?api('PUT','/submissions/'+editId,payload):api('POST','/submissions',payload),editId?'Changes saved.':'Sent to the CEO!');
          if(ok){ Object.assign(F,{type:'promo',title:'',mode:'idea',body:'',involved:[],eventId:''}); editId=null; await loadSubs(); S.editing=false; drawAll(); }
        }},editId?'Save changes':'Send to the CEO'),
        editId?h('button',{class:'btn alt',type:'button',onclick:()=>{ Object.assign(F,{type:'promo',title:'',mode:'idea',body:'',involved:[],eventId:''}); editId=null; drawAll(); }},'Cancel edit'):null,
        h('span',{class:'hint'},'The CEO decides what airs. Only you and the CEO can see your submissions.'))));
  }
  function drawList(){
    listBox.replaceChildren(h('div',{class:'sect-h',style:'margin-top:24px'},h('h2',{},'My Submissions')));
    const list=mine();
    if(!list.length){ listBox.append(h('div',{class:'empty'},'Nothing submitted yet. Pitch your first segment above.')); return; }
    list.forEach(x=>listBox.append(h('div',{class:'seg sub'},
      h('div',{class:'seg-h'},h('span',{class:'tag navy'},SUB_TYPES[x.type]||'Segment'),h('span',{class:'tag'},x.mode==='text'?'Text':'Idea'),subStatusTag(x),h('span',{class:'hint'},subDate(x.createdAt))),
      x.title?h('div',{class:'cond',style:'font-size:20px;font-weight:600;color:var(--blue)'},x.title):null,
      x.involved.length?h('div',{class:'hint',style:'margin:2px 0'},'With '+x.involved.map(wname).join(', ')):null,
      h('div',{class:'bio',style:'color:var(--text);margin-top:4px'},x.body),
      x.note?h('div',{class:'sub-note'},h('b',{},'CEO: '),x.note):null,
      x.status==='pending'?h('div',{class:'row',style:'margin-top:8px'},
        h('button',{class:'btn alt sm',type:'button',onclick:()=>{ editId=x.id; Object.assign(F,{type:x.type,title:x.title,mode:x.mode,body:x.body,involved:x.involved.slice(),eventId:x.eventId}); S.editing=true; drawAll(); window.scrollTo({top:0,behavior:'smooth'}); }},'Edit'),
        h('button',{class:'btn danger sm',type:'button',onclick:()=>confirmDlg('Withdraw this submission?','It will be removed.','Withdraw',async()=>{ if(await safe(()=>api('DELETE','/submissions/'+x.id),'Withdrawn.')){ await loadSubs(); drawAll(); } })},'Withdraw')):null)));
  }
  function drawAll(){ drawForm(); drawList(); }
  wrap.append(h('div',{class:'sect-h'},h('h2',{},'Superstar Hub'),h('div',{class:'sp'}),h('span',{class:'tag draft'},'Private · '+me.ringName)),
    h('div',{class:'hint',style:'margin:-6px 0 12px'},'Pitch promos, backstage scenes and other segments for your wrestler. Send a rough idea or the exact words you want. The CEO reads everything and decides what makes the show.'),
    formBox,listBox);
  drawAll();
  loadSubs().then(()=>{ if(!editId) drawAll(); });
  return wrap;
}

function subInbox(){
  const box=h('div',{class:'sect'});
  const fresh=new Set((S.subs||[]).filter(x=>!x.seen).map(x=>x.id));
  let filter=fresh.size?'pending':'all';
  const body=h('div',{});
  const FILTERS=[['pending','Waiting'],['approved','Approved'],['all','All']];
  const bar=h('div',{class:'row',style:'margin:0 0 10px'});
  function draw(){
    bar.replaceChildren(...FILTERS.map(([k,l])=>h('button',{type:'button',class:'fchip'+(filter===k?' on':''),onclick:()=>{filter=k;draw();}},l+' ('+(S.subs||[]).filter(x=>k==='all'||x.status===k).length+')')));
    body.replaceChildren();
    const list=(S.subs||[]).filter(x=>filter==='all'||x.status===filter);
    if(!list.length){ body.append(h('div',{class:'empty'},filter==='pending'?'No submissions waiting.':'Nothing here.')); return; }
    list.forEach(x=>{
      const noteIn=h('input',{type:'text',style:'flex:1;min-width:200px',placeholder:'Reply to the player (optional)',value:x.note||''});
      const act=(status,msg)=>async()=>{
        if(await safe(()=>api('PUT','/submissions/'+x.id,{status,note:noteIn.value}),msg)){ await loadSubs(); renderNav(route()); draw(); }
      };
      const evSel=h('select',{style:'width:auto'},h('option',{value:''},'Add to a show…'),
        Object.entries(S.events).map(([id,e])=>({id,...e})).filter(e=>(e.date||'')>=todayISO()).sort((a,b)=>(a.date||'').localeCompare(b.date||'')).map(e=>h('option',{value:e.id,selected:x.eventId===e.id},(e.title||'Show')+' · '+(e.date||''))));
      body.append(h('div',{class:'seg sub'},
        h('div',{class:'seg-h'},
          fresh.has(x.id)?h('span',{class:'tag red'},'NEW'):null,
          h('a',{href:'#wrestler-'+x.wrestlerId,style:'font-weight:700'},wname(x.wrestlerId)),
          h('span',{class:'tag navy'},SUB_TYPES[x.type]||'Segment'),h('span',{class:'tag'},x.mode==='text'?'Actual text':'Idea'),subStatusTag(x),
          S.events[x.eventId]?h('span',{class:'tag'},'Wants: '+(S.events[x.eventId].title||'a show')):null,
          h('span',{class:'hint'},subDate(x.createdAt))),
        x.title?h('div',{class:'cond',style:'font-size:20px;font-weight:600;color:var(--blue)'},x.title):null,
        x.involved.length?h('div',{class:'hint',style:'margin:2px 0'},'With '+x.involved.map(wname).join(', ')):null,
        h('div',{class:'bio',style:'color:var(--text);margin-top:4px'},x.body),
        h('div',{class:'row',style:'margin-top:10px'},noteIn),
        h('div',{class:'row',style:'margin-top:8px'},
          x.status!=='used'?[
            h('button',{class:'btn sm',type:'button',disabled:x.status==='approved',onclick:act('approved','Approved.')},'Approve'),
            h('button',{class:'btn danger sm',type:'button',disabled:x.status==='declined',onclick:act('declined','Declined.')},'Decline'),
            x.status==='approved'?h('button',{class:'btn alt sm',type:'button',onclick:act('pending','Moved back to waiting.')},'Back to waiting'):null,
            x.status==='approved'&&x.mode==='text'?h('button',{class:'btn sm',type:'button',title:'Preview a cleaned-up version in the show’s style',onclick:()=>{
              if(!evSel.value){toast('Pick a show first so the AI knows the card.',true);return;}
              const ev=S.events[evSel.value]; if(!ev){return;}
              const d=JSON.parse(JSON.stringify(ev)); S.polished=S.polished||{}; delete S.polished[x.id];
              const seg0=segFromSub(x); d.segments=(d.segments||[]).map(z=>({beats:[],sides:[],...z})); d.segments.push(seg0);
              polishDialog(d,d.segments.length-1,seg0.beats,nb=>{ S.polished[x.id]=nb.map(b=>b.text).join('\n\n'); toast('Polished version saved. Add to card will use it.'); draw(); });
            }},S.polished&&S.polished[x.id]?'✨ Polished ✓':'✨ Polish with AI'):null,
            evSel,
            h('button',{class:'btn alt sm',type:'button',onclick:()=>{ if(!evSel.value){toast('Pick a show first.',true);return;} S.addSub=x.id; navTo('ceo-edit-'+evSel.value); }},'Add to card')
          ]:h('span',{class:'hint'},'Already on a card.'),
          note_save(x,noteIn))));
    });
  }
  function note_save(x,noteIn){ return h('button',{class:'btn alt sm',type:'button',onclick:async()=>{ if(await safe(()=>api('PUT','/submissions/'+x.id,{status:x.status,note:noteIn.value}),'Reply saved.')){ await loadSubs(); draw(); } }},'Save reply'); }
  box.append(h('div',{class:'sect-h'},h('h2',{},'Player Submissions'),h('div',{class:'sp'}),unseenSubs()?h('span',{class:'tag red'},unseenSubs()+' new'):null),bar,body);
  draw();
  if(fresh.size) api('POST','/submissions/seen',{ids:[...fresh]}).then(()=>{ (S.subs||[]).forEach(x=>{ if(fresh.has(x.id)) x.seen=true; }); renderNav(route()); }).catch(()=>{});
  return box;
}
// Turn an approved submission into a segment in the event being edited.
function segFromSub(x){
  const paras=x.mode==='text'?((S.polished&&S.polished[x.id])||x.body).split(/\n\s*\n/).map(t=>t.trim()).filter(Boolean):[];
  const beats=paras.map(t=>({text:t.slice(0,1200),pause:0,cue:''}));
  const words=beats.reduce((n,b)=>n+wordCount(b.text),0);
  const sides=[[x.wrestlerId,...x.involved].filter(w=>S.wrestlers[w])];
  return {id:uid8(),type:x.type,title:x.title||'',stip:'',sub:x.id,
    desc:x.mode==='idea'?'Player idea from '+wname(x.wrestlerId)+': '+x.body:'Text submitted by '+wname(x.wrestlerId)+' (edit as needed).',
    sides,length:beats.length?Math.max(1,Math.min(30,Math.ceil(words/WORDS_PER_MIN))):defLength(x.type),beats,result:{winner:null,finish:''}};
}

/* ----- event editor ----- */
function newEvent(){ return {title:'Monday Night Mayhem', date:nextMonday(), time:'20:00', tz:'ET', venue:'', city:'', notes:'', published:false, segments:[]}; }
function pageEditEvent(id){
  if(!S.isCEO) return h('div',{class:'empty'},'The CEO Office is for the CEO only.');
  if(id && !S.events[id]) return h('div',{class:'empty'},'Event not found.');
  const d=id?JSON.parse(JSON.stringify(S.events[id])):newEvent();
  d.segments=(d.segments||[]).map(s=>({id:s.id||uid8(), type:s.type||'match', title:s.title||'', stip:s.stip||'', desc:s.desc||'', sides:(s.sides&&s.sides.length)?s.sides:[[],[]], length:Number(s.length)>=1?Number(s.length):defLength(s.type||'match'), beats:(s.beats||[]).map(b=>({text:b.text||'',pause:b.pause||0,cue:b.cue||''})), result:{winner:(s.result&&Number.isInteger(s.result.winner))?s.result.winner:null,finish:(s.result&&s.result.finish)||''}, sub:s.sub||''}));
  S.draft=d; S.editing=true;
  const segBox=h('div',{});
  const subsBox=h('div',{});
  const titleField=field('title','Show title');
  function field(k,label,type,ph){ return h('div',{class:'f'},h('label',{class:'l'},label),h('input',{type:type||'text',value:d[k]||'',placeholder:ph||'',oninput:e=>{d[k]=e.target.value;}})); }
  function drawSegs(){
    segBox.replaceChildren();
    if(!d.segments.length) segBox.append(h('div',{class:'empty'},'No segments yet. Add a match, promo, or backstage scene below.'));
    d.segments.forEach((s,i)=>segBox.append(segEditor(s,i)));
    updateTotal(); drawSubs();
  }
  function drawSubs(){
    subsBox.replaceChildren();
    const list=(S.subs||[]).filter(x=>x.status==='approved'&&!d.segments.some(s=>s.sub===x.id));
    if(!list.length) return;
    subsBox.append(h('div',{class:'sect-h',style:'margin-top:26px'},h('h2',{},'Approved Player Submissions'),h('div',{class:'sp'}),h('span',{class:'tag navy'},list.length)),
      h('div',{class:'hint',style:'margin:-6px 0 12px'},'Add one to the card as a segment. Text submissions become script beats; ideas go in “What happens”, so Draft with AI can build on them.'),
      ...list.map(x=>h('div',{class:'seg sub'},
        h('div',{class:'seg-h'},h('b',{},wname(x.wrestlerId)),h('span',{class:'tag navy'},SUB_TYPES[x.type]||'Segment'),h('span',{class:'tag'},x.mode==='text'?'Actual text':'Idea'),x.title?h('span',{class:'cond'},x.title):null),
        h('div',{class:'bio',style:'color:var(--text)'},x.body.length>400?x.body.slice(0,400)+'…':x.body),
        h('div',{class:'row',style:'margin-top:8px'},h('button',{class:'btn sm',type:'button',onclick:()=>{ d.segments.push(segFromSub(x)); drawSegs(); toast('Added to the card.'); }},'+ Add to card')))));
  }
  function segEditor(s,i){
    const isMatch=s.type==='match';
    const sidesBox=h('div',{});
    const resultBox=h('div',{class:'f',style:'margin-top:10px'});
    function drawResult(){
      if(!isMatch) return;
      s.result=s.result||{winner:null,finish:''};
      if(Number.isInteger(s.result.winner)&&s.result.winner>=s.sides.length) s.result.winner=null;
      resultBox.replaceChildren(h('label',{class:'l'},'Result (CEO only — the AI follows it; never shown publicly)'),
        h('div',{class:'row'},
          h('div',{style:'min-width:220px'},h('select',{onchange:e=>{ const v=e.target.value; s.result.winner=v===''?null:v==='draw'?-1:Number(v); }},
            h('option',{value:''},'— not decided —'),
            s.sides.map((side,si)=>side.length?h('option',{value:String(si),selected:s.result.winner===si},andList(side.map(wname))+' win'):null),
            h('option',{value:'draw',selected:s.result.winner===-1},'Draw / no contest'))),
          h('input',{type:'text',style:'flex:1;min-width:200px',placeholder:'Finish (optional), e.g. pinfall after the Hammond Slam',value:s.result.finish||'',oninput:e=>{s.result.finish=e.target.value;}})));
    }
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
      drawResult();
    }
    const isIntro=s.type==='show_intro';
    const typeSel=h('select',{disabled:isIntro,onchange:e=>{ s.type=e.target.value; if(s.type!=='match') s.sides=[s.sides.flat()]; else if(s.sides.length<2) s.sides.push([]); drawSegs(); }},
      Object.entries(SEG_TYPES).filter(([k])=>k!=='show_intro'||isIntro).map(([k,l])=>h('option',{value:k,selected:s.type===k},l)));
    const el=h('div',{class:'seg '+s.type},
      h('div',{class:'row',style:'margin-bottom:10px'},
        h('span',{class:'cond',style:'font-weight:700;color:var(--muted)'},'#'+(i+1)),
        h('div',{style:'width:230px'},typeSel),
        isMatch?null:h('span',{class:'tag draft'},'Hidden from public'),
        h('div',{style:'flex:1'}),
        h('button',{type:'button',class:'btn alt sm',disabled:i===0||isIntro||d.segments[i-1].type==='show_intro',onclick:()=>{[d.segments[i-1],d.segments[i]]=[d.segments[i],d.segments[i-1]];drawSegs();}},'↑'),
        h('button',{type:'button',class:'btn alt sm',disabled:isIntro||i===d.segments.length-1,onclick:()=>{[d.segments[i+1],d.segments[i]]=[d.segments[i],d.segments[i+1]];drawSegs();}},'↓'),
        h('button',{type:'button',class:'btn danger sm',onclick:()=>{d.segments.splice(i,1);drawSegs();}},'Remove')),
      h('div',{class:'cols'},
        h('div',{class:'f'},h('label',{class:'l'},isMatch?'Match title (optional)':'Segment title'),h('input',{type:'text',value:s.title,placeholder:isMatch?'e.g. USCW Championship':'e.g. Contract signing',oninput:e=>{s.title=e.target.value;}})),
        isMatch?h('div',{class:'f'},h('label',{class:'l'},'Stipulation'),h('input',{type:'text',value:s.stip,placeholder:'e.g. Steel Cage, No DQ, 30-min Iron Man',oninput:e=>{s.stip=e.target.value;}})):null),
      sidesBox,
      h('div',{class:'f',style:'margin-top:10px'},h('label',{class:'l'},isMatch?'Notes / storyline':'What happens'),h('textarea',{placeholder:isMatch?'Build-up, rivalry, what\'s at stake…':'Describe the in-ring or backstage event…',oninput:e=>{s.desc=e.target.value;}},s.desc)),
      isMatch?resultBox:null);
    drawSides();
    if(isIntro) el.replaceChildren(el.firstChild);
    // ---- length + script ----
    const isPreset=()=>LENGTHS.some(l=>l[0]===s.length);
    const customIn=h('input',{type:'number',min:'1',max:'30',style:'width:80px',value:s.length,oninput:e=>{ s.length=Math.max(1,Math.min(30,Math.round(Number(e.target.value))||1)); updateScript(); updateTotal(); }});
    const lenSel=h('select',{style:'width:auto',onchange:e=>{
      if(e.target.value==='custom'){ customWrap.style.display=''; }
      else { s.length=Number(e.target.value); customWrap.style.display='none'; customIn.value=s.length; updateScript(); updateTotal(); }
    }}, LENGTHS.map(l=>h('option',{value:l[0],selected:s.length===l[0]},l[1])), h('option',{value:'custom',selected:!isPreset()},'Custom…'));
    const customWrap=h('span',{style:'display:'+(isPreset()?'none':'')},customIn,' minutes');
    const aiLabel=isIntro?'✨ Polish with AI':'✨ Draft with AI';
    const aiBtn=h('button',{type:'button',class:'btn sm',title:'Gemini writes this segment from the wrestlers’ profiles, storylines and the rest of the card'});
    aiBtn.textContent=aiLabel;
    const aiGo=async()=>{
      const idx=d.segments.indexOf(s);
      aiBtn.disabled=true; aiBtn.textContent='Writing…';
      try{ const r=await aiRun(d,idx); drawSegs(); toast('Draft ready'+(r.fellBack?' (written by the backup model)':'')+'. Review and edit each beat, then save the show.'); }
      catch(e){ toast((e&&e.message)||'The AI writer failed.',true); aiBtn.disabled=false; aiBtn.textContent=aiLabel; }
    };
    aiBtn.addEventListener('click',()=>{
      if(isMatch&&!Number.isInteger(s.result&&s.result.winner)){ toast('Pick the match result first. The AI follows it.',true); return; }
      if(!isIntro&&s.beats.some(b=>(b.text||'').trim())) confirmDlg('Replace the text?','The AI draft replaces the beats below. Any edits you made to them will be lost.','Replace',aiGo); else aiGo();
    });
    const polishBtn=(s.sub&&!isMatch&&!isIntro)?h('button',{type:'button',class:'btn sm',title:'Gemini cleans up the player’s text so it matches the rest of the show',onclick:()=>{
      const idx=d.segments.indexOf(s);
      if(!s.beats.some(b=>(b.text||'').trim())){ toast('There is no text to polish yet.',true); return; }
      polishDialog(d,idx,s.beats,nb=>{ s.beats=nb; drawSegs(); toast('Polished text applied. Review it, then save the show.'); });
    }},'✨ Polish with AI'):null;
    const beatsBox=h('div',{});
    const scriptInfo=h('span',{class:'hint'});
    function updateScript(){
      const words=s.beats.reduce((n,b)=>n+wordCount(b.text),0), target=s.length*WORDS_PER_MIN;
      scriptInfo.textContent=s.beats.length+' beat'+(s.beats.length===1?'':'s')+' · '+words+' words · target about '+target+' words for '+s.length+' min';
    }
    const grow=t=>{ t.style.height='auto'; if(t.scrollHeight>t.clientHeight) t.style.height=(t.scrollHeight+4)+'px'; };
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
            h('button',{class:'btn alt sm',type:'button',title:'Play this sound (silent if its file has not been added yet)',onclick:async()=>{
              await sndLoad(); sndUnlock();
              if(!b.cue){ toast('Pick a sound first.',true); return; }
              if(!sndPlay(b.cue,true)) toast('No sound file for this one yet. See docs/audio/README.md.',true);
            }},'▶ Test'),
            h('label',{class:'hint',style:'display:flex;gap:6px;align-items:center'},'Pause after',h('input',{type:'number',min:'0',max:'30',value:b.pause||0,style:'width:64px',oninput:e=>{ b.pause=Math.max(0,Math.min(30,Math.round(Number(e.target.value))||0)); }}),'sec'),
            h('div',{style:'flex:1'}),
            h('button',{type:'button',class:'btn alt sm',disabled:bi===0,onclick:()=>{[s.beats[bi-1],s.beats[bi]]=[s.beats[bi],s.beats[bi-1]];drawBeats();}},'↑'),
            h('button',{type:'button',class:'btn alt sm',disabled:bi===s.beats.length-1,onclick:()=>{[s.beats[bi+1],s.beats[bi]]=[s.beats[bi],s.beats[bi+1]];drawBeats();}},'↓'),
            h('button',{type:'button',class:'btn danger sm',onclick:()=>{s.beats.splice(bi,1);drawBeats();updateScript();}},'×')),
          (()=>{ const ta=h('textarea',{maxlength:'1200',placeholder:'A few sentences of the action…',oninput:e=>{ b.text=e.target.value; grow(ta); updateScript(); }},b.text); requestAnimationFrame(()=>grow(ta)); return ta; })()));
      });
      updateScript();
    }
    drawBeats();
    if(isIntro){
      const doDraft=()=>{ const r=draftIntro(d); s.beats=r.beats; s.length=r.length; drawSegs(); toast('Intro drafted. Review and edit each beat, then save the show.'); };
      el.append(h('div',{class:'intro-note'},
        h('p',{},'The show opens with the '+((d.ple&&/./.test(d.title||''))?'show':'Monday Night Mayhem')+' logo, then the crowd pans, the theme music plays and Mike Johnson welcomes the audience and runs down the night. Build the rest of the card first, then draft this so the rundown matches it.'),
        h('div',{class:'row'},
          h('button',{type:'button',class:'btn sm',onclick:()=>{ if(s.beats.some(b=>(b.text||'').trim())) confirmDlg('Redraft the intro?','This replaces the beats below with a fresh draft. Any edits you made to them will be lost.','Redraft',doDraft); else doDraft(); }},'✎ Draft Intro'),
          h('span',{class:'hint'},'Uses the matches, stakes, appearances and each wrestler’s storyline. You can edit everything afterwards.'))));
    }
    el.append(h('div',{class:'script'},
      h('div',{class:'row',style:'margin-bottom:8px'},
        h('span',{class:'cond',style:'font-weight:700;color:var(--navy)'},'Length'), lenSel, customWrap, aiBtn, polishBtn,
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
    Object.entries(SEG_TYPES).map(([k,l])=>h('button',{type:'button',class:'btn alt sm',onclick:()=>{ const seg={id:uid8(),type:k,title:'',stip:'',desc:'',sides:k==='match'?[[],[]]:[[]],length:defLength(k),beats:[],result:{winner:null,finish:''}};
      if(k==='show_intro'){ if(d.segments.some(x=>x.type==='show_intro')){toast('This show already has a Show Intro.',true);return;} d.segments.unshift(seg); } else d.segments.push(seg); drawSegs(); }},'+ '+l)));
  if(S.addSub){
    const x=(S.subs||[]).find(y=>y.id===S.addSub); S.addSub=null;
    if(x&&x.status!=='used'&&!d.segments.some(sg=>sg.sub===x.id)){ d.segments.push(segFromSub(x)); drawSegs(); toast('Submission added to the card.'); }
  }
  async function save(publish){
    if(!d.title.trim()){ toast('Give the show a title.',true); return; }
    if(!d.date){ toast('Pick a date for the show.',true); return; }
    const evId=id||('e'+Date.now().toString(36)+Math.random().toString(36).slice(2,5));
    const data={title:d.title.trim(), date:d.date, time:d.time||'', tz:(d.tz||'').trim(), venue:(d.venue||'').trim(), city:(d.city||'').trim(), notes:(d.notes||'').trim(),
      published: publish===null ? !!d.published : publish, ple: !!d.ple,
      segments:d.segments.map(s=>({id:s.id,type:s.type,title:s.title.trim(),stip:s.type==='match'?s.stip.trim():'',desc:s.desc.trim(),sides:s.sides.map(x=>x.filter(w=>S.wrestlers[w])),length:Number(s.length)||defLength(s.type),beats:(s.beats||[]).filter(b=>(b.text||'').trim()||b.cue).map(b=>({text:(b.text||'').trim(),pause:b.pause||0,cue:b.cue||''})),result:s.type==='match'?{winner:Number.isInteger(s.result&&s.result.winner)?s.result.winner:null,finish:((s.result&&s.result.finish)||'').trim()}:null,sub:s.sub||''})),
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
    h('div',{class:'row',style:'margin-bottom:12px'},
      h('button',{class:'btn',type:'button',onclick:()=>wholeCardDialog(d,drawSegs)},'✨ Draft whole card with AI'),
      h('span',{class:'hint'},'Writes every segment you tick, in order, so you mostly just review and edit.')),
    segBox, addBtns, subsBox,
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
    case 'hub': el=pageHub(); break;
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
function clearAuth(){ S.subs=[]; S.polished={}; S.token=null; S.user=null; S.uid=null; S.isCEO=false; S.canWrite=false; try{localStorage.removeItem(TOKEN_KEY);}catch(e){} }
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
  if(S.isCEO){ try{ S.story=(await api('GET','/story')).stories||{}; }catch(_){} await loadSubs(); } else S.story={};
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

/* ----- "a new version is available" check ----- */
// The site is a set of static files. version.json carries the version of the latest release; if it differs from the
// version this page loaded with, offer a reload. Never reloads by itself, so nobody loses their place mid-show.
(function watchVersion(){
  const LOADED=window.USCW_VERSION||'';
  if(!LOADED) return;
  try{ if(/[?&]v=/.test(location.search)) history.replaceState(null,'',location.pathname+location.hash); }catch(_){}
  let later=0, shownFor='';
  function banner(newV){
    let el=document.getElementById('upd');
    if(!el){
      el=h('div',{id:'upd',class:'upd',role:'status'});
      document.body.append(el);
    }
    el.replaceChildren(
      h('span',{class:'upd-msg'},S.editing?'A new version of USCW is available. Save your work first, then reload.':'A new version of USCW is available.'),
      h('button',{class:'btn sm',type:'button',onclick:()=>{ location.href=location.pathname+'?v='+encodeURIComponent(newV)+location.hash; }},'Reload'),
      h('button',{class:'btn alt sm',type:'button',onclick:()=>{ later=Date.now()+30*60*1000; el.remove(); }},'Later'));
    shownFor=newV;
  }
  async function check(){
    if(Date.now()<later) return;
    try{
      const r=await fetch('version.json?t='+Date.now(),{cache:'no-store'});
      if(!r.ok) return;
      const j=await r.json();
      if(j&&typeof j.version==='string'&&j.version&&j.version!==LOADED){
        if(shownFor!==j.version||!document.getElementById('upd')) banner(j.version);
        else { const m=document.querySelector('#upd .upd-msg'); if(m) m.textContent=S.editing?'A new version of USCW is available. Save your work first, then reload.':'A new version of USCW is available.'; }
      }
    }catch(_){ /* offline or not published yet: stay quiet */ }
  }
  setTimeout(check,4000);
  setInterval(check,5*60*1000);
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) check(); });
  window.__uscwCheckVersion=check;
})();
boot();
})();
