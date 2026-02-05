import { AUDIO_MAX_VOICES, AUDIO_DETUNE_MAX } from './constants.mjs';

/**
 * Compute pre-baked audio data for all commits and all metrics.
 * This moves audio state calculation from browser runtime to build time.
 */
export function computeAudioData(results, allLanguages) {
  if (results.length === 0) return [];

  const metrics = ['lines', 'files', 'bytes'];
  const metricKeys = { lines: 'code', files: 'files', bytes: 'bytes' };

  const minMax = {};
  for (const metric of metrics) {
    let min = Infinity;
    let max = 0;
    for (const commit of results) {
      let total = 0;
      for (const lang in commit.languages) {
        total += commit.languages[lang][metricKeys[metric]] || 0;
      }
      min = Math.min(min, total);
      max = Math.max(max, total);
    }
    minMax[metric] = { min, max };
  }

  const audioData = [];
  const maxVoices = Math.min(allLanguages.length, AUDIO_MAX_VOICES);

  for (let i = 0; i < results.length; i++) {
    const commit = results[i];
    const prevCommit = i > 0 ? results[i - 1] : null;

    const frameData = {};

    for (const metric of metrics) {
      const key = metricKeys[metric];
      const { min, max } = minMax[metric];

      let total = 0;
      for (const lang in commit.languages) {
        total += commit.languages[lang][key] || 0;
      }

      const masterIntensity = max > min
        ? Math.round(((total - min) / (max - min)) * 100) / 100
        : 1;

      const activeVoices = [];

      for (let v = 0; v < maxVoices; v++) {
        const lang = allLanguages[v];
        const value = commit.languages[lang]?.[key] || 0;
        const prevValue = prevCommit?.languages[lang]?.[key] || 0;

        const gain = total > 0 ? value / total : 0;
        if (gain === 0) continue;

        let detune = 0;
        if (prevCommit && prevValue > 0) {
          const growthRate = (value - prevValue) / prevValue;
          detune = Math.max(-AUDIO_DETUNE_MAX, Math.min(AUDIO_DETUNE_MAX, growthRate * AUDIO_DETUNE_MAX));
        } else if (value > 0 && prevValue === 0) {
          detune = AUDIO_DETUNE_MAX * 0.5;
        }

        activeVoices.push([v, Math.round(gain * 100) / 100, Math.round(detune * 10) / 10]);
      }

      frameData[metric] = [masterIntensity, ...activeVoices];
    }

    audioData.push(frameData);
  }

  return audioData;
}
