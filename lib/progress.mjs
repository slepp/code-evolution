export function createProgressEmitter(enabled) {
  return function emitProgress(stage, progress, message, data = {}) {
    if (!enabled) return;

    const event = {
      type: 'progress',
      stage,
      progress: Math.min(100, Math.max(0, progress)),
      message,
      timestamp: new Date().toISOString(),
      ...data
    };

    console.error(JSON.stringify(event));
  };
}
