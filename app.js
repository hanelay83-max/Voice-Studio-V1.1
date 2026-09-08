(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const text = $('#text-input'), style = $('#style-input'), cfg = $('#cfg');
  const provider = $('#provider');
  let mode = 'tts', fileData = null, busy = false, gradio = null;
  const clientCache = new Map();
  const refCache = new Map();
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

  async function getClient(name) {
    if (!gradio) gradio = await import('https://cdn.jsdelivr.net/npm/@gradio/client@2.5.1/dist/index.min.js');
    if (!clientCache.has(name)) {
      clientCache.set(name, gradio.Client.connect(name));
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
      catch (e) { lastErr=e; if (n<attempts) { setStatus(`ပြန်ကြိုးစားနေသည်… (${n+1}/${attempts})`); await new Promise(r=>setTimeout(r, 450*n)); } }
    }
    throw lastErr || Error('Generate failed');
  }

  async function runLongText() {
    const chunks=splitText(text.value);
    if (!chunks.length) throw Error('ဖတ်မည့်စာသား ထည့်ပါ');
    const selected=provider.value;
    const engines = selected==='auto' ? (mode==='clone' ? ['voxcpm','omnivoice'] : ['voxcpm']) : [selected];
    const concurrency = 3; // Faster wall-clock time while avoiding an excessive HF burst.
    setStatus(`စာသား ${text.value.trim().length.toLocaleString()} characters → ${chunks.length} parts • ${concurrency} jobs အထိ တစ်ပြိုင်နက် စတင်နေသည်…`);

    // Warm the selected Space connections before starting the workers.
    await Promise.all(engines.map(e => getClient(PROVIDERS[e])));
    const results = new Array(chunks.length);
    let nextIndex = 0, completed = 0, fatal = null;

    async function worker(workerId){
      while (fatal === null) {
        const i = nextIndex++;
        if (i >= chunks.length) return;
        let success = false;
        for (const eng of engines) {
          try {
            if (eng==='omnivoice' && mode!=='clone') throw Error('OmniVoice fallback သည် Voice Cloning mode မှာပဲ သုံးပါမယ်');
            setStatus(`${eng==='voxcpm'?'VoxCPM2':'OmniVoice'} — အပိုင်း ${i+1}/${chunks.length} (${workerId})`);
            const audio=await withRetry(() => eng==='voxcpm' ? generateVoxCPM(chunks[i],fileData) : generateOmni(chunks[i],fileData));
            results[i]={blob:await toBlob(audio, eng==='voxcpm'?PROVIDERS.voxcpm:PROVIDERS.omnivoice),engine:eng};
            success=true;
            break;
          } catch(e) {
            if (eng===engines[engines.length-1]) { fatal=e; return; }
            setStatus(`${eng==='voxcpm'?'VoxCPM2':'OmniVoice'} မအောင်မြင်ပါ — အခြား engine သို့ပြောင်းနေသည်…`);
          }
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
  $('#generate').addEventListener('click', async()=>{if(busy)return;const value=text.value.trim();if(!value)return setStatus('ဖတ်မည့်စာသား ထည့်ပါ','error');if(value.length>MAX_CHARS)return setStatus(`စာသားအများဆုံး ${MAX_CHARS.toLocaleString()} characters အထိသာ`,'error');if(mode==='clone'&&!fileData)return setStatus('Reference အသံဖိုင် တင်ပါ','error');setBusy(true);progress(0,'စတင်နေသည်…');try{const result=await runLongText();showBlob(result.blob,result);setStatus(`အသံဖန်တီးပြီးပါပြီ — ${value.length.toLocaleString()} characters`,'ok');progress(100,'ပြီးပါပြီ');}catch(e){console.error(e);setStatus(`Generate မအောင်မြင်ပါ: ${e?.message||e}`,'error');}finally{setBusy(false);setTimeout(hideProgress,1200);}});
  renderHistory();
})();
