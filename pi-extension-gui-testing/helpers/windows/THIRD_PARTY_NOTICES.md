# Third-party notices: Windows helper

The Windows helper adapts design ideas from the following package. No source
file was copied; the ideas were reimplemented in C#. The files that use them
say so in their header comments (`src/win/WinSecurity.cs`, `src/win/WinJob.cs`,
`src/win/WinDesktop.cs`, `src/win/WinFiles.cs`).

## @iiwate/pi-silent-gui 0.2.0

Adopted ideas: a private desktop with a name the caller cannot choose;
suspended start with atomic Job Object membership through
`PROC_THREAD_ATTRIBUTE_JOB_LIST` and a kill-on-close job; refusing a
non-atomic fallback; a non-elevated relaunch with the Explorer shell token;
kill and audit only by registered job and PID + creation time; click routing
by `WM_NCHITTEST` (client hits to the deepest visible child with
`SendMessageTimeoutW`, non-client hits posted with `PostMessageW`, `HTCLOSE`
as `SC_CLOSE`); per-thread DPI awareness scoped to one operation;
`PrintWindow(PW_RENDERFULLCONTENT)` captures with an all-black flag; deletion
that holds directory handles and refuses reparse points.

```text
MIT License

Copyright (c) 2026 IIwate

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
