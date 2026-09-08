# Audio policy

Apply this policy only to future requests. Do not rewrite historical prompts, submissions, masters, downloaded Flow assets, or prior QC records.

The Flow prompt must retain the original dialogue's performance and timing reference while adding this execution override:

> Do not generate spoken language, dialogue, narration, lyrics, or recognizable vocal sounds. Keep picture and background music only.

Save the immutable creative master and the current override as separate files and record SHA-256 for both. The derived Flow prompt must preserve the master content and explicitly add the override.

The delivery stems are `video_only`, `music_master`, `voice_master`, and `final_redub`. Validate the video and each audio stem before mixing. The manifest needs original/override hashes, source and output hashes, voice provider/model/voice/parameters/take, ASR result, loudness/peak, `ffprobe`, and `ffmpeg -xerror` decode status.

For Chinese dialogue, synthesize the whole dialogue as one take whenever the provider supports it. If a provider requires segments, bind every segment to the same voice and parameter set and retain segment input/output hashes. MMX is validated in this workflow as the preferred backend. CosyVoice is an adapter candidate only: install and test it locally before use, and never package weights or claim it is verified.
