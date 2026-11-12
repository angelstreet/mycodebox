import json,sys,collections,bisect,re,subprocess,os,tempfile
day=sys.argv[1]; st=os.path.expanduser("~/.local/state/ghosty")
tmp=tempfile.mkdtemp(prefix="wakeev-an"); os.makedirs(tmp+"/manager-reports")
evs=subprocess.run(f"cat {st}/manager-events.jsonl.1 {st}/manager-events.jsonl 2>/dev/null | grep \"^{{\\\"at\\\":\\\"{day}\"",shell=True,capture_output=True,text=True).stdout
out=subprocess.run(["bash",os.path.expanduser("~/mycodebox-wake-rules/scripts/manager-event-filter.sh")],input=evs,capture_output=True,text=True,env={**os.environ,"GHOSTY_STATE_DIR":tmp}).stdout
ev=[json.loads(l) for l in out.splitlines() if l]
allw=[]
for l in open(st+"/manager-wakes.jsonl"):
    try: r=json.loads(l)
    except: continue
    if str(r.get("start","")).startswith(day): allw.append(r)
isw=lambda r: r.get("trigger")=="task_done" and "manager-wait" in (r.get("triggerSummary") or "")
wk=sorted([r for r in allw if isw(r)],key=lambda r:r["start"]); starts=[w["start"] for w in wk]
bg=[r for r in allw if r.get("trigger")=="task_done" and not isw(r)]; rest=[r for r in allw if r.get("trigger")!="task_done"]
seen={}
HANDLED=re.compile(r"said done, git disagrees|done not accepted by the goal check|session closed: |orphaned, \d|bug mentioned, not reported")
def rule(e):
    l=e["l"]; key=str(l.get("key") or ""); kind=str(l.get("kind") or ""); title=str(l.get("title") or ""); body=str(l.get("body") or "")
    if key.endswith(":manager-item") and re.match(r"^\S+ waits for a deploy:",body): return "drop:R1 waiting stop"
    if HANDLED.search(title) or (kind=="lease" and l.get("state")=="idle-hold"): return "drop:R5 harness handled"
    m=re.search(r"(\d+)%",title+" "+body[:80])
    if (kind in("disk","quota") or key.startswith(("disk","quota","health:disk"))) and m:
        pct=int(m.group(1)); b=(key.split(":")[0],l.get("session"),pct//5)
        if pct<95 and b in seen: return "drop:R2 repeat"
        seen[b]=1; return None
    if kind=="bug" and not (l.get("bug") or {}).get("blocking") and l.get("priority") not in ("high","urgent"): return "defer:bug"
    return None
per=collections.defaultdict(list)
for e in ev:
    i=bisect.bisect_left(starts,e["l"]["at"])
    if i<len(wk): per[i].append(rule(e))
surv=[];why=collections.Counter();lost=[];deferred=[]
for i,w in enumerate(wk):
    L=per.get(i)
    if not L:
        if "ScheduleWakeup" in (w.get("tools") or {}): surv.append(dict(acted=not w.get("nothing"),t=w["start"]))   # a sweep
        else:
            why["no event under the current filter"]+=1
            if not w.get("nothing"): lost.append(("noev",w["start"][11:16],(w.get("decision") or "")[:140]))
        continue
    if all(r and r.startswith("drop") for r in L):
        for r in set(L): why[r]+=1
        if not w.get("nothing"): lost.append((sorted(set(L)),w["start"][11:16],(w.get("decision") or "")[:140].replace("\n"," ")))
        continue
    if all(r for r in L):   # only deferred (+dropped)
        deferred.append(dict(acted=not w.get("nothing"),t=w["start"])); why["defer:bug"]+=1; continue
    surv.append(dict(acted=not w.get("nothing"),t=w["start"]))
# deferred wakes merge into the next surviving wake within 60 min, else one flush wake per hour bucket
import datetime
ts=lambda s: datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
surv.sort(key=lambda x:x["t"]); st_=[ts(x["t"]) for x in surv]; flush={}
for d in deferred:
    j=bisect.bisect_left(st_,ts(d["t"]))
    if j<len(surv) and st_[j]-ts(d["t"])<=3600: surv[j]["acted"]=surv[j]["acted"] or d["acted"]
    else:
        b=int(ts(d["t"])//3600); flush.setdefault(b,dict(acted=False)); flush[b]["acted"]|=d["acted"]
final=surv+list(flush.values())+[dict(acted=not r.get("nothing")) for r in rest]
tot0=len(allw); n0=sum(bool(r.get("nothing")) for r in allw)
tot=len(final); n=sum(not x["acted"] for x in final)
print(day,f"before {n0}/{tot0} ({100*n0/tot0:.0f}%)  after {n}/{tot} ({100*n/tot:.0f}%)")
print("  removed:",dict(why),"| own-background wakes removed",len(bg),"(acted",sum(not r.get("nothing") for r in bg),")","| flush wakes",len(flush))
print("  other triggers kept:",collections.Counter((r.get("trigger"),bool(r.get("nothing"))) for r in rest))
for x in lost: print("  LOST?",x)
