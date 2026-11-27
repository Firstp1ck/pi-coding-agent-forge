import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// An original pad and plucked melody, with no sampled or downloaded recordings.
const story = JSON.parse(readFileSync(new URL('storyboard.json', import.meta.url), 'utf8'));
const duration = story.steps.reduce((sum, step) => sum + step.duration, 0);
const rate = 48000;
const frames = Math.round(duration * rate);
const pcm = Buffer.alloc(frames * 4);
const chords = [[50, 57, 62, 66], [47, 54, 59, 62], [43, 50, 55, 59], [45, 52, 57, 61]];
const melody = [74, 69, 66, 69, 71, 66, 62, 66, 67, 62, 59, 62, 69, 64, 61, 64];
const hz = (note) => 440 * 2 ** ((note - 69) / 12);
const tau = Math.PI * 2;
for (let i = 0; i < frames; i++) {
  const t = i / rate;
  const phrase = Math.floor(t / 8);
  const local = t % 8;
  const padEnvelope = Math.min(1, local / 0.8, (8 - local) / 1.3);
  const chord = chords[phrase % chords.length];
  const pad = chord.reduce((sum, note) => sum + Math.sin(tau * hz(note) * t), 0) * 0.022 * padEnvelope;
  const beat = Math.floor(t / 0.5);
  const age = t % 0.5;
  const attack = Math.min(1, age / 0.012);
  const pluck = Math.sin(tau * hz(melody[beat % melody.length]) * age) * Math.exp(-age * 9) * attack * 0.065;
  const fade = Math.min(1, t / 1.2, (duration - t) / 2.5);
  for (let channel = 0; channel < 2; channel++) {
    const pan = channel === beat % 2 ? 1 : 0.75;
    const sample = Math.max(-1, Math.min(1, (pad + pluck * pan) * fade));
    pcm.writeInt16LE(Math.round(sample * 32767), i * 4 + channel * 2);
  }
}
const header = Buffer.alloc(44);
header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const output = process.argv[2] || fileURLToPath(new URL('score.wav', import.meta.url));
writeFileSync(output, Buffer.concat([header, pcm]));
console.log(`score: ${output} (${duration}s, original stereo PCM)`);
