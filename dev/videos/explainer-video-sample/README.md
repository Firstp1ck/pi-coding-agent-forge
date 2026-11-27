# Stockroom sample walkthrough

A 64-second walkthrough of a fictional app. Find Sample box with quantity 4, change it to 6 and inspect the saved result. The example demonstrates the explainer-video skill's section cards, fixed two-line captions, guided motion, dialog clearance, soundtrack assembly and chapters.

- [Play the finished MP4](stockroom.mp4)
- [Contact sheet decoded from the delivery](sheet.png)
- [Copy-ready description](youtube-description.txt)
- [Layout check results](layout.json)
- [Encoded media verification](media-checks.json)
- [Episode brief](episode-brief.md)
- [Editable storyboard](../../../pi-skill-explainer-video/skills/explainer-video/examples/stockroom/storyboard.json)
- [Scene source](../../../pi-skill-explainer-video/skills/explainer-video/examples/stockroom/scenes.html)
- [Original soundtrack source](../../../pi-skill-explainer-video/skills/explainer-video/examples/stockroom/score.mjs)
- [Skill user guide](../../../pi-skill-explainer-video/README.md)

At 0:26 the chapter card introduces the edit. At 0:40 the input changes from 4 to 6. At 0:50 the saved result appears. The closing starts at 0:56 and fades to black. All records and screens are invented. The original music, Small steps, is synthesized locally without sampled recordings.

Rebuild from anywhere with `bash /path/to/repository/dev/videos/explainer-video-sample/render.sh`. It needs Node 22+, Chromium, FFmpeg and ffprobe. The script uses `t3-build` when installed. The visual master, generated PCM soundtrack and working stills remain local; the finished MP4, contact sheet and sources are retained for review.
