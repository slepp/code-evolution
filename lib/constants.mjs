export const SCHEMA_VERSION = '2.2';
export const DEFAULT_COUNTER_TOOL = 'scc';

// Exclude directories for code counting (common build/dependency folders)
export const EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'pkg',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'vendor'
];

// Audio sonification constants (used for pre-computing audio data)
export const AUDIO_MAX_VOICES = 16; // Max languages with audio
export const AUDIO_DETUNE_MAX = 25; // Max pitch variation in cents (+/- 25)
