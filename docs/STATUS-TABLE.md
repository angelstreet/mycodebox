**The seven STATUS words (owner 2026-11-11). Take the first row that is true.**

| # | Word | Use it when | Never when | Who acts next |
|---|---|---|---|---|
| 1 | `done` | The goal is reached, you have the proof, nothing of yours is still running | A part is open, a worker or job of yours still runs, or it is "merged, not checked" | Nobody |
| 2 | `running` | Work **of yours** is still going: your background job, a worker session you started. You will be woken and continue | Nothing is actually running | Nobody; the harness wakes you |
| 3 | `waiting` | You depend on something **not yours** that ends by itself: a lane request, a deploy, a lease ticket, another session's work, a named time | You could work on something else meanwhile, or nothing will ever end it | Nobody; the harness wakes you |
| 4 | `needs-manager` | You need a decision or an answer (technical, merge, deploy, lease, design) | You have a recommendation and the choice is reversible: decide | Manager |
| 5 | `needs-owner` | Money, customers, deleting shared data, a credential only the owner holds, a physical action | Anything else | Owner |
| 6 | `blocked` | You **cannot work** and nothing running will fix it: someone must act (a device is dead, an access is missing) | Something is running or queued (that is `running` or `waiting`) | Manager |
| 7 | `failed` | You stopped and the goal is **not** reached after you tried what you could | You have not tried, or work is still running | Manager |

Forms: `done — <what> · goal: achieved · evidence: <links / run ids / frames>`; `running: <job id / worker names> — <what is left>`; `waiting: <id / ticket / session / time>`; `blocked: <what stops you> · tried: <list> · need: <who must do what>`; `failed — goal not achieved: <why> · tried: <list>`. "blocked: waiting on ..." is never right. A green / pass / proven claim carries its evidence.
