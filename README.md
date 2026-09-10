# Myanmar Voice Studio — repaired build

## Repairs in this build
- Fixed Whisper/Gradio language dropdown validation. The UI no longer sends invalid values such as `burmese` when an engine exposes `myanmar` (or another legal choice).
- Whisper API endpoints are discovered at runtime with `view_api()` and selected according to URL/file compatibility.
- Uses multiple transcription Spaces with automatic fallback and clears failed client/API caches so a dead Space is retried cleanly.
- Local video files are uploaded directly first; browser audio extraction is used only as a fallback for video files when the selected API rejects the original file.
- Supports URL and downloaded-file transcription paths.
- Transcript can automatically route into the TTS input.
- Added runtime phone/tablet/desktop detection and orientation handling.
- Rebuilt mobile layout to avoid horizontal overflow and use a bottom-sheet transcript panel on phones.
- Restored the requested purple + white glass background instead of black.
- Preserved Myanmar/English UI switch.

## Important
Remote Hugging Face Spaces can still be unavailable, rate-limited, or queued. This build handles that by trying another compatible Space. A private/login-only video URL may still require a local download/upload.

The static smoke test does not claim live GPU availability; it verifies the app wiring, responsive CSS, endpoint-discovery logic, language-choice validation, and JavaScript syntax.


## YouTube transcript repair
- YouTube links now try external transcript services before Hugging Face Whisper.
- Primary: `https://youtube-transcript.ai/transcript/{VIDEO_ID}.txt` — documented as keyless and CORS-open.
- Secondary: `https://youtubetranscribe.khabaroff.studio/transcript/{VIDEO_ID}/txt` — documented as keyless.
- If external services fail, the original Hugging Face Whisper fallback remains.
- Private/login-only videos or videos without available captions can still fail; the UI reports the error and supports local video/audio upload.
