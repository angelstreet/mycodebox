#!/usr/bin/env python3
# Voice input worker (spawned by transcribe.js): keeps one faster-whisper model loaded, reads one JSON job per line
# on stdin ({"id", "path", "lang"?}), writes one JSON result per line on stdout ({"id", "text", "lang", "ms"} or {"id", "error"}).
import json, os, sys, time
import warnings
warnings.filterwarnings("ignore")
from faster_whisper import WhisperModel

model = WhisperModel(os.environ.get("WHISPER_MODEL", "base"), device="cpu", compute_type="int8",
                     cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")))
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    try:
        job = json.loads(line)
    except ValueError:
        continue
    t = time.time()
    try:
        segs, info = model.transcribe(job["path"], language=job.get("lang") or None, beam_size=1, vad_filter=True)
        text = " ".join(s.text.strip() for s in segs).strip()
        out = {"id": job.get("id"), "text": text, "lang": info.language, "ms": int((time.time() - t) * 1000)}
    except Exception as e:  # a bad upload must not kill the worker
        out = {"id": job.get("id"), "error": str(e)[:300]}
    print(json.dumps(out), flush=True)
