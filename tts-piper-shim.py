# Runs the Python `piper` script with onnxruntime capped to GHOSTY_TTS_THREADS threads (tts.js piperCommand).
# piper builds a default SessionOptions(): one thread per core, each pinned to its core, which also overrides
# taskset; OMP_NUM_THREADS is ignored. An explicit intra_op_num_threads is the limit that holds.
# If onnxruntime cannot be patched, piper runs unchanged.
import os
import runpy
import sys

sys.path.pop(0)  # this file's folder must not shadow piper's imports

try:
    import onnxruntime

    _Options = onnxruntime.SessionOptions

    def _limited(*args, **kwargs):
        options = _Options(*args, **kwargs)
        options.intra_op_num_threads = int(os.environ.get("GHOSTY_TTS_THREADS") or 2)
        options.inter_op_num_threads = 1
        return options

    onnxruntime.SessionOptions = _limited
except Exception as err:  # noqa: BLE001 - a missing limit must not break read-aloud
    print(f"tts: thread limit not applied: {err}", file=sys.stderr)

sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
