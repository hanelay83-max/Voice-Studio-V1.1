(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const text = $('#text-input'), style = $('#style-input'), cfg = $('#cfg');
  const provider = $('#provider');
  let mode = 'tts', fileData = null, busy = false, gradio = null;
  const clientCache = new Map();
  const refCache = new Map();
  const HF_ACCOUNTS_KEY = 'myvoice-hf-accounts-session';
  const HF_SELECTED_KEY = 'myvoice-hf-selected-session';
  const MAX_CHARS = 200000;
  const CHUNK_CHARS = 480;
  const RETRIES = 2;
  const PROVIDERS = {
    voxcpm: 'openbmb/VoxCPM-Demo',
    omnivoice: 'k2-fsa/OmniVoice'
  };

  const setStatus = (message, kind = '') => { const el = $('#status'); el.textContent = message; el.className = `status ${kind}`; };
  const setBusy = value => { busy = value; $('#generate').disabled = value; $('#spinner').hidden = !value; $('#generate-label').hidden = value; document.querySelectorAll('.tab,.chip,#provider').forEach(x => x.disabled = value); };
  const progress = (pct, msg) => { $('#progress-wrap').hidden = false; $('#progress-bar').style.width = `${Math.max(0, Math.min(100,pct))}%`; $('#progress-text').textContent = msg || `${Math.round(pct)}%`; };
  const hideProgress = () => { $('#progress-wrap').hidden = true; $('#progress-bar').style.width='0%'; };

  text.addEventListener('input', () => $('#char-count').textContent = text.value.length.toLocaleString());
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    if (busy) return;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); btn.classList.add('active'); mode = btn.dataset.mode;
    $('#tts-options').hidden = mode !== 'tts'; $('#clone-options').hidden = mode !== 'clone';
    if (mode === 'clone' && provider.value === 'voxcpm') setStatus('Reference အသံဖိုင်တင်ပြီး Generate လုပ်နိုင်ပါပြီ');
    else setStatus(mode === 'clone' ? 'Reference အသံဖိုင်တင်ပါ' : 'စာသားနှင့် အသံပုံစံထည့်ပါ');
  }));
  document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => { style.value = chip.dataset.style; style.focus(); }));
  document.querySelectorAll('[data-sample]').forEach(x => x.addEventListener('click', () => { text.value = x.dataset.sample; text.dispatchEvent(new Event('input')); }));
  $('#clear-text').addEventListener('click', () => { text.value = ''; text.dispatchEvent(new Event('input')); text.focus(); });
  cfg.addEventListener('input', () => $('#cfg-value').textContent = Number(cfg.value).toFixed(1));
  $('#toggle-advanced').addEventListener('click', () => { const b = $('#advanced-body'); b.hidden = !b.hidden; $('#toggle-advanced').textContent = b.hidden ? 'ဖွင့်မည်' : 'ပိတ်မည်'; });
  const fmt = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(2)} MB`;

  function readHFAccounts() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(HF_ACCOUNTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(x => x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.token === 'string') : [];
    } catch { return []; }
  }
  function writeHFAccounts(list) {
    try { sessionStorage.setItem(HF_ACCOUNTS_KEY, JSON.stringify(list)); } catch {}
  }
  function getSelectedHFId() {
    try { return sessionStorage.getItem(HF_SELECTED_KEY) || ''; } catch { return ''; }
  }
  function setSelectedHFId(id) {
    try { if (id) sessionStorage.setItem(HF_SELECTED_KEY, id); else sessionStorage.removeItem(HF_SELECTED_KEY); } catch {}
  }
  function getHFToken() {
    const id = getSelectedHFId();
    if (!id) return '';
    return readHFAccounts().find(x => x.id === id)?.token || '';
  }
  function refreshHFAccountUI() {
    const select = $('#hf-account');
    const remove = $('#remove-hf-account');
    if (!select) return;
    const accounts = readHFAccounts();
    const selected = getSelectedHFId();
    select.innerHTML = '<option value="">Anonymous / မချိတ်ထားပါ</option>' + accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('');
    select.value = accounts.some(a => a.id === selected) ? selected : '';
    if (select.value !== selected) setSelectedHFId('');
    if (remove) remove.disabled = !select.value;
  }
  function resetHFConnection(message='HF account ပြောင်းပြီးပါပြီ') {
    clientCache.clear();
    refCache.clear();
    if (message) setStatus(message);
  }

  function isQuotaError(error) {
    const msg = String(error?.message || error || '');
    return /ZeroGPU quota|quota exceeded|requested vs\.?.*left|Authenticate with a Hugging Face token/i.test(msg);
  }

  function quotaMessage(error) {
    const msg = String(error?.message || error || '');
    const match = msg.match(/Try again in ([^.]+)\./i);
    return match
      ? `Hugging Face ZeroGPU quota မလုံလောက်ပါ။ ${match[1]} နောက်မှ ပြန်စမ်းပါ။ HF Token ထည့်ထားရင် သင့် account quota ကို အသုံးပြုနိုင်ပါတယ်။`
      : 'Hugging Face ZeroGPU quota မလုံလောက်ပါ။ HF Token ထည့်ထားရင် သင့် account quota ကို အသုံးပြုနိုင်ပါတယ်။';
  }

  async function getClient(name) {
    if (!gradio) gradio = await import('https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js');
    if (!clientCache.has(name)) {
      const token = getHFToken();
      const options = token ? { hf_token: token } : undefined;
      clientCache.set(name, gradio.Client.connect(name, options));
    }
    return clientCache.get(name);
  }

  function getRefArg(client, ref, space) {
    if (!ref) return null;
    const key = `${space}|${ref.name}|${ref.size}|${ref.lastModified}`;
    if (!refCache.has(key)) refCache.set(key, gradio.handle_file(ref));
    return refCache.get(key);
  }

  async function upload(file) {
    if (!file || !file.type.startsWith('audio/')) throw Error('Audio ဖိုင်သာ ရွေးချယ်ပါ');
    if (file.size > 20*1024*1024) throw Error('ဖိုင်အရွယ်အစား 20MB ထက်မကျော်ရ');
    fileData = file;
    $('#file-title').textContent = file.name;
    $('#file-meta').textContent = `${fmt(file.size)} • အသုံးပြုရန်အဆင်သင့်`;
    $('#remove-file').hidden = false;
    setStatus('အသံဖိုင် အဆင်သင့်ဖြစ်ပါပြီ','ok');
  }
  const chooseFile = async file => { try { await upload(file); } catch(e) { fileData=null; setStatus(e.message,'error'); } };
  $('#audio-input').addEventListener('change', e => chooseFile(e.target.files[0]));
  const dz = $('#dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor='var(--cyan)'; });
  dz.addEventListener('dragleave', () => dz.style.borderColor='');
  dz.addEventListener('drop', e => { e.preventDefault(); dz.style.borderColor=''; chooseFile(e.dataTransfer.files[0]); });
  $('#remove-file').addEventListener('click', () => { fileData=null; $('#audio-input').value=''; $('#file-title').textContent='အသံဖိုင်ရွေးပါ သို့မဟုတ် ဆွဲချပါ'; $('#file-meta').textContent='WAV, MP3, OGG • 20MB အထိ'; $('#remove-file').hidden=true; });

  function splitText(input, max=CHUNK_CHARS) {
    const s = input.trim(); if (!s) return [];
    const out=[]; let rest=s;
    const boundary = /[။!?！？\n]+/g;
    while (rest.length > max) {
      const window = rest.slice(0,max+1);
      let cut = -1, m;
      boundary.lastIndex=0;
      while ((m=boundary.exec(window))) cut=m.index+m[0].length;
      if (cut < Math.floor(max*0.55)) {
        const spaces = [...window.matchAll(/[ \t]+/g)];
        if (spaces.length) cut = spaces[spaces.length-1].index;
      }
      if (cut <= 0) cut=max;
      out.push(rest.slice(0,cut).trim()); rest=rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }

  function spaceHost(space){ return `https://${space.replace('/', '-').toLowerCase()}.hf.space`; }
  function extractAudio(data, space) {
    let f = data?.data?.[0] ?? data?.[0] ?? data;
    if (Array.isArray(f) && f.length >= 2 && typeof f[0] === 'number') return { kind:'pcm', sampleRate:f[0], samples:f[1] };
    if (f && typeof f === 'object' && f.url) return { kind:'url', url:f.url };
    if (f && typeof f === 'object' && f.path) return { kind:'url', url:`${spaceHost(space)}/file=${encodeURIComponent(f.path)}` };
    if (typeof f === 'string') return { kind:'url', url:f.startsWith('http')?f:`${spaceHost(space)}/file=${encodeURIComponent(f)}` };
    throw Error('Audio output format ကို နားမလည်ပါ');
  }

  async function toBlob(audio, space) {
    if (audio.kind === 'url') { const r=await fetch(audio.url); if(!r.ok) throw Error(`Audio download HTTP ${r.status}`); return r.blob(); }
    return wavBlob(audio.samples, audio.sampleRate);
  }

  function wavBlob(samples, sampleRate) {
    const channels = samples.numberOfChannels || 1;
    const length = samples.length || 0;
    const view = new DataView(new ArrayBuffer(44 + length * channels * 2));
    const write=(o,s)=>{for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i));};
    write(0,'RIFF'); view.setUint32(4,36+length*channels*2,true); write(8,'WAVE'); write(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,channels,true); view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*channels*2,true); view.setUint16(32,channels*2,true); view.setUint16(34,16,true); write(36,'data'); view.setUint32(40,length*channels*2,true);
    let o=44; for(let i=0;i<length;i++){let v=Math.max(-1,Math.min(1,samples[i])); view.setInt16(o,v<0?v*32768:v*32767,true);o+=2;} return new Blob([view],{type:'audio/wav'});
  }

  async function mergeAudio(blobs) {
    if (blobs.length===1) return blobs[0];
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return new Blob(blobs,{type:blobs[0].type||'audio/mpeg'});
    const ctx = new AC();
    // Decode all chunks concurrently: decoding is local work and does not affect HF queue load.
    const decoded = await Promise.all(blobs.map(async b => ctx.decodeAudioData(await b.arrayBuffer())));
    const rate=decoded[0].sampleRate, channels=Math.max(...decoded.map(x=>x.numberOfChannels));
    const total=decoded.reduce((n,x)=>n+x.length,0); const out=ctx.createBuffer(channels,total,rate); let offset=0;
    for(const b of decoded){for(let ch=0;ch<channels;ch++) out.getChannelData(ch).set(b.getChannelData(Math.min(ch,b.numberOfChannels-1)),offset); offset+=b.length;}
    const samples=out.getChannelData(0); const wav=new ArrayBuffer(44+samples.length*2), view=new DataView(wav);
    const write=(o,s)=>{for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i));}; write(0,'RIFF');view.setUint32(4,36+samples.length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);let o=44;for(const v of samples){view.setInt16(o,Math.max(-1,Math.min(1,v))*32767,true);o+=2;} await ctx.close(); return new Blob([wav],{type:'audio/wav'});
  }

  async function generateVoxCPM(chunk, ref) {
    const client = await getClient(PROVIDERS.voxcpm);
    const refArg = mode==='clone' ? getRefArg(client, ref, PROVIDERS.voxcpm) : null;
    const result = await client.predict('/generate', [chunk, style.value.trim(), refArg, false, '', Number(cfg.value), $('#normalize').checked, $('#denoise').checked&&mode==='clone']);
    return extractAudio(result, PROVIDERS.voxcpm);
  }

  async function generateOmni(chunk, ref) {
    if (!ref) throw Error('OmniVoice cloning အတွက် reference audio လိုအပ်ပါတယ်');
    const client = await getClient(PROVIDERS.omnivoice);
    const refArg = getRefArg(client, ref, PROVIDERS.omnivoice);
    const result = await client.predict('/_clone_fn', [chunk, 'Burmese', refArg, '', style.value.trim(), 32, 2.0, true, 1.0, 0, true, true]);
    return extractAudio(result, PROVIDERS.omnivoice);
  }

  async function withRetry(fn, attempts=RETRIES) {
    let lastErr;
    for (let n=1; n<=attempts; n++) {
      try { return await fn(n); }
      catch (e) {
        lastErr=e;
        if (isQuotaError(e)) throw e;
        if (n<attempts) {
          setStatus(`ပြန်ကြိုးစားနေသည်… (${n+1}/${attempts})`);
          await new Promise(r=>setTimeout(r, 700*n));
        }
      }
    }
    throw lastErr || Error('Generate failed');
  }

  async function runLongText() {
    const chunks=splitText(text.value);
    if (!chunks.length) throw Error('ဖတ်မည့်စာသား ထည့်ပါ');
    const selected=provider.value;
    const engines = selected==='auto' ? (mode==='clone' ? ['voxcpm','omnivoice'] : ['voxcpm']) : [selected];
    // ZeroGPU quota is account-based. Parallel jobs can reserve multiple GPU durations at once
    // and exhaust a free quota almost immediately, so keep generation strictly sequential.
    const concurrency = 1;
    setStatus(`စာသား ${text.value.trim().length.toLocaleString()} characters → ${chunks.length} parts • quota-safe sequential mode`);

    // Warm the selected Space connections before starting the workers.
    await Promise.all(engines.map(e => getClient(PROVIDERS[e])));
    const results = new Array(chunks.length);
    let nextIndex = 0, completed = 0, fatal = null;
    // Keep a per-run disabled set. If one Space runs out of quota, stop sending
    // further chunks to it and automatically fail over to the next independent engine.
    // This is provider failover, not account/token rotation.
    const disabledEngines = new Set();

    async function worker(workerId){
      while (fatal === null) {
        const i = nextIndex++;
        if (i >= chunks.length) return;
        let success = false;
        for (const eng of engines) {
          if (disabledEngines.has(eng)) continue;
          try {
            if (eng==='omnivoice' && mode!=='clone') throw Error('OmniVoice fallback သည် Voice Cloning mode မှာပဲ သုံးပါမယ်');
            setStatus(`${eng==='voxcpm'?'VoxCPM2':'OmniVoice'} — အပိုင်း ${i+1}/${chunks.length} (${workerId})`);
            const audio=await withRetry(() => eng==='voxcpm' ? generateVoxCPM(chunks[i],fileData) : generateOmni(chunks[i],fileData));
            results[i]={blob:await toBlob(audio, eng==='voxcpm'?PROVIDERS.voxcpm:PROVIDERS.omnivoice),engine:eng};
            success=true;
            break;
          } catch(e) {
            if (isQuotaError(e)) {
              // Do not retry or rotate accounts. Disable this provider for the rest
              // of this run and let the next independent provider handle the chunk.
              disabledEngines.add(eng);
              const remaining = engines.filter(x => !disabledEngines.has(x) && !(x==='omnivoice' && mode!=='clone'));
              if (remaining.length) {
                setStatus(`${eng==='voxcpm'?'VoxCPM2':'OmniVoice'} quota မလုံလောက်ပါ — ${remaining[0]==='voxcpm'?'VoxCPM2':'OmniVoice'} သို့ auto fallback ပြောင်းနေသည်…`);
                continue;
              }
              fatal=Error(quotaMessage(e));
              return;
            }
            if (eng===engines.filter(x => !disabledEngines.has(x)).at(-1)) { fatal=e; return; }
            setStatus(`${eng==='voxcpm'?'VoxCPM2':'OmniVoice'} မအောင်မြင်ပါ — အခြား engine သို့ auto fallback ပြောင်းနေသည်…`);
          }
        }
        if (!success) {
          const available = engines.filter(x => !disabledEngines.has(x) && !(x==='omnivoice' && mode!=='clone'));
          if (!available.length && fatal === null) fatal=Error('အသုံးပြုနိုင်သော TTS engine မရှိတော့ပါ');
          if (fatal !== null) return;
        }
        if (success) {
          completed++;
          progress((completed/chunks.length)*100, `အပိုင်း ${completed}/${chunks.length} ပြီးပါပြီ`);
        }
      }
    }

    await Promise.all(Array.from({length:Math.min(concurrency,chunks.length)},(_,i)=>worker(i+1)));
    if (fatal) throw fatal;

    setStatus('အသံအပိုင်းများကို မြန်မြန်တစ်ဖိုင်တည်း ပြန်ပေါင်းနေသည်…');
    const blobs=results.map(x=>x.blob);
    const engineUsed = results.some(x=>x.engine==='voxcpm') ? 'voxcpm' : 'omnivoice';
    const finalBlob=await mergeAudio(blobs);
    return {blob:finalBlob, engine:engineUsed, chunks:chunks.length};
  }

  const showBlob = (blob, meta) => { const url=URL.createObjectURL(blob); const player=$('#audio-player'); player.src=url; player.load(); $('#download').disabled=false; $('#download').onclick=()=>{const a=document.createElement('a');a.href=url;a.download=`myanmar-voice-${Date.now()}.wav`;a.click();};$('#empty').hidden=true;$('#result').hidden=false;$('#mode-meta').textContent=`${meta.engine==='omnivoice'?'OmniVoice':'VoxCPM2'} • ${meta.chunks} parts`;$('#size-meta').textContent=fmt(blob.size);player.onloadedmetadata=()=>$('#duration-meta').textContent=`${Math.floor(player.duration/60)}:${String(Math.floor(player.duration%60)).padStart(2,'0')}`;const wave=$('#wave');wave.innerHTML='';for(let i=0;i<34;i++){const bar=document.createElement('i');bar.style.height=`${12+Math.random()*42}px`;wave.appendChild(bar);}saveHistory(text.value,meta);};

  // History is a real generation log: every successful Generate creates a new entry,
  // even when the same script is generated repeatedly. Keep up to 30 entries locally.
  const HISTORY_KEY='myvoice-history-v2';
  const HISTORY_LIMIT=30;
  const escapeHtml=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const readHistory=()=>{try{const raw=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');return Array.isArray(raw)?raw:[];}catch{return[];}};
  const saveHistory=(value,meta={})=>{
    const list=readHistory();
    list.unshift({
      id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      text:String(value),
      createdAt:new Date().toISOString(),
      chars:String(value).length,
      engine:meta.engine||'voxcpm',
      chunks:meta.chunks||1
    });
    localStorage.setItem(HISTORY_KEY,JSON.stringify(list.slice(0,HISTORY_LIMIT)));
    renderHistory();
  };
  const renderHistory=()=>{
    const list=readHistory();
    const box=$('#history-list');
    if(!list.length){box.innerHTML='<p class="muted">ဒီ browser ထဲမှာ Generate လုပ်ထားသမျှ မှတ်တမ်းတွေ ပေါ်လာပါမည်။</p>';return;}
    box.innerHTML=list.map((item,i)=>{
      const date=new Date(item.createdAt||Date.now());
      const time=Number.isNaN(date.getTime())?'':date.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const engine=item.engine==='omnivoice'?'OmniVoice':'VoxCPM2';
      const preview=String(item.text||'').replace(/\s+/g,' ').trim();
      return `<div class="history-entry"><button class="history-item" data-index="${i}" title="ပြန်ထည့်ရန်"><span class="history-preview">${escapeHtml(preview.slice(0,140))}${preview.length>140?'…':''}</span><small>${escapeHtml(time)} • ${Number(item.chars||preview.length).toLocaleString()} chars • ${engine}</small></button><button class="history-delete" data-delete="${i}" title="ဒီမှတ်တမ်းဖျက်မည်">×</button></div>`;
    }).join('');
    box.querySelectorAll('.history-item').forEach(b=>b.onclick=()=>{const item=readHistory()[Number(b.dataset.index)];if(!item)return;text.value=item.text||'';text.dispatchEvent(new Event('input'));text.focus();});
    box.querySelectorAll('.history-delete').forEach(b=>b.onclick=()=>{const list=readHistory();list.splice(Number(b.dataset.delete),1);localStorage.setItem(HISTORY_KEY,JSON.stringify(list));renderHistory();});
  };
  $('#clear-history').addEventListener('click',()=>{localStorage.removeItem(HISTORY_KEY);localStorage.removeItem('myvoice-history');renderHistory();});
  const hfAccountSelect = $('#hf-account');
  const addHFAccount = $('#add-hf-account');
  const removeHFAccount = $('#remove-hf-account');
  if (hfAccountSelect) {
    refreshHFAccountUI();
    hfAccountSelect.addEventListener('change', () => {
      if (busy) return;
      setSelectedHFId(hfAccountSelect.value);
      resetHFConnection(hfAccountSelect.value ? 'HF account ပြောင်းပြီးပါပြီ — ဒီ account ရဲ့ quota ကို အသုံးပြုမည်' : 'HF account ချိတ်ဆက်မှု ဖြုတ်ပြီးပါပြီ');
    });
  }
  if (addHFAccount) addHFAccount.addEventListener('click', () => {
    if (busy) return;
    const name = window.prompt('ဒီ HF account ကို ခေါ်မယ့်နာမည်ထည့်ပါ (ဥပမာ — My Free Account):');
    if (!name || !name.trim()) return;
    const token = window.prompt('ဒီ account ရဲ့ Hugging Face User Access Token (hf_...) ကို ထည့်ပါ:');
    if (!token || !token.trim()) return;
    const clean = token.trim();
    if (!/^hf_[A-Za-z0-9]+$/.test(clean)) return setStatus('HF Token ပုံစံမမှန်ပါ။ hf_ နဲ့ စတဲ့ User Access Token ထည့်ပါ။','error');
    const accounts = readHFAccounts();
    const id = `hf-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    accounts.push({id, name:name.trim(), token:clean});
    writeHFAccounts(accounts);
    setSelectedHFId(id);
    refreshHFAccountUI();
    resetHFConnection(`“${name.trim()}” account ကို ချိတ်ပြီးပါပြီ`);
  });
  if (removeHFAccount) removeHFAccount.addEventListener('click', () => {
    if (busy) return;
    const id = getSelectedHFId();
    if (!id) return;
    const accounts = readHFAccounts();
    const account = accounts.find(x => x.id === id);
    if (!account) return;
    if (!window.confirm(`“${account.name}” token ကို ဒီ browser session ကနေ ဖျက်မလား?`)) return;
    writeHFAccounts(accounts.filter(x => x.id !== id));
    setSelectedHFId('');
    refreshHFAccountUI();
    resetHFConnection('HF account token ကို ဖျက်ပြီးပါပြီ');
  });

  // ─────────────────────────────────────────────────────────────
  // VIDEO → MYANMAR TRANSCRIPT
  // Multi-engine Whisper fallback + URL + local video/audio upload.
  // The engines below are public Hugging Face Spaces. Their interfaces
  // are discovered at runtime, so endpoint changes are less fragile.
  // ─────────────────────────────────────────────────────────────
  const TRANSCRIPT_ENGINES = [
    {space:'openai/whisper', label:'Whisper Large V3'},
    {space:'Dauzy/whisper-webui', label:'Whisper WebUI (URL + File)'},
    {space:'dbredvick/whisper-webui', label:'Whisper WebUI Fallback'},
    {space:'hf-audio/whisper-large-v3', label:'Whisper Large V3 Fallback'}
  ];

  // YouTube URLs try external transcript services before Hugging Face Whisper.
  // This avoids the common yt-dlp cookie / "Sign in to confirm you're not a bot" failure.
  const EXTERNAL_YT_TRANSCRIPT = [
    {
      name:'YouTube Transcript AI',
      makeUrl:(id,lang)=>`https://youtube-transcript.ai/transcript/${id}.txt${lang?`?lang=${encodeURIComponent(lang)}`:''}`
    },
    {
      name:'YouTube Transcribe',
      makeUrl:(id,lang)=>`https://youtubetranscribe.khabaroff.studio/transcript/${id}/txt?auto=true&pretty=true${lang?`&lang=${encodeURIComponent(lang)}`:''}`
    }
  ];
  const transcriptClients = new Map();
  const transcriptApis = new Map();
  let transcriptBusy = false;
  let transcriptSource = 'url';
  let transcriptFile = null;
  let transcriptResult = {text:'', cues:[]};

  const getTranscriptFormat = () => $('#transcript-format')?.value === 'srt' ? 'srt' : 'simple';
  const srtTime = seconds => {
    const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(milli).padStart(3,'0')}`;
  };
  const parseTimecode = value => {
    const m = String(value || '').trim().replace(',', '.').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if(!m) return NaN;
    const h = Number(m[1] || 0), min = Number(m[2]), sec = Number(m[3]), frac = String(m[4] || '').padEnd(3,'0');
    return h * 3600 + min * 60 + sec + (Number(frac) || 0) / 1000;
  };
  function parseSubtitleCues(raw){
    const src=String(raw||'').replace(/\r/g,'').replace(/^WEBVTT[^\n]*\n/i,'').trim();
    if(!src) return [];
    const blocks=src.split(/\n{2,}/); const cues=[];
    for(const block of blocks){
      const lines=block.split('\n').map(x=>x.trim()).filter(Boolean);
      const ti=lines.findIndex(x=>x.includes('-->'));
      if(ti<0) continue;
      const times=lines[ti].split(/\s+-->\s+/);
      const start=parseTimecode(times[0].split(/\s+/)[0]); const end=parseTimecode(times[1]?.split(/\s+/)[0]);
      const text=lines.slice(ti+1).join('\n').replace(/<[^>]+>/g,'').trim();
      if(Number.isFinite(start)&&Number.isFinite(end)&&text) cues.push({start,end,text});
    }
    return cues;
  }
  function parseBracketTimestampCues(raw){
    const lines=String(raw||'').replace(/\r/g,'').split('\n');
    const hits=[];
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
      if(m&&m[2].trim()) hits.push({start:parseTimecode(m[1]),text:m[2].trim()});
    }
    return hits.map((x,i)=>({start:x.start,end:i+1<hits.length?Math.max(x.start+0.5,hits[i+1].start-0.05):x.start+3,text:x.text})).filter(x=>Number.isFinite(x.start));
  }
  function segmentsToCues(value){
    const cues=[];
    const walk=v=>{
      if(!v) return;
      if(Array.isArray(v)){ v.forEach(walk); return; }
      if(typeof v!=='object') return;
      const start=Number(v.start ?? v.start_time ?? v.begin);
      const duration=Number(v.duration ?? v.dur);
      const end=Number(v.end ?? v.end_time);
      const text=typeof v.text==='string'?v.text:typeof v.content==='string'?v.content:'';
      if(Number.isFinite(start) && text.trim()){
        const cueEnd=Number.isFinite(end)?end:(Number.isFinite(duration)?start+duration:start+3);
        if(cueEnd>start) cues.push({start,end:cueEnd,text:text.trim()});
      }
      Object.values(v).forEach(child=>{ if(child&&typeof child==='object'&&!('start' in v && 'text' in v && child===v)) walk(child); });
    };
    walk(value);
    cues.sort((a,b)=>a.start-b.start);
    const out=[]; for(const cue of cues){ const prev=out[out.length-1]; if(prev&&Math.abs(prev.start-cue.start)<0.001&&prev.text===cue.text) continue; out.push(cue); }
    return out;
  }
  const cuesToSrt = cues => cues.map((cue,i)=>`${i+1}\n${srtTime(cue.start)} --> ${srtTime(Math.max(cue.end,cue.start+0.25))}\n${normalizeNaturalMyanmar(cue.text)}\n`).join('\n').trim();
  const updateTranscriptOutput = () => {
    const out=$('#transcript-output'); if(!out) return;
    const format=getTranscriptFormat();
    out.value = format==='srt' ? cuesToSrt(transcriptResult.cues) : transcriptResult.text;
    const dl=$('#transcript-download');
    if(dl) dl.textContent = format==='srt' ? (UI[localStorage.getItem(UI_LANG_KEY)||'my']?.downloadSrt||'↓ SRT') : (UI[localStorage.getItem(UI_LANG_KEY)||'my']?.downloadTxt||'↓ TXT');
    const label=$('.transcript-result-label'); if(label) label.textContent = format==='srt' ? (UI[localStorage.getItem(UI_LANG_KEY)||'my']?.resultSrt||'မြန်မာ SRT') : (UI[localStorage.getItem(UI_LANG_KEY)||'my']?.resultLabel||'မြန်မာ Transcript');
  };

  const setTranscriptStatus = (message, kind='') => {
    const el = $('#transcript-status');
    if (el) { el.textContent = message; el.className = `status ${kind}`; }
  };
  const transcriptProgress = (pct, msg='') => {
    const wrap=$('#transcript-progress-wrap'), bar=$('#transcript-progress-bar'), label=$('#transcript-progress-text');
    if (!wrap) return;
    wrap.hidden=false; bar.style.width=`${Math.max(0,Math.min(100,pct))}%`; label.textContent=msg||`${Math.round(pct)}%`;
  };
  function getYouTubeVideoId(value){
    const raw=String(value||'').trim();
    if(/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    try{
      const u=new URL(raw);
      const host=u.hostname.replace(/^www\./,'').toLowerCase();
      if(host==='youtu.be'){
        const id=u.pathname.split('/').filter(Boolean)[0]||'';
        return /^[A-Za-z0-9_-]{11}$/.test(id)?id:'';
      }
      if(host==='youtube.com'||host.endsWith('.youtube.com')){
        const v=u.searchParams.get('v');
        if(v&&/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
        const parts=u.pathname.split('/').filter(Boolean);
        const idx=parts.findIndex(x=>['shorts','embed','live'].includes(x));
        const id=idx>=0?parts[idx+1]:'';
        if(id&&/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
      }
    }catch{}
    return '';
  }

  function transcriptLangCode(){
    const v=$('#transcript-lang')?.value||'';
    return ({english:'en',japanese:'ja',korean:'ko',chinese:'zh',thai:'th',burmese:'my'})[v]||'';
  }

  function cleanExternalTranscript(raw){
    const s=String(raw||'').replace(/\r/g,'').replace(/```(?:markdown|text)?/gi,'').replace(/```/g,'').trim();
    const lines=s.split('\n').map(x=>x.trim()).filter(Boolean);
    return normalizeNaturalMyanmar(lines.filter(x=>
      !/^#\s*Transcript:/i.test(x) && !/^Source video:/i.test(x) &&
      !/^Language:/i.test(x) && !/^Other available languages:/i.test(x) &&
      !/^To request a specific language:/i.test(x)
    ).map(x=>x.replace(/^\[[^\]]+\]\s*/,'')).join('\n'));
  }

  async function fetchExternalYouTubeTranscript(url){
    const id=getYouTubeVideoId(url);
    if(!id) throw Error('YouTube video ID ကိုမဖတ်နိုင်ပါ');
    const lang=transcriptLangCode(); const needSrt=getTranscriptFormat()==='srt';
    let lastErr=null;
    for(const provider of EXTERNAL_YT_TRANSCRIPT){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),25000);
      try{
        setTranscriptStatus(`${provider.name} မှ Transcript ရယူနေသည်…`);
        const useJson=needSrt && provider.name==='YouTube Transcribe';
        const endpoint=useJson
          ? `https://youtubetranscribe.khabaroff.studio/transcript/${id}?auto=true&timestamps=true${lang?`&lang=${encodeURIComponent(lang)}`:''}`
          : provider.makeUrl(id,lang);
        const res=await fetch(endpoint,{method:'GET',cache:'no-store',mode:'cors',headers:{Accept:'application/json, text/plain, text/markdown;q=0.9'},signal:controller.signal});
        const raw=await res.text();
        if(!res.ok) throw Error(`${provider.name} HTTP ${res.status}${raw?` — ${raw.slice(0,160)}`:''}`);
        let text=''; let cues=[];
        try{
          const json=JSON.parse(raw);
          cues=segmentsToCues(json);
          if(typeof json?.transcript==='string') text=json.transcript;
          if(!text && typeof json?.text==='string') text=json.text;
          if(!text){
            const parts=[]; const walk=v=>{
              if(v==null)return; if(typeof v==='string'){if(v.trim())parts.push(v);return;}
              if(Array.isArray(v)){v.forEach(walk);return;}
              if(typeof v==='object'){ if(typeof v.text==='string') parts.push(v.text); if(v.content) walk(v.content); }
            }; walk(json); text=parts.join('\n');
          }
        }catch{
          cues=parseBracketTimestampCues(raw);
          text=cleanExternalTranscript(raw);
        }
        if(!cues.length) cues=parseBracketTimestampCues(raw);
        if(!text&&cues.length) text=cues.map(c=>c.text).join('\n');
        text=normalizeNaturalMyanmar(text);
        if(needSrt && !cues.length) throw Error(`${provider.name} က SRT အတွက် timestamp မပေးပါ`);
        if(!text) throw Error(`${provider.name} က Transcript အလွတ်ပြန်ပေးသည်`);
        return {text,cues,provider:provider.name};
      }catch(e){ lastErr=e; console.warn('External YouTube transcript provider failed:',provider.name,e); }
      finally{ clearTimeout(timer); }
    }
    throw lastErr||Error('External YouTube transcript service မအောင်မြင်ပါ');
  }

  const normalizeNaturalMyanmar = value => {
    let s=String(value||'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
    return s.replace(/\s+([၊။!?])/g,'$1').replace(/([!?]){2,}/g,'$1');
  };
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  // Translate any detected/source-language transcript into Burmese.
  // We deliberately keep Burmese as the fixed output language so videos in
  // English, Japanese, Korean, Chinese, Thai, etc. produce a Burmese .txt.
  const TRANSLATION_SERVICES = [
    {
      name:'Google Translate',
      makeUrl:(text)=>`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=my&dt=t&q=${encodeURIComponent(text)}`,
      parse:async res=>{
        const data=await res.json();
        if(!Array.isArray(data)||!Array.isArray(data[0])) throw Error('Google Translate response မမှန်ပါ');
        return data[0].map(x=>Array.isArray(x)?x[0]:'').filter(Boolean).join('');
      }
    },
    {
      name:'MyMemory',
      makeUrl:(text)=>`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto%7Cmy`,
      parse:async res=>{
        const data=await res.json();
        const out=data?.responseData?.translatedText || data?.matches?.[0]?.translation || '';
        if(!out) throw Error('MyMemory response အလွတ်ဖြစ်နေသည်');
        return out;
      }
    }
  ];

  function translationChunks(text, max=1200){
    const src=String(text||'').replace(/\r/g,'').trim();
    if(!src) return [];
    const paras=src.split(/\n+/).map(x=>x.trim()).filter(Boolean);
    const out=[];
    let buf='';
    for(const para of paras){
      const candidate=buf?`${buf}\n${para}`:para;
      if(candidate.length<=max){buf=candidate;continue;}
      if(buf) out.push(buf);
      if(para.length<=max){buf=para;continue;}
      let rest=para;
      while(rest.length>max){
        let cut=Math.max(rest.lastIndexOf(' ',max),rest.lastIndexOf('၊',max),rest.lastIndexOf('။',max),rest.lastIndexOf('.',max));
        if(cut<Math.floor(max*0.55)) cut=max;
        out.push(rest.slice(0,cut).trim());
        rest=rest.slice(cut).trim();
      }
      buf=rest;
    }
    if(buf) out.push(buf);
    return out;
  }

  async function translateChunkToMyanmar(text){
    let lastErr=null;
    for(const service of TRANSLATION_SERVICES){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),20000);
      try{
        const res=await fetch(service.makeUrl(text),{
          method:'GET',cache:'no-store',mode:'cors',
          headers:{Accept:'application/json, text/plain;q=0.9'},signal:controller.signal
        });
        if(!res.ok) throw Error(`${service.name} HTTP ${res.status}`);
        const out=normalizeNaturalMyanmar(await service.parse(res));
        if(!out) throw Error(`${service.name} က မြန်မာဘာသာပြန် အလွတ်ပြန်ပေးသည်`);
        return {text:out,provider:service.name};
      }catch(e){
        lastErr=e;
        console.warn('Translation service failed:',service.name,e);
      }finally{ clearTimeout(timer); }
    }
    throw lastErr||Error('မြန်မာဘာသာပြန် service အားလုံး မအောင်မြင်ပါ');
  }

  async function translateTranscriptToMyanmar(text){
    const clean=normalizeNaturalMyanmar(text);
    if(!clean) return {text:'',provider:''};
    // Avoid needless external calls for an already Burmese transcript.
    const nonMyanmar=(clean.match(/[^\u1000-\u109F\uAA60-\uAA7F\s\d\p{P}\p{N}]/gu)||[]).length;
    if(!nonMyanmar) return {text:clean,provider:'မူရင်း Transcript'};
    const chunks=translationChunks(clean,1200);
    const translated=[];
    let provider='';
    for(let i=0;i<chunks.length;i++){
      transcriptProgress(Math.min(82 + Math.round(((i+1)/chunks.length)*16),98),`မြန်မာဘာသာပြန်နေသည်… ${i+1}/${chunks.length}`);
      const out=await translateChunkToMyanmar(chunks[i]);
      translated.push(out.text); provider=provider||out.provider;
    }
    return {text:normalizeNaturalMyanmar(translated.join('\n')),provider};
  }

  async function getTranscriptClient(space){
    if (!gradio) gradio = await import('https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js');
    if (!transcriptClients.has(space)) {
      const t=getHFToken();
      transcriptClients.set(space, gradio.Client.connect(space, t?{hf_token:t}:undefined));
    }
    const client=await transcriptClients.get(space);
    if (!transcriptApis.has(space)) transcriptApis.set(space, await client.view_api());
    return {client,info:transcriptApis.get(space)};
  }
  function allTranscriptEndpoints(info){
    const out=[];
    for(const [name,ep] of Object.entries(info?.named_endpoints||{})) out.push({name,ep});
    for(const [idx,ep] of Object.entries(info?.unnamed_endpoints||{})) out.push({name:idx.startsWith('/')?idx:`/${idx}`,ep});
    return out;
  }
  const labelOf=p=>String(p?.label||'').toLowerCase();
  const componentOf=p=>String(p?.component||p?.type||'').toLowerCase();
  const choicesOf=p=>{
    const raw=p?.enum || p?.choices || p?.values || p?.component_props?.choices || p?.props?.choices || [];
    return Array.isArray(raw) ? raw.map(x=>String(x?.value ?? x?.label ?? x)) : [];
  };
  const normChoice=v=>String(v??'').trim().toLowerCase();
  function chooseValid(p, desired='', fallbacks=[]){
    const choices=choicesOf(p);
    const candidates=[desired,...fallbacks,p?.example_input,p?.default].filter(v=>v!==undefined && v!==null && String(v)!=='');
    if(!choices.length) return candidates[0] ?? '';
    for(const c of candidates){
      const hit=choices.find(x=>normChoice(x)===normChoice(c));
      if(hit!==undefined) return hit;
    }
    // Useful aliases for Whisper language dropdowns.
    const aliases={
      burmese:['myanmar','burmese','my'], myanmar:['myanmar','burmese','my'], my:['myanmar','burmese','my'],
      english:['english','en'], japanese:['japanese','ja'], korean:['korean','ko'], chinese:['chinese','zh'], thai:['thai','th']
    };
    for(const c of candidates){
      for(const a of (aliases[normChoice(c)]||[])){
        const hit=choices.find(x=>normChoice(x)===a);
        if(hit!==undefined) return hit;
      }
    }
    // Auto language must also be a legal dropdown value. Never send an empty string.
    if(!desired){
      const auto=choices.find(x=>/^(auto|automatic|auto detect|detect|none|default)$/i.test(x));
      if(auto!==undefined) return auto;
    }
    return choices[0];
  }
  function isFileParam(p){
    const l=labelOf(p), c=componentOf(p);
    return /audio|video|file|upload|microphone/.test(`${l} ${c}`) || /filepath|file/.test(String(p?.type||'').toLowerCase());
  }
  function isUrlParam(p){
    const l=labelOf(p);
    return /youtube|video url|download from url|url|link/.test(l);
  }
  function pickTranscriptEndpoint(info, kind='file'){
    const endpoints=allTranscriptEndpoints(info);
    const score=(x)=>{
      const ps=x.ep?.parameters||[];
      const labels=ps.map(p=>labelOf(p)).join(' | ');
      const hasFile=ps.some(isFileParam), hasUrl=ps.some(isUrlParam);
      let n=0;
      if(/transcrib|whisper|speech/.test(x.name.toLowerCase())) n+=8;
      if(kind==='url') n += hasUrl ? 30 : -40;
      else n += hasFile ? 30 : -25;
      if(labels.includes('youtube')) n+=10;
      if(labels.includes('audio')) n+=7;
      if(labels.includes('video')) n+=6;
      if(labels.includes('task')) n+=3;
      if(labels.includes('language')) n+=3;
      return n;
    };
    endpoints.sort((a,b)=>score(b)-score(a));
    if(!endpoints[0] || score(endpoints[0])<5) throw Error(kind==='url'?'ဒီ Whisper engine က Video URL input မထောက်ပံ့ပါ':'ဒီ Whisper engine က file/audio input မထောက်ပံ့ပါ');
    return endpoints[0];
  }
  function exampleOr(p,fallback){return p?.example_input!==undefined && p.example_input!==null && p.example_input!=='' ? p.example_input : fallback;}
  function buildWhisperPayload(ep, source, value){
    return (ep?.parameters||[]).map(p=>{
      const l=labelOf(p), typ=String(p?.type||'').toLowerCase();
      if(isUrlParam(p)) return value;
      if(l==='task' || l.includes('select the task')) return chooseValid(p,'transcribe',['transcribe','Transcribe']);
      if(l.includes('whisper - language') || l==='language' || l.includes('source language')){
        const wanted=$('#transcript-lang')?.value || '';
        return chooseValid(p,wanted,['auto','automatic','auto detect','detect','none']);
      }
      if(l.includes('whisper - model') || l==='model') return chooseValid(p,'turbo',['large-v3','large-v3-turbo','large','medium','small','base','tiny']);
      if(l==='vad' || l.includes('voice activity')) return chooseValid(p,$('#transcript-vad')?.checked?'silero-vad':'none',['silero-vad','none','disabled']);
      if(l.includes('max filesize')) return Number(exampleOr(p,1000));
      if(source==='file' && isFileParam(p)) return gradio.handle_file(value);
      if(l.includes('upload files')) return source==='file' ? [gradio.handle_file(value)] : [];
      if(l.includes('microphone')) return null;
      if(l.includes('speaker') || l.includes('diarization')) return false;
      if(l.includes('timestamp') || l.includes('highlight')) return false;
      if(l.includes('merge window')) return Number(exampleOr(p,5));
      if(l.includes('max merge size')) return Number(exampleOr(p,90));
      if(l.includes('process timeout')) return Number(exampleOr(p,1800));
      if(l.includes('padding')) return Number(exampleOr(p,1));
      if(l.includes('prompt window')) return Number(exampleOr(p,1));
      if(choicesOf(p).length) return chooseValid(p,'');
      if(typ.includes('boolean')) return false;
      if(typ.includes('number')||typ.includes('integer')) return Number(exampleOr(p,0));
      if(isFileParam(p)) return source==='file' ? gradio.handle_file(value) : null;
      return exampleOr(p,'');
    });
  }
  function extractTranscriptResult(result){
    const data=result?.data??result;
    const flatten=v=>Array.isArray(v)?v.flat(Infinity):[v];
    const vals=flatten(data).filter(v=>typeof v==='string' && v.trim());
    const srt=vals.find(x=>/\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(x))||'';
    let cues=parseSubtitleCues(srt);
    if(!cues.length) cues=segmentsToCues(data);
    const text=vals.filter(x=>x!==srt).sort((a,b)=>b.length-a.length)[0]||cues.map(c=>c.text).join('\n');
    return {text:normalizeNaturalMyanmar(text),cues};
  }

  async function extractVideoAudio(file){
    if(!file) throw Error('Video/Audio ဖိုင်မရှိပါ');
    if(file.type.startsWith('audio/')) return file;
    const video=document.createElement('video');
    video.muted=false; video.preload='auto'; video.playsInline=true;
    const url=URL.createObjectURL(file); video.src=url;
    await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve; video.onerror=()=>reject(Error('ဒီ video format ကို browser က ဖတ်မရပါ'));});
    if(!video.captureStream){URL.revokeObjectURL(url);throw Error('ဒီ browser က video audio extraction မထောက်ပံ့ပါ။ MP3/WAV/M4A တင်ပါ');}
    const stream=video.captureStream(), tracks=stream.getAudioTracks();
    if(!tracks.length){URL.revokeObjectURL(url);throw Error('Video ထဲမှာ audio track မတွေ့ပါ');}
    const mime=['audio/webm;codecs=opus','audio/webm','audio/ogg'].find(x=>MediaRecorder.isTypeSupported(x))||'';
    const recorder=new MediaRecorder(new MediaStream(tracks),mime?{mimeType:mime}:undefined), chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const done=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(e.error||Error('Audio capture failed'));});
    recorder.start(250);
    try{await video.play();}catch{recorder.stop();URL.revokeObjectURL(url);throw Error('Video ကို browser က play မလုပ်နိုင်ပါ');}
    await new Promise(resolve=>video.onended=resolve); recorder.stop(); await done; URL.revokeObjectURL(url);
    return new File([new Blob(chunks,{type:recorder.mimeType||'audio/webm'})],`${file.name.replace(/\.[^.]+$/,'')}.webm`,{type:recorder.mimeType||'audio/webm'});
  }
  async function translateCuesToMyanmar(cues){
    const out=[]; let provider='';
    for(let i=0;i<cues.length;i++){
      const cue=cues[i];
      transcriptProgress(Math.min(82 + Math.round(((i+1)/cues.length)*16),98),`SRT မြန်မာဘာသာပြန်နေသည်… ${i+1}/${cues.length}`);
      const translated=await translateChunkToMyanmar(cue.text);
      provider=provider||translated.provider;
      out.push({...cue,text:translated.text});
    }
    return {cues:out,provider};
  }

  async function translateTranscriptResult(rawOut){
    const format=getTranscriptFormat();
    if(format==='srt'){
      if(!rawOut.cues?.length) throw Error('SRT timestamp မရပါ');
      const translated=await translateCuesToMyanmar(rawOut.cues);
      return {
        text:normalizeNaturalMyanmar(translated.cues.map(c=>c.text).join('\n')),
        cues:translated.cues,
        provider:translated.provider
      };
    }
    const translated=await translateTranscriptToMyanmar(rawOut.text);
    return {text:translated.text,cues:rawOut.cues||[],provider:translated.provider};
  }

  async function transcribeWithEngine(engine, source, value){
    let pair;
    try{pair=await getTranscriptClient(engine.space);}catch(e){transcriptClients.delete(engine.space);transcriptApis.delete(engine.space);throw e;}
    const {client,info}=pair;
    const chosen=pickTranscriptEndpoint(info,source);
    const payload=buildWhisperPayload(chosen.ep,source,value);
    try{
      return extractTranscriptResult(await client.predict(chosen.name,payload));
    }catch(first){
      // Some Spaces expose an Audio component but accept video only after ffmpeg extraction.
      if(source==='file' && value?.type?.startsWith('video/')){
        const audioFile=await extractVideoAudio(value);
        const retryPayload=buildWhisperPayload(chosen.ep,'file',audioFile);
        return extractTranscriptResult(await client.predict(chosen.name,retryPayload));
      }
      throw first;
    }
  }

  function updateViewportMode(){
    const w=window.innerWidth, h=window.innerHeight;
    let mode=w<=600?'phone':w<=900?'tablet':'desktop';
    document.documentElement.dataset.viewport=mode;
    document.documentElement.dataset.orientation=w>=h?'landscape':'portrait';
    document.documentElement.style.setProperty('--vw',`${w}px`);
    document.documentElement.style.setProperty('--vh',`${h}px`);
  }
  window.addEventListener('resize',updateViewportMode,{passive:true});
  window.addEventListener('orientationchange',()=>setTimeout(updateViewportMode,80),{passive:true});
  updateViewportMode();

  function setupTranscriptSidebar(){
    const open=$('#transcript-toggle'), close=$('#transcript-close'), side=$('#transcript-sidebar'), back=$('#sidebar-backdrop');
    const setOpen=v=>{side.classList.toggle('open',v);back.classList.toggle('open',v);side.setAttribute('aria-hidden',String(!v));};
    open?.addEventListener('click',()=>setOpen(true)); close?.addEventListener('click',()=>setOpen(false)); back?.addEventListener('click',()=>setOpen(false));
    document.querySelectorAll('.source-tab').forEach(btn=>btn.addEventListener('click',()=>{
      if(transcriptBusy)return;
      document.querySelectorAll('.source-tab').forEach(x=>x.classList.remove('active'));btn.classList.add('active');
      transcriptSource=btn.dataset.source;
      $('#transcript-url-source').hidden=transcriptSource!=='url';$('#transcript-file-source').hidden=transcriptSource!=='file';
      setTranscriptStatus(transcriptSource==='url'?'Video link ထည့်ပြီး စတင်နိုင်ပါပြီ':'Video/Audio ဖိုင်တင်ပြီး စတင်နိုင်ပါပြီ');
    }));
    const tfi=$('#transcript-file-input');
    const setTranscriptFile=file=>{if(!file)return; if(file.size>1024*1024*1024)return setTranscriptStatus('Video/Audio ဖိုင် 1GB ထက်မကျော်ရ','error'); transcriptFile=file;$('#transcript-file-title').textContent=file.name;$('#transcript-file-meta').textContent=`${fmt(file.size)} • အသုံးပြုရန်အဆင်သင့်`;$('#remove-transcript-file').hidden=false;setTranscriptStatus('Video/Audio ဖိုင် အဆင်သင့်ဖြစ်ပါပြီ','ok');};
    tfi?.addEventListener('change',e=>setTranscriptFile(e.target.files[0]));
    const tdz=$('#transcript-dropzone');
    tdz?.addEventListener('dragover',e=>{e.preventDefault();tdz.style.borderColor='var(--cyan)';});
    tdz?.addEventListener('dragleave',()=>tdz.style.borderColor='');
    tdz?.addEventListener('drop',e=>{e.preventDefault();tdz.style.borderColor='';setTranscriptFile(e.dataTransfer.files[0]);});
    $('#remove-transcript-file')?.addEventListener('click',()=>{transcriptFile=null;tfi.value='';$('#transcript-file-title').textContent='Video / Audio ဖိုင်ရွေးပါ သို့မဟုတ် ဆွဲချပါ';$('#transcript-file-meta').textContent='MP4, MKV, WebM, MOV, MP3, WAV, M4A • 1GB အထိ';$('#remove-transcript-file').hidden=true;});
    $('#transcript-copy')?.addEventListener('click',async()=>{const v=$('#transcript-output').value;if(!v)return;try{await navigator.clipboard.writeText(v);setTranscriptStatus('Transcript ကို Copy လုပ်ပြီးပါပြီ','ok');}catch{setTranscriptStatus('Copy မအောင်မြင်ပါ','error');}});
    $('#transcript-format')?.addEventListener('change',()=>{updateTranscriptOutput();});
    $('#transcript-download')?.addEventListener('click',()=>{const v=$('#transcript-output').value;if(!v)return;const format=getTranscriptFormat();const ext=format==='srt'?'srt':'txt';const mime=format==='srt'?'application/x-subrip;charset=utf-8':'text/plain;charset=utf-8';const blob=new Blob([v],{type:mime});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`myanmar-transcript-${Date.now()}.${ext}`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
    const routeToAudio=()=>{const v=String(transcriptResult.text||'').trim() || (getTranscriptFormat()==='simple'?$('#transcript-output').value.trim():'');if(!v)return; text.value=v;text.dispatchEvent(new Event('input'));setTranscriptStatus('Transcript ကို Audio/TTS စာသားထဲ ထည့်ပြီးပါပြီ','ok');setOpen(false);document.querySelector('.controls')?.scrollIntoView({behavior:'smooth',block:'start'});setTimeout(()=>text.focus(),450);};
    $('#transcript-use')?.addEventListener('click',routeToAudio);
    $('#transcript-generate')?.addEventListener('click', async()=>{
      if(transcriptBusy)return;
      const source=transcriptSource; const url=$('#video-url').value.trim();
      if(source==='url' && !/^https?:\/\//i.test(url)) return setTranscriptStatus('Video URL မှန်မှန်ထည့်ပါ','error');
      if(source==='file' && !transcriptFile) return setTranscriptStatus('Video/Audio ဖိုင်တင်ပါ','error');
      transcriptBusy=true; $('#transcript-generate').disabled=true; $('#transcript-label').hidden=true; $('#transcript-spinner').hidden=false; $('#transcript-copy').disabled=true; $('#transcript-download').disabled=true; $('#transcript-use').disabled=true;
      try{
        let lastErr=null;

        // YouTube -> external transcript services first. They fetch YouTube
        // captions directly, so the Hugging Face Space never has to download
        // the YouTube video with yt-dlp/cookies.
        if(source==='url' && getYouTubeVideoId(url)){
          try{
            transcriptProgress(8,'External YouTube transcript service ချိတ်နေသည်…');
            const rawOut=await fetchExternalYouTubeTranscript(url);
            if(!rawOut.text) throw Error('Transcript စာသားမရပါ');
            transcriptProgress(74,'မူရင်း Transcript ရပြီး — မြန်မာဘာသာပြန်နေသည်…');
            const out=await translateTranscriptResult(rawOut);
            if(!out.text) throw Error('မြန်မာ Transcript စာသားမရပါ');
            transcriptResult = {text:out.text, cues:out.cues||[]};
            updateTranscriptOutput();
            $('#transcript-copy').disabled=false; $('#transcript-download').disabled=false; $('#transcript-use').disabled=false;
            transcriptProgress(100,'မြန်မာ Transcript ပြီးပါပြီ');
            setTranscriptStatus(`${rawOut.provider} + ${out.provider||'မြန်မာဘာသာပြန်'} နဲ့ မြန်မာ Transcript ပြီးပါပြီ`,'ok');
            if($('#transcript-auto-route')?.checked) setTimeout(routeToAudio,250);
            return;
          }catch(e){
            lastErr=e;
            console.warn('External YouTube transcript failed:',e);
            setTranscriptStatus('External Transcript service မရသေးပါ — Whisper fallback ကို စမ်းနေသည်…');
            await sleep(300);
          }
        }

        // Non-YouTube URLs and local files use the existing Whisper/Gradio
        // discovery and fallback path.
        for(let i=0;i<TRANSCRIPT_ENGINES.length;i++){
          const engine=TRANSCRIPT_ENGINES[i];
          try{
            setTranscriptStatus(`${engine.label} ကို စမ်းနေသည်…`); transcriptProgress(Math.min(18+i*12,70),`${engine.label} ချိတ်နေသည်…`);
            const rawOut=await transcribeWithEngine(engine,source,source==='url'?url:transcriptFile);
            if(!rawOut.text) throw Error('Transcript စာသားမရပါ');
            transcriptProgress(70,'မူရင်း Transcript ရပြီး — မြန်မာဘာသာပြန်နေသည်…');
            const out=await translateTranscriptResult(rawOut);
            if(!out.text) throw Error('မြန်မာ Transcript စာသားမရပါ');
            transcriptResult = {text:out.text, cues:out.cues||[]};
            updateTranscriptOutput();
            $('#transcript-copy').disabled=false; $('#transcript-download').disabled=false; $('#transcript-use').disabled=false;
            transcriptProgress(100,'မြန်မာ Transcript ပြီးပါပြီ'); setTranscriptStatus(`${engine.label} + ${out.provider||'မြန်မာဘာသာပြန်'} နဲ့ မြန်မာ Transcript ပြီးပါပြီ`,'ok');
            if($('#transcript-auto-route')?.checked) setTimeout(routeToAudio,250);
            return;
          }catch(e){lastErr=e;console.warn('Transcript engine failed:',engine.space,e);setTranscriptStatus(`${engine.label} မရသေးပါ — နောက် engine ကို စမ်းနေသည်…`);await sleep(350);}
        }
        throw lastErr||Error('Transcript engine အားလုံး မအောင်မြင်ပါ');
      }catch(e){console.error(e);setTranscriptStatus(`Transcript မအောင်မြင်ပါ: ${e?.message||e}`,'error');transcriptProgress(0,'');}
      finally{transcriptBusy=false;$('#transcript-generate').disabled=false;$('#transcript-label').hidden=false;$('#transcript-spinner').hidden=true;}
    });
  }

  setupTranscriptSidebar();

  $('#generate').addEventListener('click', async()=>{if(busy)return;const value=text.value.trim();if(!value)return setStatus('ဖတ်မည့်စာသား ထည့်ပါ','error');if(value.length>MAX_CHARS)return setStatus(`စာသားအများဆုံး ${MAX_CHARS.toLocaleString()} characters အထိသာ`,'error');if(mode==='clone'&&!fileData)return setStatus('Reference အသံဖိုင် တင်ပါ','error');setBusy(true);progress(0,'စတင်နေသည်…');try{const result=await runLongText();showBlob(result.blob,result);setStatus(`အသံဖန်တီးပြီးပါပြီ — ${value.length.toLocaleString()} characters`,'ok');progress(100,'ပြီးပါပြီ');}catch(e){console.error(e);setStatus(`Generate မအောင်မြင်ပါ: ${e?.message||e}`,'error');}finally{setBusy(false);setTimeout(hideProgress,1200);}});
  // UI language switch: Burmese / English. Persist the choice locally and translate
  // the visible interface without changing the underlying generation/transcription logic.
  const UI_LANG_KEY='myvoice-ui-language-v1';
  const UI={
    my:{
      pageTitle:'မြန်မာ Voice Studio',brandTitle:'မြန်မာ VOICE STUDIO',brandSub:'AI Text-to-Speech & Voice Cloning',
      local:'● LOCAL MODE',transcript:'Video Transcript',transcriptTitle:'Video → မြန်မာ Transcript',
      transcriptDesc:'YouTube link ဖြစ်ရင် External Transcript website ကို အရင်သုံးပြီး Whisper/yt-dlp download error မဖြစ်အောင် ပြင်ထားပါတယ်။ မရရင် Whisper engine သို့ auto fallback လုပ်ပေးမယ်။',
      videoLink:'🔗 Video Link',uploadFile:'📁 Upload File',videoLinkLabel:'Video Link',videoPlaceholder:'YouTube / Vimeo / direct video link / other public URL',
      publicHelp:'YouTube link တွေအတွက် External Transcript service ကို အရင်သုံးပါတယ်။ YouTube မဟုတ်တဲ့ public URL တွေက Whisper server က media download လုပ်နိုင်မှ အလုပ်လုပ်ပါမယ်။ Private/login URL တွေက မရနိုင်ပါ။',
      localFile:'Download လုပ်ထားတဲ့ Video / Audio',filePick:'Video / Audio ဖိုင်ရွေးပါ သို့မဟုတ် ဆွဲချပါ',fileMeta:'MP4, MKV, WebM, MOV, MP3, WAV, M4A • 1GB အထိ',
      remove:'ဖိုင်ဖယ်ရှားမည်',originalLang:'မူရင်းဘာသာ',autoDetect:'Auto Detect',vad:'အသံမရှိတဲ့အပိုင်းတွေ ဖယ်ပြီး စကားပြောအပိုင်းကိုပဲယူမည်',autoRoute:'Transcript ပြီးရင် Audio/TTS နေရာကို auto သွားမည်',
      transcriptGo:'Transcript လုပ်မည်',transcriptReady:'Video link ထည့်ပါ သို့မဟုတ် ဖိုင်တင်ပါ',formatLabel:'ထွက်ဖိုင်ပုံစံ',simpleFormat:'ရိုးရိုး Transcript',srtFormat:'SRT Subtitle',resultSrt:'မြန်မာ SRT',resultLabel:'မြန်မာ Transcript',resultPlaceholder:'Transcript ရလာရင် ဒီနေရာမှာ ပြပါမယ်...',copy:'Copy',downloadTxt:'↓ TXT',downloadSrt:'↓ SRT',toAudio:'Audio နေရာသို့',
      transcriptNote:'YouTube အတွက် External Transcript service ၂ ခုကို အရင်စမ်းပြီး၊ မရရင် Whisper fallback ကို သုံးပါတယ်။ Private/caption မရှိတဲ့ YouTube video တွေက local video upload သို့မဟုတ် Whisper fallback လိုနိုင်ပါတယ်။',
      input:'၁ / INPUT',makeAudio:'အသံဖန်တီးရန်',inputSub:'စာထည့်ပြီး အသံပုံစံရွေးပါ',tts:'✍️ စာမှအသံ',ttsEn:'Text to Speech',clone:'🎙️ အသံပွားရန်',cloneEn:'Voice Cloning',script:'ဖတ်မည့်စာသား',chars:'စာလုံး',placeholder:'ဥပမာ — မင်္ဂလာပါ။ ဒီနေ့ကောင်းသောနေ့လေး ဖြစ်ပါစေ...',sample:'နမူနာထည့်ရန်',clear:'ရှင်းလင်းမည်',engine:'AI Engine',engineHelp:'စာသားရှည်ရင် အပိုင်းခွဲပြီး အစဉ်မပျက် ပြန်ပေါင်းပေးမည် • Engine မအောင်မြင်/Quota မလုံလောက်ရင် နောက် engine သို့ auto fallback လုပ်မည်',
      style:'အသံပုံစံဖော်ပြချက်',stylePlaceholder:'နွေးထွေးသော မြန်မာအမျိုးသားအသံ၊ ဖြည်းဖြည်းပြောပါ',warm:'နွေးထွေး',soft:'နူးညံ့',announcer:'ကြေညာသူ',relaxed:'သက်တောင့်သက်သာ',reference:'Reference အသံဖိုင်',audioPick:'အသံဖိုင်ရွေးပါ သို့မဟုတ် ဆွဲချပါ',audioMeta:'WAV, MP3, OGG • 20MB အထိ',noise:'Reference အသံ noise လျှော့မည်',advanced:'အဆင့်မြင့်ရွေးချယ်စရာ',open:'ဖွင့်မည်',close:'ပိတ်မည်',creativity:'Creativity',normalize:'စာလုံး၊ နံပါတ်များကို ပုံမှန်ဖတ်မည်',account:'Hugging Face Account',anonymous:'Anonymous / မချိတ်ထားပါ',add:'＋ အကောင့်ထည့်',delete:'ဖျက်',tokenHelp:'ကိုယ်ပိုင် Hugging Face account token တွေကို manual ပြောင်းသုံးနိုင်ပါတယ်။ Account တစ်ခုချင်းစီရဲ့ ကိုယ်ပိုင် quota ကိုပဲ အသုံးပြုမည်။ Engine failover ကတော့ quota ကျော်ဖို့ account လှည့်ခြင်းမဟုတ်ဘဲ သီးခြား TTS engine သို့ ပြောင်းပေးခြင်းသာ ဖြစ်ပါတယ်။ Token များကို ဒီ browser session ထဲမှာသာ သိမ်းမည်။',
      generate:'အသံဖန်တီးမည်',start:'စတင်အသုံးပြုရန် စာသားထည့်ပါ',output:'၂ / OUTPUT',outputTitle:'ထွက်ရှိလာသောအသံ',noAudio:'အသံမရှိသေးပါ',noAudioHelp:'စာသားထည့်ပြီး “အသံဖန်တီးမည်” ကိုနှိပ်ပါ',download:'↓ Download',done:'✓ ဖန်တီးပြီးပါပြီ',how:'အသုံးပြုပုံ',historyEyebrow:'LOCAL HISTORY',history:'နောက်ဆုံးဖန်တီးထားသည်များ',clearHistory:'မှတ်တမ်းရှင်းမည်',historyEmpty:'ဒီ browser ထဲမှာ Generate လုပ်ထားသမျှ မှတ်တမ်းတွေ ပေါ်လာပါမည်။'
    },
    en:{
      pageTitle:'Myanmar Voice Studio',brandTitle:'MYANMAR VOICE STUDIO',brandSub:'AI Text-to-Speech & Voice Cloning',local:'● LOCAL MODE',transcript:'Video Transcript',transcriptTitle:'Video → Myanmar Transcript',
      transcriptDesc:'YouTube links use an external transcript website first, avoiding the common Whisper/yt-dlp download error. If that fails, the app falls back to Whisper.',
      videoLink:'🔗 Video Link',uploadFile:'📁 Upload File',videoLinkLabel:'Video Link',videoPlaceholder:'YouTube / Vimeo / direct video link / other public URL',
      publicHelp:'YouTube links use an external transcript service first. Other public URLs use Whisper only when the server can fetch the media; private/login URLs may not work.',localFile:'Downloaded Video / Audio',filePick:'Choose or drop a Video / Audio file',fileMeta:'MP4, MKV, WebM, MOV, MP3, WAV, M4A • up to 1GB',remove:'Remove file',originalLang:'Source language',autoDetect:'Auto Detect',vad:'Remove non-speech sections',autoRoute:'Auto-open Audio/TTS after transcription',transcriptGo:'Transcribe',transcriptReady:'Paste a video link or upload a file',formatLabel:'Output format',simpleFormat:'Simple Transcript',srtFormat:'SRT Subtitle',resultSrt:'Myanmar SRT',resultLabel:'Myanmar Transcript',resultPlaceholder:'Your transcript will appear here...',copy:'Copy',downloadTxt:'↓ TXT',downloadSrt:'↓ SRT',toAudio:'Send to Audio',transcriptNote:'YouTube uses two external transcript services first, then Whisper fallback. Private/caption-disabled videos may still need a local upload or Whisper fallback.',
      input:'1 / INPUT',makeAudio:'Create Audio',inputSub:'Enter text and choose a voice style',tts:'✍️ Text to Speech',ttsEn:'Text to Speech',clone:'🎙️ Voice Cloning',cloneEn:'Voice Cloning',script:'Text to read',chars:'characters',placeholder:'Example — Hello. Have a wonderful day...',sample:'Insert sample',clear:'Clear',engine:'AI Engine',engineHelp:'Long text is split and merged in order • Automatically falls back when an engine fails or quota is unavailable',style:'Voice style description',stylePlaceholder:'Warm Myanmar male voice, speak slowly',warm:'Warm',soft:'Soft',announcer:'Announcer',relaxed:'Relaxed',reference:'Reference audio',audioPick:'Choose or drop an audio file',audioMeta:'WAV, MP3, OGG • up to 20MB',noise:'Reduce reference audio noise',advanced:'Advanced options',open:'Open',close:'Close',creativity:'Creativity',normalize:'Normalize letters and numbers',account:'Hugging Face Account',anonymous:'Anonymous / Not connected',add:'＋ Add account',delete:'Delete',tokenHelp:'You can switch between your own Hugging Face account tokens manually. Each account uses its own quota. Engine failover does not rotate accounts to bypass quota; it switches to a separate TTS engine. Tokens are stored only in this browser session.',generate:'Generate Audio',start:'Enter text to get started',output:'2 / OUTPUT',outputTitle:'Generated Audio',noAudio:'No audio yet',noAudioHelp:'Enter text and click “Generate Audio”',download:'↓ Download',done:'✓ Generated',how:'How it works',historyEyebrow:'LOCAL HISTORY',history:'Recent generations',clearHistory:'Clear history',historyEmpty:'Generations made in this browser will appear here.'
    }
  };
  const applyUILanguage=(lang, persist=true)=>{
    lang=UI[lang]?lang:'my'; const d=UI[lang]; document.documentElement.lang=lang; document.documentElement.dataset.uiLang=lang; document.title=d.pageTitle;
    const set=(sel,key)=>{const el=$(sel);if(!el||d[key]==null)return;const textNode=Array.from(el.childNodes).find(n=>n.nodeType===Node.TEXT_NODE);if(textNode)textNode.nodeValue=d[key];else el.textContent=d[key]}; const attr=(sel,a,key)=>{const el=$(sel);if(el&&d[key]!=null)el.setAttribute(a,d[key])};
    set('.brand h1','brandTitle');set('.brand p','brandSub');set('.local-pill','local');set('#transcript-toggle span','transcript');set('.sidebar-head h2','transcriptTitle');set('.sidebar-desc','transcriptDesc');
    set('[data-source="url"]','videoLink');set('[data-source="file"]','uploadFile');set('#transcript-url-source .field-label','videoLinkLabel');attr('#video-url','placeholder','videoPlaceholder');set('#transcript-url-source .source-help','publicHelp');set('#transcript-file-source .field-label','localFile');set('#transcript-file-title','filePick');set('#transcript-file-meta','fileMeta');set('#remove-transcript-file','remove');
    set('#transcript-options .field-label','originalLang');set('#transcript-lang option[value=""]','autoDetect');set('#transcript-vad + *','vad');set('#transcript-auto-route + *','autoRoute');set('#transcript-options .field-label[for="transcript-format"]','formatLabel');set('#transcript-format option[value="simple"]','simpleFormat');set('#transcript-format option[value="srt"]','srtFormat');set('#transcript-label','transcriptGo');set('#transcript-status','transcriptReady');set('.transcript-result-label','resultLabel');attr('#transcript-output','placeholder','resultPlaceholder');set('#transcript-copy','copy');set('.transcript-note','transcriptNote');set('#transcript-use','toAudio');updateTranscriptOutput();
    set('.section-title .eyebrow','input');set('.section-title h2','makeAudio');set('.section-title p','inputSub');set('[data-mode="tts"]','tts');set('[data-mode="tts"] span','ttsEn');set('[data-mode="clone"]','clone');set('[data-mode="clone"] span','cloneEn');set('label[for="text-input"]','script');set('.quick-row .sample','sample');set('#clear-text','clear');set('.provider-row .field-label','engine');set('.provider-row .muted','engineHelp');set('label[for="style-input"]','style');attr('#style-input','placeholder','stylePlaceholder');
    set('.chip:nth-child(1)','warm');set('.chip:nth-child(2)','soft');set('.chip:nth-child(3)','announcer');set('.chip:nth-child(4)','relaxed');set('#clone-options .field-label','reference');set('#file-title','audioPick');set('#file-meta','audioMeta');set('#remove-file','remove');set('#denoise + *','noise');set('.advanced-head span','advanced');set('#toggle-advanced', $('#advanced-body')?.hidden?'open':'close');set('.range-label','creativity');set('#normalize + *','normalize');set('.hf-token-label','account');set('#hf-account option[value=""]','anonymous');set('#add-hf-account','add');set('#remove-hf-account','delete');set('.token-help','tokenHelp');
    set('#generate-label','generate');set('#status','start');set('.preview-head .eyebrow','output');set('.preview h2','outputTitle');set('#empty h3','noAudio');set('#empty p','noAudioHelp');set('#download','download');set('.result-badge','done');set('.how h3','how');set('.history-head .eyebrow','historyEyebrow');set('.history-head h2','history');set('#clear-history','clearHistory');
    document.querySelectorAll('.lang-btn').forEach(b=>{const active=b.dataset.lang===lang;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    if(persist) localStorage.setItem(UI_LANG_KEY,lang);
  };
  document.querySelectorAll('.lang-btn').forEach(b=>b.addEventListener('click',()=>applyUILanguage(b.dataset.lang)));
  applyUILanguage(localStorage.getItem(UI_LANG_KEY)||'my',false);

  renderHistory();
})();
