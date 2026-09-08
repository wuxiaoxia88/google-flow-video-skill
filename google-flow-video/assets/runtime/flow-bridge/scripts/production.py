#!/usr/bin/env python3
"""Deterministic post-production companion for FlowBridge.

The CLI is deliberately independent of the Flow submission database.  It freezes
creative/audio inputs, prepares a guarded one-take TTS request, assembles locked
stems, and records technical QC without converting human listening into a pass.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import math
from pathlib import Path
from typing import Any


class ProductionError(Exception):
    pass


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(canonical(value)); f.flush(); os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def load(path: Path) -> dict[str, Any]:
    try: return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e: raise ProductionError(f"invalid JSON {path}: {e}") from e


def resolve(base: Path, value: str) -> Path:
    p = Path(value)
    return p if p.is_absolute() else (base / p).resolve()


def number(value: Any, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or (positive and value <= 0):
        raise ProductionError(f"{label} must be a finite{' positive' if positive else ''} number")
    return float(value)


def locked_file(base: Path, item: Any, label: str) -> Path:
    if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("sha256"), str):
        raise ProductionError(f"{label} requires path and sha256")
    p = resolve(base, item["path"])
    if not p.is_file(): raise ProductionError(f"{label} file missing: {p}")
    actual = sha_file(p)
    if actual != item["sha256"]: raise ProductionError(f"{label} hash mismatch: expected {item['sha256']}, got {actual}")
    return p


def validate_manifest(path: Path) -> tuple[dict[str, Any], Path]:
    m, base = load(path), path.parent.resolve()
    if m.get("schema_version") != 1: raise ProductionError("schema_version must be 1")
    if not isinstance(m.get("run_id"),str) or not m["run_id"].strip(): raise ProductionError("run_id is required")
    creative = m.get("creative")
    if not isinstance(creative, dict): raise ProductionError("creative object is required")
    master = locked_file(base, creative.get("original_prompt"), "creative.original_prompt")
    override = locked_file(base, creative.get("audio_override"), "creative.audio_override")
    if not master.read_text(encoding="utf-8").strip(): raise ProductionError("original prompt is empty")
    if not override.read_text(encoding="utf-8").strip(): raise ProductionError("audio override is empty")
    timeline = m.get("timeline")
    if not isinstance(timeline, dict): raise ProductionError("timeline object is required")
    duration=number(timeline.get("duration_seconds"),"timeline.duration_seconds",positive=True)
    shots = timeline.get("shots")
    if not isinstance(shots, list) or not shots: raise ProductionError("timeline.shots must be a non-empty array")
    cursor = 0.0
    for i, shot in enumerate(shots):
        if not isinstance(shot, dict): raise ProductionError(f"shot {i+1} must be an object")
        start=number(shot.get("start_seconds"),f"shot {i+1} start"); end=number(shot.get("end_seconds"),f"shot {i+1} end")
        if abs(start-cursor) > .001 or end <= start:
            raise ProductionError(f"shot {i+1} timing must be positive, contiguous, and ordered")
        source_duration = number(shot.get("source_duration_seconds", end-start),f"shot {i+1} source duration",positive=True)
        if abs(source_duration-(end-start)) > .001 and shot.get("allow_retime") is not True:
            raise ProductionError(f"shot {i+1} changes duration without allow_retime=true")
        if not isinstance(shot.get("visual_scope"),str) or not shot["visual_scope"].strip(): raise ProductionError(f"shot {i+1} visual_scope is required")
        number(shot.get("provider_duration_seconds"),f"shot {i+1} provider duration",positive=True)
        if not isinstance(shot.get("model"),str) or not shot["model"]: raise ProductionError(f"shot {i+1} model is required")
        cursor = float(end)
    if abs(cursor-duration) > .001: raise ProductionError("shots must exactly cover timeline duration")
    tts = m.get("tts")
    for k in ("provider", "model", "voice", "single_take"):
        if not isinstance(tts, dict) or k not in tts: raise ProductionError(f"tts.{k} is required")
    if tts["single_take"] is not True: raise ProductionError("tts.single_take must be true")
    stems = m.get("stems")
    for key in ("video", "music", "voice"):
        if not isinstance(stems, dict) or key not in stems: raise ProductionError(f"stems.{key} is required")
    timings = stems["voice"].get("line_timings") if isinstance(stems["voice"], dict) else None
    if not isinstance(timings, list) or not timings: raise ProductionError("stems.voice.line_timings is required")
    last = 0.0
    for i, line in enumerate(timings):
        if not isinstance(line, dict) or not isinstance(line.get("text"), str) or not line["text"].strip(): raise ProductionError(f"line timing {i+1} text is required")
        start=number(line.get("start_seconds"),f"line timing {i+1} start"); end=number(line.get("end_seconds"),f"line timing {i+1} end")
        if start < last-.001 or end <= start or end > duration+.001:
            raise ProductionError(f"line timing {i+1} is invalid or overlaps")
        last = float(end)
    delivery=m.get("delivery")
    if not isinstance(delivery,dict) or delivery.get("aspect_ratio") not in ("16:9","9:16") or not isinstance(delivery.get("resolution"),str): raise ProductionError("delivery aspect_ratio and resolution are required")
    number(delivery.get("fps"),"delivery.fps",positive=True)
    return m, base


def derived_prompt(master: str, override: str) -> str:
    return (master + "\n[本次音频执行覆盖]\n" + override +
        "\n保留原文中的对白语义、表演动作、口型与时间结构作为画面参考。"
        "不要生成任何口头语言、对白、旁白、歌词或可识别人声；生成内容仅包含画面与背景音乐。"
        "此要求是生成提示，不能证明供应商输出一定无人声，成片仍须分轨与人工试听验收。\n")


def cmd_derive(manifest_path: Path, out_dir: Path) -> dict[str, Any]:
    m, base = validate_manifest(manifest_path)
    master_item, override_item = m["creative"]["original_prompt"], m["creative"]["audio_override"]
    master_path, override_path = locked_file(base, master_item, "original_prompt"), locked_file(base, override_item, "audio_override")
    prompt = derived_prompt(master_path.read_text(encoding="utf-8"), override_path.read_text(encoding="utf-8"))
    out_dir.mkdir(parents=True, exist_ok=True)
    prompt_path = out_dir / "flow-derived-prompt.txt"; prompt_path.write_text(prompt, encoding="utf-8")
    ledger_id=f"{m['run_id']}-flow-parent"
    atomic_json(out_dir/"flow-ledger-plan.json",{"ledger_id":ledger_id,"cap_credits":50,"command":["pnpm","--silent","flowctl","budget","create","--id",ledger_id]})
    requests=[]
    for i, shot in enumerate(m["timeline"]["shots"]):
        scoped=prompt+f"\n[镜头执行范围]\n全片时间 {shot['start_seconds']:.3f}s–{shot['end_seconds']:.3f}s 映射为本次生成片段 0.000s–{shot['provider_duration_seconds']:.3f}s。仅执行以下视觉与动作范围：{shot['visual_scope']}\n不得在本镜头补写、提前或重复其他镜头动作。\n"
        request={"backend":"flow_ui","idempotency_key":f"{m['run_id']}-shot-{i+1:02d}","project":{"name":m.get("project_name",m["run_id"]),"reuse":True},"mode":shot.get("mode","text_to_video"),"prompt":scoped,"prompt_mode":"verbatim","model":shot["model"],"aspect_ratio":m["delivery"]["aspect_ratio"],"duration_seconds":shot["provider_duration_seconds"],"resolution":m["delivery"]["resolution"],"outputs":1,"download":{"enabled":True,"directory":str((out_dir/"downloads").resolve()),"format":"mp4"},"cost_policy":{"max_credits":50,"confirm_above":50,"reject_when_unknown":True},"budget_group":{"ledger_id":ledger_id,"step_key":f"shot-{i+1:02d}"}}
        request_path=out_dir/f"flow-request-shot-{i+1:02d}.json"; atomic_json(request_path,request)
        requests.append(request)
    with tempfile.TemporaryDirectory(prefix="flowbridge-derive-") as td:
        env={**os.environ,"FLOWBRIDGE_DB_PATH":str(Path(td)/"validate.sqlite")}
        for i in range(len(requests)):
            p=subprocess.run(["pnpm","--silent","flowctl","generate","--file",str(out_dir/f"flow-request-shot-{i+1:02d}.json"),"--no-run"],cwd=Path(__file__).resolve().parents[1],env=env,text=True,capture_output=True)
            if p.returncode: raise ProductionError(f"derived Flow request {i+1} failed flowctl parse: {p.stderr or p.stdout}")
    record={"kind":"production-derivation","original_prompt":master_item,"audio_override":override_item,"derived_prompt":{"path":str(prompt_path),"sha256":sha_file(prompt_path)},"flow_requests":len(requests),"parent_budget_ledger":ledger_id,"flowctl_no_run_validation":"PASS","provider_silence_guaranteed":False}
    atomic_json(out_dir/"DERIVATION.json",record); return record


def tts_request(m: dict[str,Any], base: Path) -> dict[str,Any]:
    text="\n".join(x["text"] for x in m["stems"]["voice"]["line_timings"])
    provider=m["tts"]["provider"]
    if provider not in ("MMX","MMX_FIXTURE"): raise ProductionError("TTS provider must be MMX; MMX_FIXTURE is test-only")
    if provider=="MMX_FIXTURE" and not (m["tts"].get("fixture") is True and os.environ.get("FLOWBRIDGE_PRODUCTION_TEST")=="1"):
        raise ProductionError("MMX_FIXTURE requires explicit test mode")
    output=resolve(base,m["tts"].get("output_path", ""))
    if not m["tts"].get("output_path"): raise ProductionError("tts.output_path is required")
    params=m["tts"].get("parameters",{})
    if not isinstance(params,dict): raise ProductionError("tts.parameters must be an object")
    allowed={"speed","volume","pitch","format","sample_rate","bitrate","channels","language","subtitles","pronunciation","sound_effect"}
    if set(params)-allowed: raise ProductionError(f"unsupported MMX parameters: {sorted(set(params)-allowed)}")
    execution={"adapter":"mmx-speech-synthesize-v1","output_path":str(output),"provider":provider}
    return {"provider":provider,"model":m["tts"]["model"],"voice":m["tts"]["voice"],"parameters":params,"single_take":True,"text":text,"text_sha256":sha_bytes(text.encode("utf-8")),"execution":execution}


def mmx_argv(intent: dict[str,Any], state_dir: Path) -> list[str]:
    req=intent["request"]; output=req["execution"]["output_path"]
    if req["provider"]=="MMX_FIXTURE":
        exe=os.environ.get("FLOWBRIDGE_TEST_MMX_EXECUTABLE")
        if not exe: raise ProductionError("test MMX executable is missing")
        return [exe,str(state_dir/"tts-text.txt"),output]
    argv=["mmx","speech","synthesize","--text-file",str(state_dir/"tts-text.txt"),"--model",req["model"],"--voice",req["voice"],"--out",output,"--non-interactive","--quiet"]
    flags={"speed":"--speed","volume":"--volume","pitch":"--pitch","format":"--format","sample_rate":"--sample-rate","bitrate":"--bitrate","channels":"--channels","language":"--language","sound_effect":"--sound-effect"}
    for key,flag in flags.items():
        if key in req["parameters"]: argv += [flag,str(req["parameters"][key])]
    if req["parameters"].get("subtitles") is True: argv.append("--subtitles")
    for value in req["parameters"].get("pronunciation",[]): argv += ["--pronunciation",str(value)]
    return argv


def cmd_tts_prepare(path: Path, state_dir: Path) -> dict[str,Any]:
    m,base=validate_manifest(path); req=tts_request(m,base); request_hash=sha_bytes(canonical(req)); intent_path=state_dir/"tts-intent.json"
    if intent_path.exists():
        old=load(intent_path)
        if old.get("request_sha256") != request_hash: raise ProductionError("existing TTS intent is bound to a different request")
        return old
    state_dir.mkdir(parents=True,exist_ok=True)
    text_path=state_dir/"tts-text.txt"; text_path.write_text(req["text"],encoding="utf-8")
    value={"kind":"tts-submission-intent","request_sha256":request_hash,"execution_sha256":sha_bytes(canonical({"request_sha256":request_hash,"argv":mmx_argv({"request":req},state_dir),"output_path":req["execution"]["output_path"],"text_file_sha256":sha_file(text_path)})),"request":req,"text_file":{"path":str(text_path),"sha256":sha_file(text_path)},"paid_submission_enabled":False,"status":"prepared","created_at":dt.datetime.now(dt.timezone.utc).isoformat(),"actual_cost":None}
    atomic_json(intent_path,value); return value


def authorization_ok(path: Path, request_hash: str, run_id: str) -> bool:
    a=load(path)
    try:
        recorded=dt.datetime.fromisoformat(a.get("recorded_at","").replace("Z","+00:00"))
        age=(dt.datetime.now(dt.timezone.utc)-recorded.astimezone(dt.timezone.utc)).total_seconds()
    except (ValueError,TypeError): return False
    return a.get("kind")=="current_run_tts_authorization" and a.get("explicitly_authorized") is True and a.get("request_sha256")==request_hash and a.get("run_id")==run_id and 0 <= age <= 86400


def cmd_tts_submit(path: Path, state_dir: Path, authorization: Path|None, dry_run: bool, mock: bool) -> dict[str,Any]:
    intent=cmd_tts_prepare(path,state_dir); intent_path=state_dir/"tts-intent.json"
    if dry_run:
        return {"kind":"MOCK" if mock else "DRY_RUN","provider_called":False,"request_sha256":intent["request_sha256"]}
    if mock:
        raise ProductionError("mock submission is permitted only with --dry-run")
    if intent.get("status") != "prepared": raise ProductionError("existing TTS intent is not prepared; automatic resubmission is forbidden")
    m,base=validate_manifest(path)
    if authorization is None or not authorization_ok(authorization,intent["request_sha256"],str(m.get("run_id",""))): raise ProductionError("paid TTS is disabled without a matching current-run authorization record")
    current=tts_request(m,base); current_hash=sha_bytes(canonical(current))
    if current_hash!=intent["request_sha256"]: raise ProductionError("manifest TTS request differs from prepared intent")
    if sha_file(Path(intent["text_file"]["path"]))!=intent["text_file"]["sha256"]: raise ProductionError("frozen TTS text changed")
    argv=mmx_argv(intent,state_dir); execution_hash=sha_bytes(canonical({"request_sha256":current_hash,"argv":argv,"output_path":current["execution"]["output_path"],"text_file_sha256":intent["text_file"]["sha256"]}))
    if execution_hash!=intent["execution_sha256"]: raise ProductionError("MMX execution differs from prepared intent")
    output=Path(current["execution"]["output_path"])
    if output.exists(): raise ProductionError("TTS output already exists before submission; refusing ambiguous overwrite")
    claim=state_dir/"tts-submit.claim"
    try: claim.mkdir()
    except FileExistsError: raise ProductionError("TTS submission claim already exists; concurrent, crashed, or prior submit cannot be retried automatically")
    intent["status"]="submitting"; intent["paid_submission_enabled"]=True; intent["submitted_at"]=dt.datetime.now(dt.timezone.utc).isoformat(); atomic_json(intent_path,intent)
    try:
        result=subprocess.run(argv,cwd=base,text=True,capture_output=True)
    except OSError as error:
        intent["status"]="unknown"
        intent["failure"]={"classification":"launch_failure","error_type":type(error).__name__,"errno":error.errno}
        atomic_json(intent_path,intent)
        raise ProductionError("TTS executable could not be started after claim; state is unknown and automatic resubmission is forbidden") from None
    if result.returncode != 0:
        intent["status"]="unknown"; intent["returncode"]=result.returncode; atomic_json(intent_path,intent)
        raise ProductionError("TTS command failed after intent; inspect existing provider/output state, do not resubmit")
    if not output.is_file():
        intent["status"]="unknown"; atomic_json(intent_path,intent); raise ProductionError("TTS command returned without explicit output; do not resubmit")
    info=probe(output)
    if not any(s.get("codec_type")=="audio" for s in info.get("streams",[])): intent["status"]="unknown"; atomic_json(intent_path,intent); raise ProductionError("TTS output is not valid audio; do not resubmit")
    receipt={"kind":"tts-result-receipt","request_sha256":intent["request_sha256"],"execution_sha256":intent["execution_sha256"],"intent_path":str(intent_path.resolve()),"status":"completed","output":{"path":str(output),"sha256":sha_file(output),"probe":info},"actual_cost":None,"actual_cost_status":"unknown","completed_at":dt.datetime.now(dt.timezone.utc).isoformat()}
    atomic_json(state_dir/"tts-receipt.json",receipt); intent["status"]="completed"; atomic_json(intent_path,intent); return receipt


def cmd_tts_recover(state_dir: Path) -> dict[str,Any]:
    receipt_path=state_dir/"tts-receipt.json"
    if not receipt_path.exists(): raise ProductionError("no completed receipt exists; recovery cannot submit or infer success")
    r=load(receipt_path); intent=load(state_dir/"tts-intent.json"); p=Path(r["output"]["path"])
    if intent.get("status")!="completed" or r.get("request_sha256")!=intent.get("request_sha256") or r.get("execution_sha256")!=intent.get("execution_sha256") or Path(r.get("intent_path","")).resolve()!=(state_dir/"tts-intent.json").resolve(): raise ProductionError("receipt does not match completed intent lineage")
    if not p.is_file() or sha_file(p)!=r["output"]["sha256"]: raise ProductionError("receipt output is missing or changed")
    return r


def run(argv: list[str]) -> str:
    p=subprocess.run(argv,text=True,capture_output=True)
    if p.returncode: raise ProductionError(f"{argv[0]} failed: {p.stderr.strip()}")
    return p.stdout


def probe(path: Path) -> dict[str,Any]:
    return json.loads(run(["ffprobe","-v","error","-show_streams","-show_format","-of","json",str(path)]))


def media_duration(info: dict[str,Any]) -> float:
    return number(float(info.get("format",{}).get("duration","nan")),"media duration",positive=True)


def validate_stem(path: Path, kind: str, duration: float, delivery: dict[str,Any]|None=None) -> dict[str,Any]:
    info=probe(path); streams=info.get("streams",[]); videos=[s for s in streams if s.get("codec_type")=="video"]; audios=[s for s in streams if s.get("codec_type")=="audio"]
    if abs(media_duration(info)-duration)>.05: raise ProductionError(f"{kind} duration does not match timeline")
    if kind=="video":
        if len(videos)!=1: raise ProductionError("video stem must have exactly one video stream")
        v=videos[0]; ratio=v.get("width",0)/v.get("height",1); expected=16/9 if delivery["aspect_ratio"]=="16:9" else 9/16
        if abs(ratio-expected)>.015: raise ProductionError("video stem aspect ratio does not match delivery")
        rate=v.get("avg_frame_rate","0/1").split("/"); fps=float(rate[0])/float(rate[1])
        if abs(fps-number(delivery["fps"],"delivery.fps",positive=True))>.001: raise ProductionError("video stem fps does not match delivery")
        short=min(v["width"],v["height"]); expected_short=int(delivery["resolution"].removesuffix("p"))
        if short!=expected_short: raise ProductionError("video stem resolution does not match delivery")
    elif not audios: raise ProductionError(f"{kind} stem has no audio")
    return info


def cmd_prepare_video(path: Path, out: Path) -> dict[str,Any]:
    m,base=validate_manifest(path); inputs=[]; filters=[]
    for i,shot in enumerate(m["timeline"]["shots"]):
        p=locked_file(base,shot.get("source"),f"shot {i+1} source"); info=probe(p)
        start=number(shot.get("source_start_seconds",0),f"shot {i+1} source start"); used=number(shot["source_duration_seconds"],f"shot {i+1} source duration",positive=True); target=shot["end_seconds"]-shot["start_seconds"]
        if media_duration(info)+.02<start+used: raise ProductionError(f"shot {i+1} source trim exceeds media")
        ratio=target/used
        filters.append(f"[{i}:v]trim=start={start}:duration={used},setpts={ratio:.12f}*(PTS-STARTPTS),fps={m['delivery']['fps']}[v{i}]")
        inputs.append(p)
    filters.append("".join(f"[v{i}]" for i in range(len(inputs)))+f"concat=n={len(inputs)}:v=1:a=0[v]")
    out.parent.mkdir(parents=True,exist_ok=True)
    argv=["ffmpeg","-v","error"]+sum((["-i",str(p)] for p in inputs),[])+["-filter_complex",";".join(filters),"-map","[v]","-c:v","libx264","-pix_fmt","yuv420p","-t",str(m["timeline"]["duration_seconds"]),"-y",str(out)]
    run(argv); info=validate_stem(out,"video",m["timeline"]["duration_seconds"],m["delivery"])
    return {"kind":"prepared-video-master","path":str(out),"sha256":sha_file(out),"probe":info,"shots":len(inputs)}


def cmd_voice_place(path: Path, source: Path, source_sha256: str, out: Path, gain_db: float) -> dict[str,Any]:
    m,base=validate_manifest(path)
    if sha_file(source)!=source_sha256: raise ProductionError("single-take source hash mismatch")
    info=probe(source); source_duration=media_duration(info); lines=m["stems"]["voice"]["line_timings"]; filters=[]; labels=[]
    for i,line in enumerate(lines):
        ss=number(line.get("source_start_seconds"),f"line {i+1} source start"); se=number(line.get("source_end_seconds"),f"line {i+1} source end")
        if se<=ss or se>source_duration+.01: raise ProductionError(f"line {i+1} source range invalid")
        if se-ss > line["end_seconds"]-line["start_seconds"]+.001: raise ProductionError(f"line {i+1} source audio exceeds target window; implicit speed change forbidden")
        delay=round(line["start_seconds"]*1000); filters.append(f"[0:a]atrim=start={ss}:end={se},asetpts=PTS-STARTPTS,volume={gain_db}dB,adelay={delay}|{delay}[a{i}]"); labels.append(f"[a{i}]")
    filters.append("[1:a]"+"".join(labels)+f"amix=inputs={len(labels)+1}:duration=first:normalize=0[a]")
    out.parent.mkdir(parents=True,exist_ok=True); run(["ffmpeg","-v","error","-i",str(source),"-f","lavfi","-t",str(m["timeline"]["duration_seconds"]),"-i","anullsrc=r=48000:cl=stereo","-filter_complex",";".join(filters),"-map","[a]","-ar","48000","-ac","2","-c:a","pcm_s16le","-t",str(m["timeline"]["duration_seconds"]),"-y",str(out)])
    placed=validate_stem(out,"voice",m["timeline"]["duration_seconds"])
    return {"kind":"placed-voice-master","single_take":{"path":str(source),"sha256":source_sha256},"path":str(out),"sha256":sha_file(out),"global_gain_db":gain_db,"probe":placed}


def cmd_assemble(path: Path, out_dir: Path) -> dict[str,Any]:
    m,base=validate_manifest(path); duration=str(m["timeline"]["duration_seconds"]); stems=m["stems"]
    video=locked_file(base,stems["video"],"stems.video"); music=locked_file(base,stems["music"],"stems.music"); voice=locked_file(base,stems["voice"],"stems.voice")
    validate_stem(video,"video",m["timeline"]["duration_seconds"],m["delivery"]); validate_stem(music,"music",m["timeline"]["duration_seconds"]); validate_stem(voice,"voice",m["timeline"]["duration_seconds"])
    out_dir.mkdir(parents=True,exist_ok=True)
    outputs={"video_only":out_dir/"video-only.mp4","background_only":out_dir/"background-only.mp4","redub":out_dir/"redub.mp4"}
    run(["ffmpeg","-v","error","-i",str(video),"-map","0:v:0","-c:v","copy","-an","-t",duration,"-y",str(outputs["video_only"])])
    run(["ffmpeg","-v","error","-i",str(video),"-i",str(music),"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-ar","48000","-ac","2","-t",duration,"-y",str(outputs["background_only"])])
    run(["ffmpeg","-v","error","-i",str(video),"-i",str(music),"-i",str(voice),"-filter_complex","[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[a]","-map","0:v:0","-map","[a]","-c:v","copy","-c:a","aac","-ar","48000","-ac","2","-t",duration,"-y",str(outputs["redub"])])
    result={"kind":"production-assembly","timeline":m["timeline"],"inputs":{k:{"path":str(p),"sha256":sha_file(p)} for k,p in (("video",video),("music",music),("voice",voice))},"outputs":{k:{"path":str(p),"sha256":sha_file(p),"probe":probe(p)} for k,p in outputs.items()}}
    atomic_json(out_dir/"ASSEMBLY.json",result); return result


def cmd_qc(assembly_path: Path, out: Path) -> dict[str,Any]:
    a=load(assembly_path); media={}; outputs=a.get("outputs")
    if not isinstance(outputs,dict) or set(outputs)!={"video_only","background_only","redub"}: raise ProductionError("assembly must contain exactly video_only, background_only, and redub outputs")
    duration=number(a.get("timeline",{}).get("duration_seconds"),"assembly timeline duration",positive=True)
    for key,item in outputs.items():
        p=Path(item["path"])
        if sha_file(p)!=item["sha256"]: raise ProductionError(f"{key} output hash mismatch")
        info=probe(p); run(["ffmpeg","-v","error","-xerror","-i",str(p),"-map","0","-f","null","-"])
        audio=any(s.get("codec_type")=="audio" for s in info.get("streams",[]))
        if abs(media_duration(info)-duration)>.05: raise ProductionError(f"{key} duration differs from timeline")
        if (key=="video_only" and audio) or (key!="video_only" and not audio): raise ProductionError(f"{key} has the wrong audio stream contract")
        volume=None
        if audio:
            q=subprocess.run(["ffmpeg","-hide_banner","-i",str(p),"-vn","-af","volumedetect","-f","null","-"],text=True,capture_output=True)
            volume={line.strip() for line in q.stderr.splitlines() if "mean_volume:" in line or "max_volume:" in line}
            if q.returncode or len(volume)!=2: raise ProductionError(f"{key} volume readback failed")
        media[key]={"sha256":item["sha256"],"probe":info,"full_decode":"PASS","volume_readback":sorted(volume) if volume else None}
    result={"kind":"production-qc","technical_status":"PASS","media":media,"asr_status":"not_run","human_audio_status":"REQUIRED","human_checks":["Mandarin tones and pronunciation","single consistent timbre","residual generated voice","music balance and artifacts","line timing and lip/action fit"],"claim_boundary":"ASR spelling and technical decode do not establish pronunciation, timbre, or absence of audible residual voice."}
    atomic_json(out,result); return result


def main() -> int:
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest="command",required=True)
    for name in ("validate","derive","tts-prepare","assemble"):
        q=sub.add_parser(name); q.add_argument("--manifest",type=Path,required=True)
        if name in ("derive","assemble"): q.add_argument("--out-dir",type=Path,required=True)
        if name=="tts-prepare": q.add_argument("--state-dir",type=Path,required=True)
    q=sub.add_parser("tts-submit"); q.add_argument("--manifest",type=Path,required=True); q.add_argument("--state-dir",type=Path,required=True); q.add_argument("--authorization",type=Path); q.add_argument("--dry-run",action="store_true"); q.add_argument("--mock",action="store_true")
    q=sub.add_parser("tts-recover"); q.add_argument("--state-dir",type=Path,required=True)
    q=sub.add_parser("prepare-video"); q.add_argument("--manifest",type=Path,required=True); q.add_argument("--out",type=Path,required=True)
    q=sub.add_parser("voice-place"); q.add_argument("--manifest",type=Path,required=True); q.add_argument("--source",type=Path,required=True); q.add_argument("--source-sha256",required=True); q.add_argument("--out",type=Path,required=True); q.add_argument("--gain-db",type=float,default=0)
    q=sub.add_parser("qc"); q.add_argument("--assembly",type=Path,required=True); q.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if a.command=="validate": m,_=validate_manifest(a.manifest); result={"ok":True,"kind":"production-manifest","run_id":m.get("run_id")}
    elif a.command=="derive": result=cmd_derive(a.manifest,a.out_dir)
    elif a.command=="tts-prepare": result=cmd_tts_prepare(a.manifest,a.state_dir)
    elif a.command=="tts-submit": result=cmd_tts_submit(a.manifest,a.state_dir,a.authorization,a.dry_run,a.mock)
    elif a.command=="tts-recover": result=cmd_tts_recover(a.state_dir)
    elif a.command=="prepare-video": result=cmd_prepare_video(a.manifest,a.out)
    elif a.command=="voice-place": result=cmd_voice_place(a.manifest,a.source,a.source_sha256,a.out,number(a.gain_db,"gain-db"))
    elif a.command=="assemble": result=cmd_assemble(a.manifest,a.out_dir)
    else: result=cmd_qc(a.assembly,a.out)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True)); return 0


if __name__=="__main__":
    try: raise SystemExit(main())
    except ProductionError as e:
        print(json.dumps({"ok":False,"error":str(e)},ensure_ascii=False),file=sys.stderr); raise SystemExit(2)
