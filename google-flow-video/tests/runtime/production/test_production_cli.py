import hashlib, json, subprocess, tempfile, unittest, os, datetime
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
CLI=ROOT/"scripts/production.py"

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

class ProductionCliTest(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory(); self.d=Path(self.t.name)
        (self.d/"master.txt").write_text("原始全文。对白不能删。",encoding="utf-8")
        (self.d/"override.txt").write_text("中文使用统一外部配音。",encoding="utf-8")
        subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","color=c=blue:s=320x180:r=24:d=2","-c:v","libx264","-pix_fmt","yuv420p","-y",self.d/"video.mp4"],check=True)
        for name,freq in (("music.wav","220"),("voice.wav","440")):
            subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i",f"sine=frequency={freq}:duration=2","-ar","48000","-ac","2","-y",self.d/name],check=True)
        source={"path":"video.mp4","sha256":sha(self.d/"video.mp4")}
        self.manifest={"schema_version":1,"run_id":"fixture","project_name":"Fixture","creative":{"original_prompt":{"path":"master.txt","sha256":sha(self.d/"master.txt")},"audio_override":{"path":"override.txt","sha256":sha(self.d/"override.txt")}},"timeline":{"duration_seconds":2,"shots":[{"start_seconds":0,"end_seconds":1,"source_duration_seconds":1,"source_start_seconds":0,"source":source,"visual_scope":"blue frame first beat","model":"Gemini Omni Flash 1.1","provider_duration_seconds":1},{"start_seconds":1,"end_seconds":2,"source_duration_seconds":1,"source_start_seconds":1,"source":source,"visual_scope":"blue frame second beat","model":"Gemini Omni Flash 1.1","provider_duration_seconds":1}]},"delivery":{"aspect_ratio":"16:9","resolution":"180p","fps":24},"tts":{"provider":"MMX","model":"speech","voice":"one-voice","single_take":True,"parameters":{},"output_path":"generated.wav"},"stems":{"video":{"path":"video.mp4","sha256":sha(self.d/"video.mp4")},"music":{"path":"music.wav","sha256":sha(self.d/"music.wav")},"voice":{"path":"voice.wav","sha256":sha(self.d/"voice.wav"),"line_timings":[{"text":"第一句","start_seconds":0.1,"end_seconds":0.8,"source_start_seconds":0,"source_end_seconds":0.5},{"text":"第二句","start_seconds":1.1,"end_seconds":1.8,"source_start_seconds":0.5,"source_end_seconds":1.0}]}}}
        self.mp=self.d/"manifest.json"; self.write()
    def tearDown(self): self.t.cleanup()
    def write(self): self.mp.write_text(json.dumps(self.manifest,ensure_ascii=False),encoding="utf-8")
    def call(self,*args,ok=True):
        p=subprocess.run(["python3",CLI,*map(str,args)],text=True,capture_output=True)
        if ok and p.returncode: self.fail(p.stderr)
        return p
    def test_derive_preserves_master_and_adds_audio_override(self):
        out=self.d/"derive"; self.call("derive","--manifest",self.mp,"--out-dir",out)
        text=(out/"flow-derived-prompt.txt").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("原始全文。对白不能删。")); self.assertIn("不要生成任何口头语言",text)
        req=json.loads((out/"flow-request-shot-01.json").read_text()); self.assertTrue(req["prompt"].startswith(text)); self.assertIn("全片时间 0.000s–1.000s",req["prompt"]); self.assertEqual(req["budget_group"]["ledger_id"],"fixture-flow-parent")
        self.assertEqual(req["cost_policy"],{"max_credits":200,"confirm_above":200,"reject_when_unknown":True})
        self.assertEqual(req["model_policy"],{"version":1,"required_family":"gemini_omni_flash_1_1","api_code":None,"allow_fallback":False,"execution_backend":"flow_ui","selection_source":"explicit"})
    def test_derive_defaults_missing_model_to_omni(self):
        for shot in self.manifest["timeline"]["shots"]: shot.pop("model")
        self.write(); out=self.d/"derive-default-model"; self.call("derive","--manifest",self.mp,"--out-dir",out)
        req=json.loads((out/"flow-request-shot-01.json").read_text())
        self.assertEqual(req["model"],"Gemini Omni Flash 1.1")
        self.assertEqual(req["model_policy"]["selection_source"],"default")
        self.assertFalse(req["model_policy"]["allow_fallback"])
        self.assertEqual(json.loads((out/"flow-ledger-plan.json").read_text())["cap_credits"],200)
    def test_tts_intent_is_idempotent_and_unknown_cannot_resubmit(self):
        state=self.d/"state"; self.call("tts-prepare","--manifest",self.mp,"--state-dir",state)
        intent=json.loads((state/"tts-intent.json").read_text()); intent["status"]="unknown"; (state/"tts-intent.json").write_text(json.dumps(intent))
        p=self.call("tts-submit","--manifest",self.mp,"--state-dir",state,ok=False)
        self.assertNotEqual(p.returncode,0); self.assertIn("resubmission is forbidden",p.stderr)
    def test_concurrent_tts_claim_executes_fixture_once(self):
        self.manifest["tts"].update({"provider":"MMX_FIXTURE","fixture":True})
        exe=self.d/"fake_mmx.py"; counter=self.d/"counter"
        exe.write_text("#!/usr/bin/env python3\nimport pathlib,subprocess,sys,time\nc=pathlib.Path(sys.argv[0]).with_name('counter')\nc.write_text(c.read_text()+'x' if c.exists() else 'x')\ntime.sleep(.5)\nsubprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-y',sys.argv[2]],check=True)\n")
        exe.chmod(0o755); self.write(); state=self.d/"concurrent"
        env={**os.environ,"FLOWBRIDGE_PRODUCTION_TEST":"1","FLOWBRIDGE_TEST_MMX_EXECUTABLE":str(exe)}
        prep=subprocess.run(["python3",CLI,"tts-prepare","--manifest",self.mp,"--state-dir",state],env=env,text=True,capture_output=True,check=True)
        request_hash=json.loads(prep.stdout)["request_sha256"]
        auth=self.d/"auth.json"; auth.write_text(json.dumps({"kind":"current_run_tts_authorization","explicitly_authorized":True,"run_id":"fixture","request_sha256":request_hash,"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        argv=["python3",CLI,"tts-submit","--manifest",self.mp,"--state-dir",state,"--authorization",auth]
        p1=subprocess.Popen(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True); p2=subprocess.Popen(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        r1=p1.communicate(); r2=p2.communicate()
        self.assertEqual(sorted([p1.returncode,p2.returncode]),[0,2]); self.assertEqual(counter.read_text(),"x")
    def test_missing_tts_executable_persists_unknown_without_traceback(self):
        self.manifest["tts"].update({"provider":"MMX_FIXTURE","fixture":True})
        self.write(); state=self.d/"missing-executable"
        env={**os.environ,"FLOWBRIDGE_PRODUCTION_TEST":"1","FLOWBRIDGE_TEST_MMX_EXECUTABLE":str(self.d/"does-not-exist")}
        prep=subprocess.run(["python3",CLI,"tts-prepare","--manifest",self.mp,"--state-dir",state],env=env,text=True,capture_output=True,check=True)
        request_hash=json.loads(prep.stdout)["request_sha256"]
        auth=self.d/"missing-auth.json"; auth.write_text(json.dumps({"kind":"current_run_tts_authorization","explicitly_authorized":True,"run_id":"fixture","request_sha256":request_hash,"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        p=subprocess.run(["python3",CLI,"tts-submit","--manifest",self.mp,"--state-dir",state,"--authorization",auth],env=env,text=True,capture_output=True)
        self.assertEqual(p.returncode,2); self.assertNotIn("Traceback",p.stderr)
        error=json.loads(p.stderr); self.assertIn("automatic resubmission is forbidden",error["error"])
        intent=json.loads((state/"tts-intent.json").read_text()); self.assertEqual(intent["status"],"unknown"); self.assertEqual(intent["failure"]["classification"],"launch_failure"); self.assertIn(intent["failure"]["error_type"],("FileNotFoundError","PermissionError","OSError")); self.assertTrue((state/"tts-submit.claim").is_dir())
    def test_dry_run_never_calls_provider(self):
        p=self.call("tts-submit","--manifest",self.mp,"--state-dir",self.d/"dry","--dry-run")
        self.assertFalse(json.loads(p.stdout)["provider_called"])
    def test_preexisting_tts_output_is_rejected_and_model_change_conflicts(self):
        state=self.d/"state2"; prep=self.call("tts-prepare","--manifest",self.mp,"--state-dir",state); request_hash=json.loads(prep.stdout)["request_sha256"]
        auth=self.d/"auth2.json"; auth.write_text(json.dumps({"kind":"current_run_tts_authorization","explicitly_authorized":True,"run_id":"fixture","request_sha256":request_hash,"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        (self.d/"generated.wav").write_bytes(b"old")
        p=self.call("tts-submit","--manifest",self.mp,"--state-dir",state,"--authorization",auth,ok=False)
        self.assertIn("already exists",p.stderr)
        self.manifest["tts"]["model"]="changed"; self.write()
        self.assertIn("different request",self.call("tts-prepare","--manifest",self.mp,"--state-dir",state,ok=False).stderr)
    def test_hash_mismatch_rejected(self):
        (self.d/"master.txt").write_text("changed",encoding="utf-8")
        self.assertNotEqual(self.call("validate","--manifest",self.mp,ok=False).returncode,0)
    def test_invalid_timing_and_implicit_retime_rejected(self):
        self.manifest["timeline"]["shots"][1]["source_duration_seconds"]=2
        self.write(); self.assertIn("allow_retime",self.call("validate","--manifest",self.mp,ok=False).stderr)
    def test_prepare_video_and_voice_place_are_finite(self):
        video=self.d/"prepared.mp4"; voice=self.d/"placed.wav"
        self.call("prepare-video","--manifest",self.mp,"--out",video)
        self.call("voice-place","--manifest",self.mp,"--source",self.d/"voice.wav","--source-sha256",sha(self.d/"voice.wav"),"--out",voice,"--gain-db","-4")
        for p in (video,voice):
            duration=float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nk=1:nw=1",p],check=True,text=True,capture_output=True).stdout)
            self.assertAlmostEqual(duration,2,places=2)
    def test_ffmpeg_outputs_and_video_frames_are_identical(self):
        out=self.d/"out"; self.call("assemble","--manifest",self.mp,"--out-dir",out)
        for name in ("video-only.mp4","background-only.mp4","redub.mp4"):
            subprocess.run(["ffmpeg","-v","error","-xerror","-i",out/name,"-map","0","-f","null","-"],check=True)
        hashes=[]
        for name in ("video-only.mp4","background-only.mp4","redub.mp4"):
            p=subprocess.run(["ffmpeg","-v","error","-i",out/name,"-map","0:v:0","-f","framemd5","-"],check=True,capture_output=True)
            hashes.append(hashlib.sha256(p.stdout).hexdigest())
        self.assertEqual(len(set(hashes)),1)
        q=self.call("qc","--assembly",out/"ASSEMBLY.json","--out",out/"QC.json")
        self.assertEqual(json.loads(q.stdout)["human_audio_status"],"REQUIRED")
        empty=self.d/"empty.json"; empty.write_text(json.dumps({"timeline":{"duration_seconds":2},"outputs":{}}))
        self.assertIn("exactly",self.call("qc","--assembly",empty,"--out",self.d/"bad.json",ok=False).stderr)

if __name__=="__main__": unittest.main()
