# မြန်မာ Voice Studio — Long Text Edition

ဒီ version က 5,000 characters limit ကိုဖယ်ထားပြီး **200,000 characters အထိ** လက်ခံပါတယ်။ 10,000+ characters စာကို AI model တစ်ခါတည်းမပို့ဘဲ sentence-aware chunks (~1,800 chars) ခွဲပြီး တစ်ပိုင်းချင်း generate လုပ်ကာ browser ထဲမှာ audio ကို WAV တစ်ဖိုင်အဖြစ် ပြန်ပေါင်းပေးပါတယ်။

## AI Engines

- **VoxCPM2** — Hugging Face `openbmb/VoxCPM-Demo`။ Current demo API endpoint `/generate` ကို Gradio JS Client နဲ့ခေါ်ပါတယ်။
- **OmniVoice** — Hugging Face `k2-fsa/OmniVoice`။ 600+ languages ကို support လုပ်တဲ့ voice-cloning engine ဖြစ်ပြီး Clone mode မှာ alternative/fallback အဖြစ် အသုံးပြုနိုင်ပါတယ်။
- **Auto** — Clone mode မှာ VoxCPM2 မအောင်မြင်ရင် OmniVoice ကို အလိုအလျောက် fallback လုပ်ပါတယ်။

## Important

Browser-only static site ဖြစ်လို့ third-party API keys မပါဝင်ပါ။ Public Hugging Face Spaces တွေရဲ့ queue/rate limit/sleeping state ပေါ်မူတည်ပြီး generation speed ကွာနိုင်ပါတယ်။

10,000+ characters ကို အပိုင်းခွဲတာက model တစ်ကြိမ်တည်းအတွက် context/timeout ပြဿနာလျှော့ဖို့ ဖြစ်ပါတယ်။ Chunk တစ်ခုချင်းစီကို reference voice နဲ့ပြန် generate လုပ်တာကြောင့် long script တစ်ခုလုံးအတွက် timbre ကို တတ်နိုင်သမျှတူအောင် ထိန်းထားပါတယ်။

## Deploy

ZIP ထဲက `voice-studio/index.html` ကို static hosting မှာတင်နိုင်ပါတယ်။ `@gradio/client` ကို jsDelivr CDN ကနေ browser ထဲမှာ load လုပ်ပါတယ်။

## Long Script Engine
- Scripts are split into conservative ~450-character sentence-aware chunks before Hugging Face generation.
- Each chunk is retried automatically up to 2 attempts.
- In Auto + Voice Cloning mode, VoxCPM is tried first and OmniVoice is used as fallback when VoxCPM fails.
- Successful chunks are merged into one WAV in the browser.
- The UI shows chunk-by-chunk progress so a failure is identifiable.
- This design avoids sending a long movie-recap script as one oversized HF request.

### Testing note
The code was syntax-checked and the chunk/retry flow was tested locally with mocked generation responses. Live Hugging Face generation cannot be claimed from an environment without outbound network access.


## Performance / stability fixes
- Hugging Face Gradio clients are cached per Space instead of reconnecting for every chunk.
- Reference audio FileData is cached per Space/file, avoiding repeated client-side preparation.
- Long scripts are split into conservative 480-character chunks.
- Retry backoff is short and bounded.
- Removed the global touch-ripple animation that could cause visible page flicker.
- Mobile backdrop blur is disabled to reduce GPU repaint/flicker on phones.
- The app still processes TTS sequentially because hosted GPU queues commonly serialize generation; parallel requests can increase queueing rather than speed it up.


## AUTO ENGINE FALLBACK
- Long scripts are split into conservative chunks and generated sequentially.
- Auto mode uses VoxCPM first and OmniVoice as an independent fallback for voice-cloning mode.
- If a provider returns a ZeroGPU quota error, that provider is disabled for the rest of the current run and the next independent provider is tried.
- HF account/token switching remains manual. The app does not automatically rotate accounts or tokens to bypass provider quotas.
- Tokens are stored only in the browser session storage.
