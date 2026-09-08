const SPACE='https://openbmb-voxcpm-demo.hf.space', API=SPACE+'/gradio_api';
const session=Math.random().toString(36).slice(2,10);
const body={data:['မင်္ဂလာပါ။ စမ်းသပ်အသံဖြစ်ပါတယ်။','နွေးထွေးသော မြန်မာအသံ၊ ရှင်းရှင်းပြောပါ',null,false,'',2,true,false],event_data:null,fn_index:2,trigger_id:2,session_hash:session};
const r=await fetch(API+'/queue/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
console.log('queue_join',r.status);
if(!r.ok) process.exit(1);
const s=await fetch(`${API}/queue/data?fn_index=2&session_hash=${session}`);
console.log('queue_stream',s.status,s.headers.get('content-type'));
const reader=s.body.getReader(); const decoder=new TextDecoder(); let buf=''; let finished=false;
while(!finished){const {value,done}=await reader.read(); if(done)break; buf+=decoder.decode(value,{stream:true}); const parts=buf.split('\n\n'); buf=parts.pop(); for(const part of parts){const line=part.split('\n').find(x=>x.startsWith('data:')); if(!line)continue; const m=JSON.parse(line.slice(5).trim()); console.log('event',m.msg); if(m.msg==='process_completed'){console.log('success',m.success,'output',JSON.stringify(m.output?.data||null).slice(0,500)); finished=true;break;} if(m.msg==='queue_full'){finished=true;break;}}}
