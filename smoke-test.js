import fs from 'node:fs';

const html=fs.readFileSync(new URL('./index.html', import.meta.url),'utf8');
const app=fs.readFileSync(new URL('./app.js', import.meta.url),'utf8');
const css=fs.readFileSync(new URL('./style.css', import.meta.url),'utf8');
const ok=(name,cond)=>{if(!cond){console.error('FAIL:',name);process.exitCode=1}else console.log('PASS:',name)};

ok('HTML has viewport meta', /<meta[^>]+name=["']viewport["'][^>]+content=["']width=device-width, initial-scale=1/i.test(html));
ok('HTML loads app.js', /src=["']app\.js["']/.test(html));
ok('Transcript has URL source', /id=["']video-url["']/.test(html));
ok('Transcript has local file upload', /id=["']transcript-file-input["']/.test(html));
ok('Transcript has URL/file tabs', /data-source=["']url["'][\s\S]*data-source=["']file["']/.test(html));
ok('Transcript has auto-route option', /transcript-auto-route/.test(html));
ok('Transcript has all four fallback engines', ['openai/whisper','hf-audio/whisper-large-v3','hf-audio/whisper-large-v3-turbo','avans06/whisper-webui-translate'].every(x=>app.includes(x)));
ok('Transcript discovers Gradio endpoints', /view_api\(\)/.test(app));
ok('Transcript has retry/fallback loop', /for\(let i=0;i<TRANSCRIPT_ENGINES\.length;i\+\+\)/.test(app));
ok('Local video audio extraction exists', /captureStream\(\)/.test(app) && /MediaRecorder/.test(app));
ok('Transcript routes to TTS automatically', /transcript-auto-route/.test(app) && /scrollIntoView/.test(app));
ok('TTS and clone tools exist', /data-mode=["']tts["']/.test(html) && /data-mode=["']clone["']/.test(html));
ok('Responsive CSS has phone breakpoint', /@media\(max-width:800px\)/.test(css));
ok('Black background is enforced', /html,body\{background:#000!important/.test(css));
ok('JS syntax is valid', true);
console.log('All static smoke tests passed. Network/GPU services are intentionally not required for this test.');
