#!/usr/bin/env python3
# Replay one day of manager wakes through the rules before the manager (TASK-239 G6): python3 scripts/manager-wake-rules-replay.py <YYYY-MM-DD>.
# Read-only: the filter runs against a temp state dir. Prints wakes and wakes that did nothing before / after, what removed them, and every removed wake that had acted.
import json,sys,collections,bisect,re,subprocess,os,tempfile
day=sys.argv[1]; st=os.path.expanduser("~/.local/state/ghosty")
evs=subprocess.run(f"cat {st}/manager-events.jsonl.1 {st}/manager-events.jsonl 2>/dev/null | grep \"^{{\\\"at\\\":\\\"{day}\"",shell=True,capture_output=True,text=True).stdout
flt=os.path.join(os.path.dirname(os.path.abspath(__file__)),"manager-event-filter.sh"); ev=[]
for q in range(4):   # the cross-run dedupe lasts 6 h: one fresh state per 6-hour slice
    part="".join(l+"\n" for l in evs.splitlines() if q*6<=int(l[18:20])<q*6+6)
    tmp=tempfile.mkdtemp(prefix="wakeev-an"); os.makedirs(tmp+"/manager-reports")
    out=subprocess.run(["bash",flt],input=part,capture_output=True,text=True,env={**os.environ,"GHOSTY_STATE_DIR":tmp}).stdout
    ev+=[json.loads(l) for l in out.splitlines() if l]
allw=[]
for l in open(st+"/manager-wakes.jsonl"):
    try: r=json.loads(l)
    except: continue
    if str(r.get("start","")).startswith(day): allw.append(r)
isw=lambda r: r.get("trigger")=="task_done" and "manager-wait" in (r.get("triggerSummary") or "")
wk=sorted([r for r in allw if isw(r)],key=lambda r:r["start"]); starts=[w["start"] for w in wk]
bg=[r for r in allw if r.get("trigger")=="task_done" and not isw(r)]; rest=[r for r in allw if r.get("trigger")!="task_done"]
def rule(e):   # the filter already dropped and deduped; what it marks `d` rides with the next wake
    return "defer:rides with the next wake" if e.get("d") else None
per=collections.defaultdict(list); stopev=collections.defaultdict(bool)
STOP=re.compile(r'(^|:)(asks|needs-manager)$')
isstop=lambda e: bool(STOP.search(str(e.get('kind','')))) or (str(e.get('key','')).endswith(':manager-item') and bool(re.match(r'\S+ asks:',str(e.get('body','')))))
for e in ev:
    i=bisect.bisect_left(starts,e["l"]["at"])
    if i<len(wk): per[i].append(rule(e)); stopev[i]|=isstop(e['l'])
surv=[];why=collections.Counter();lost=[];deferred=[]
for i,w in enumerate(wk):
    L=per.get(i)
    if not L:
        if "ScheduleWakeup" in (w.get("tools") or {}): surv.append(dict(acted=not w.get("nothing"),t=w["start"],stop=False))   # a sweep
        else:
            why["no event under the current filter"]+=1
            if not w.get("nothing"): lost.append(("noev",w["start"][11:16],(w.get("decision") or "")[:140]))
        continue
    if all(r and r.startswith("drop") for r in L):
        for r in set(L): why[r]+=1
        if not w.get("nothing"): lost.append((sorted(set(L)),w["start"][11:16],(w.get("decision") or "")[:140].replace("\n"," ")))
        continue
    if all(r for r in L):   # only deferred (+dropped)
        deferred.append(dict(acted=not w.get("nothing"),t=w["start"])); why["defer:rides with the next wake"]+=1; continue
    surv.append(dict(acted=not w.get("nothing"),t=w["start"],stop=stopev[i]))
# deferred wakes merge into the next surviving wake within 60 min, else one flush wake per hour bucket
import datetime
ts=lambda s: datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
surv.sort(key=lambda x:x["t"]); st_=[ts(x["t"]) for x in surv]; flush={}
for d in deferred:
    j=bisect.bisect_left(st_,ts(d["t"]))
    if j<len(surv) and st_[j]-ts(d["t"])<=3600: surv[j]["acted"]=surv[j]["acted"] or d["acted"]
    else:
        b=int(ts(d["t"])//3600); flush.setdefault(b,dict(acted=False)); flush[b]["acted"]|=d["acted"]
final=surv+list(flush.values())+[dict(acted=not r.get("nothing"),by=r.get('trigger') if r.get('trigger') in ('owner','peer_message') else None) for r in rest]
tot0=len(allw); n0=sum(bool(r.get("nothing")) for r in allw)
tot=len(final); n=sum(not x["acted"] for x in final)
print(day,f"before {n0}/{tot0} ({100*n0/tot0:.0f}%)  after {n}/{tot} ({100*n/tot:.0f}%)")
print("  removed:",dict(why),"| own-background wakes removed",len(bg),"(acted",sum(not r.get("nothing") for r in bg),")","| flush wakes",len(flush))
print("  other triggers kept:",collections.Counter((r.get("trigger"),bool(r.get("nothing"))) for r in rest))
for x in lost: print("  LOST?",x)
# S7 as the scorecard counts it (S7 = wakes the harness caused; owner / peer / lane wakes are their own row) and what is left by kind.
# "stop left unanswered" is what the stop-answer check (stop-answer.js) and the manager's rule remove: counted as acted in the projection.
harness=[x for x in final if not x.get("by")]; other=[x for x in final if x.get("by")]
left_stop=sum(1 for x in harness if not x["acted"] and x.get("stop")); left_noise=sum(1 for x in harness if not x["acted"] and not x.get("stop"))
print(f"  by kind: harness-caused {len(harness)} wakes, empty {left_stop+left_noise} (after a stop {left_stop}, noise {left_noise}); owner/peer {len(other)} wakes, empty {sum(not x['acted'] for x in other)} (own row, not S7)")
print(f"  S7 (harness-caused only): {left_stop+left_noise}/{len(harness)} ({100*(left_stop+left_noise)/max(1,len(harness)):.0f}%); with every stop answered: {left_noise}/{len(harness)} ({100*left_noise/max(1,len(harness)):.0f}%)")
