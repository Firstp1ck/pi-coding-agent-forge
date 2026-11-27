# YouTube walkthroughs

**Title and thumbnail.** Start with the product name and the capability the episode demonstrates. For a technical tool, use its native palette and typography, a short readable title, and one authentic UI detail. The sample item can appear in the selected row. Leave the lower-right corner clear for the playback duration. Export a 16:9 PNG and inspect it at both 320 and 160 pixels wide. The product and topic should still read at a glance.

**Music and timing.** Use original or appropriately licensed music that suits the project. Work out the track's pulse, phrase lengths and instrument sounds before scoring picture changes. Build the rhythm from that palette. A soft plucked track, for example, can carry its beat in a muted variation of the same instrument. Mark a few visual cues and choose the musical beats closest to them. Let a cut fall between beats when the phrase sounds better that way. Ease the arrangement during reading holds and let it resolve over the credits. Audition a whole phrase, first with the picture hidden and then with it playing. Decoded onset times can verify sync; judging the groove takes listening.

**Credits and description.** Credit the actual contributors or project and the music as appropriate. Use one introductory paragraph explaining what viewers will learn. Add plain-text timestamps and descriptive chapter titles, starting at 00:00. Get times from the final export after the intro and credits have been edited. A brief intro or end credit can share a chapter with the adjacent task.

**Assembly.** Keep the visual master and the delivery output at different paths. For a visual master with embedded chapters and a finished AAC soundtrack of matching length:

```bash
ffmpeg -i visual.mp4 -i score.m4a -map 0:v:0 -map 1:a:0 -map_chapters 0 -c copy -movflags +faststart youtube.mp4
ffprobe -v error -show_streams -show_chapters -show_format youtube.mp4
```

If the visual master has no embedded chapters, use the rendered shot times to write the description. To embed chapters, author FFmetadata chapter entries from the same timeline and map that metadata input's chapters when muxing. Check loudness, peaks, fade, stream lengths and chapter boundaries in the finished file. Hand over the MP4, thumbnail and copy-ready description together.
