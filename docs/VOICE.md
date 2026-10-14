# Voice mode: work from the phone, the car or the gym

Goal: hear what needs you, answer by voice, keep the fleet moving without looking at a screen.

## What existed before this round

- Text to speech: the server renders speech with piper (`/api/tts/<hash>`, cached WAV), played by `public/audio-chip.js` on a tap. Chips read
  a question or a reply, not the options.
- Speech to text: whisper on the server (`POST /api/transcribe`), used by the dock mic (tap to start, tap to stop). The transcript was typed
  into the active session; it was never matched to an open question.
- Questions: stops classified by `stall.js` (`stall.options`, `deriveButtons` in `public/buttons.js`) and the manager's ledger of open asks
  (`/api/owner-asks`). Answered by tapping the ask popup.
- Push: Web Push with a polled feed (`public/sw.js`), digest tiers in `push.js`. Notifications had no buttons.
- Not there: no hands-free queue, no spoken options, no spoken answer, no Media Session, no wake lock, no spoken "what happened".

## What this round built

1. **Queue** (`GET /api/voice/queue`): the open needs-you items, P0 first then oldest. A stop is included when it escalated or waits with options
   or an owner decision. Left out: the manager's own sessions, paused sessions, stops with an automatic answer pending, plain finished turns.
   Ledger asks are included. Each item has a spoken `script`, for example: "alpha needs you. Which approach? Option 1: ... Option 2: ...,
   recommended. Say a number, recommended, yes, no, wait, skip, or repeat."
2. **Spoken answers** (`POST /api/voice/answer`): the transcript is matched to an option of the item. It understands numbers and words
   ("two", "option 2", "the second one"), "recommended", yes and no, "wait", "skip", "next", "repeat", "stop", "what happened" and
   "confirm" / "cancel". "One or two" is not understood and nothing is sent. The item is re-read first; if the stop changed or went away the
   answer is refused (409). A session with a draft in its input box is never typed into. The answer is sent as actor `owner-voice` and logged as
   an owner choice, like a popup tap. A ledger ask is sent to the manager session as `Answer: <Qid> <n>` and confirmed aloud as "Sent option 1 for Q12 to the manager (<session>)"; a ledger question about a sensitive topic needs "confirm" whatever the option says.
3. **Confirm for sensitive topics**: an option that touches deploy, push, delete, credentials, money or customers is not sent until you say
   "confirm". Say "cancel" to drop it. This is the spoken twin of the double tap.
4. **Spoken digest** (`GET /api/voice/digest?minutes=60`, or say "what happened"): open items, sessions that finished a turn, sessions started
   or ended, "Decided for you" (the manager's `decidedView`, read in-process; if that fails, a count of answers typed for you), deploys finished or
   failed, quota above 80 percent. At most 900 characters, plain sentences.
5. **Voice mode page** (More menu > Voice mode, or `/?voice=1`): big Start/Stop, Next, Repeat, Digest and Answer buttons, a mic level bar,
   speed 1x / 1.25x / 1.5x and an auto-listen switch (both remembered on the phone). The loop reads an item, listens until you stop talking
   (about 1.2 seconds of quiet, 8 seconds at most), sends the answer, says what it did, moves to the next. With nothing open it says "Nothing
   needs you." and checks every 20 seconds, with a chime before a new item. Speech comes from piper, with the browser voice as fallback. The
   option buttons on the page are a touch fallback and use the same checks.
6. **Headset and car buttons** (Media Session): play and pause start and stop the loop, next skips, previous repeats; the title is the session.
   The screen stays on while the loop runs (Screen Wake Lock, taken again when the page comes back to the front).
7. **Notification buttons** (screen off): a needs-you push for a stop with a recommended option that is not sensitive gets "Do recommended"
   and "Wait" (when the stop has a wait answer), plus "Speak it" which opens the voice page. Android shows only two buttons on many devices;
   "Wait" is dropped first. A sensitive option is never answered from a notification: it opens the app. "Needs you" alerts are digest-tier unless they are P0, so the buttons appear only when a digest holds exactly one stop;
   interrupt-tier pushes always have them. An id in a button covers the stop id and a hash of the question and options, so a tap on an
   old notification never answers a newer stop (409 "stop changed").

## Using it

**In the car (Android):** install the PWA (More menu > Install app) over the HTTPS address, open Voice mode before you drive, tap Start once
(browsers allow audio and the mic only after a tap), mount the phone, leave the screen on, use the headset's play/pause (start/stop), next
(skip) and previous (repeat). Say "what happened" for the digest.

**At the gym:** same, with the phone in your pocket and a headset. If you lock the screen the loop pauses (see limits); the notification buttons
still work: "Do recommended", "Wait", or "Speak it" when you pick the phone up.

## Honest limits

- iOS Safari and the iOS PWA cannot record the microphone with the screen locked, and suspend page scripts in the background.
- Android also suspends page scripts when the screen is off unless audio is playing. The loop therefore needs the screen on (wake lock keeps
  it on while the page is visible), or you rely on notifications and their buttons. Between spoken lines no audio plays, so headset buttons may
  go to another app; keep the page in front.
- Speech recognition is whisper on the server (`/api/transcribe`), not the browser's Web Speech API. It needs the optional `faster-whisper`
  install and a secure context (https) for the microphone. Short answers can be misheard; anything not understood is asked again, never guessed.
- No wake word: the loop listens after each question, not all the time.
- Piper is English only, one voice. The first rendering of a new sentence takes a moment; the browser voice speaks when piper is missing.
- A notification button needs the service worker to reach the server; if the phone is offline it shows "Not answered".

## MANUAL checks on the phone

1. Open the PWA, More menu > Voice mode. The page is full screen with big buttons; Close returns to the dashboard. `/?voice=1` opens it directly.
2. Tap Start with a stop open. You hear the session, the question and the options. The state line shows Reading, then Listening, with the mic bar moving.
3. Say "option two" (or "recommended"). It sends, says "Sent ... to <session>", and the stop disappears from the dashboard. Say a nonsense word: it asks again.
4. With a stop that touches a sensitive topic: it asks you to say "confirm"; "cancel" drops it.
5. Say "what happened": you hear the digest. Press Digest: same.
6. With nothing open you hear "Nothing needs you." Open a new stop from another session: a chime, then the item.
7. Change speed to 1.5x and turn auto-listen off; reload; the settings are still there. With auto-listen off, tap Answer to speak.
8. Connect a headset or Bluetooth: play/pause toggles the loop, next skips, previous repeats; the lock screen shows the session name.
9. Leave the screen idle for a minute while the loop runs: the screen stays on. Switch to another app and back: it keeps going.
10. Lock the phone with a stop open: the notification shows "Do recommended" (when the stop has a safe recommended option) and "Speak it". Tap
    "Do recommended": a notification says Answered and the session continues. Tap "Speak it": the voice page opens.
11. Type a draft into a session's input box, then answer that stop by voice: it refuses and says there is a draft.
